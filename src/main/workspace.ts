import { dialog, ipcMain, BrowserWindow, type WebContents } from 'electron'
import { promises as fs } from 'fs'
import { basename, join, normalize, relative, sep } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  IpcChannel,
  type FileNode,
  type FsChange,
  type FsChangeKind,
  type FsEventBatch,
  type OpenFolderResult,
  type ReadDirRequest,
  type ReadFileRequest,
  type ReadFileResult,
  type WriteFileRequest,
  type WriteFileResult
} from '../shared/ipc'

// 初期 ignore 対象のディレクトリ名（spec 4.2 / 5.6）。
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage'
])

// テキストとして開くファイルの上限サイズ（バイト）。これを超えるものは binary 扱い。
const MAX_TEXT_FILE_SIZE = 5 * 1024 * 1024

// 現在開いている project root の絶対パス。未選択なら null。
let projectRoot: string | null = null

// 現在稼働中の file watcher。フォルダ未選択／再オープン前は null。
let watcher: FSWatcher | null = null

// 変更通知の debounce 用バッファとタイマー（spec 2.2.5 の near real-time）。
const FS_EVENT_DEBOUNCE_MS = 150
let pendingChanges: FsChange[] = []
let flushTimer: NodeJS.Timeout | null = null
// 変更通知の送信先 renderer。openFolder を実行した webContents を使う。
let watchTarget: WebContents | null = null

// 絶対パスを project root 相対・'/' 区切りに正規化する。
function toRelPath(absPath: string): string {
  if (projectRoot === null) return absPath
  return relative(projectRoot, absPath).split(sep).join('/')
}

// バッファ済みの変更をまとめて renderer に送る。
function flushChanges(): void {
  flushTimer = null
  if (pendingChanges.length === 0) return
  const batch: FsEventBatch = { changes: pendingChanges }
  pendingChanges = []
  if (watchTarget && !watchTarget.isDestroyed()) {
    watchTarget.send(IpcChannel.FsEvent, batch)
  }
}

// 1 件の変更をバッファに積み、debounce して flush する。
function enqueueChange(kind: FsChangeKind, absPath: string): void {
  pendingChanges.push({ kind, relPath: toRelPath(absPath) })
  if (flushTimer === null) {
    flushTimer = setTimeout(flushChanges, FS_EVENT_DEBOUNCE_MS)
  }
}

// project root の監視を開始する。既存 watcher があれば閉じてから張り替える。
async function startWatching(root: string, target: WebContents): Promise<void> {
  await stopWatching()
  watchTarget = target
  watcher = chokidar.watch(root, {
    // 初期スキャンの add イベントは不要（ツリーは readDir で取得済み）。
    ignoreInitial: true,
    // ignore 対象ディレクトリはパスセグメント単位で除外する。
    ignored: (p: string) => p.split(sep).some((seg) => IGNORED_DIRS.has(seg)),
    // 保存途中の中間状態を読まないよう、書き込み完了を待ってから通知する。
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  })
  watcher
    .on('add', (p) => enqueueChange('add', p))
    .on('change', (p) => enqueueChange('change', p))
    .on('unlink', (p) => enqueueChange('unlink', p))
    .on('addDir', (p) => enqueueChange('addDir', p))
    .on('unlinkDir', (p) => enqueueChange('unlinkDir', p))
}

// 監視を停止し、保留中の通知も破棄する。
async function stopWatching(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingChanges = []
  watchTarget = null
  if (watcher) {
    const w = watcher
    watcher = null
    await w.close()
  }
}

// relPath（project root からの相対パス）を絶対パスに解決する。
// project root 外へのアクセスは拒否する（spec 2.3.3 / 6.3）。
function resolveWithinRoot(relPath: string): string {
  if (projectRoot === null) {
    throw new Error('フォルダが開かれていません')
  }
  // 先頭の '/' を除去し、normalize した上で root と結合する。
  const cleaned = normalize(relPath).replace(/^[/\\]+/, '')
  const abs = normalize(join(projectRoot, cleaned))
  const rel = relative(projectRoot, abs)
  // rel が '..' で始まる、または絶対パスになる場合は root 外。
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`project root 外へのアクセスは許可されていません: ${relPath}`)
  }
  return abs
}

// Open Folder ダイアログを表示し、選択された root を記憶する。
async function handleOpenFolder(
  e: Electron.IpcMainInvokeEvent
): Promise<OpenFolderResult | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  const root = result.filePaths[0]
  projectRoot = root
  // 新しい root の監視を開始する（前の root の watcher は張り替えで閉じる）。
  await startWatching(root, e.sender)
  return { root, name: basename(root) }
}

// 指定ディレクトリの直下のエントリを返す（遅延展開のため 1 階層のみ）。
// ディレクトリを先・名前順でソートして返す。
async function handleReadDir(_e: unknown, req: ReadDirRequest): Promise<FileNode[]> {
  const absDir = resolveWithinRoot(req.relPath)
  const entries = await fs.readdir(absDir, { withFileTypes: true })

  const nodes: FileNode[] = []
  for (const entry of entries) {
    const isDirectory = entry.isDirectory()
    // ignore 対象のディレクトリは除外する。
    if (isDirectory && IGNORED_DIRS.has(entry.name)) continue
    // symlink は MVP では辿らず、リンク自体をファイル扱いで表示する。
    const childRel = req.relPath ? `${req.relPath}/${entry.name}` : entry.name
    nodes.push({ relPath: childRel, name: entry.name, isDirectory })
  }

  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

// ファイル内容をテキストとして読み込む。binary / 巨大ファイルは isBinary=true で返す。
async function handleReadFile(_e: unknown, req: ReadFileRequest): Promise<ReadFileResult> {
  const abs = resolveWithinRoot(req.relPath)
  const stat = await fs.stat(abs)
  if (!stat.isFile()) {
    throw new Error(`ファイルではありません: ${req.relPath}`)
  }
  if (stat.size > MAX_TEXT_FILE_SIZE) {
    return { relPath: req.relPath, content: '', isBinary: true }
  }
  const buf = await fs.readFile(abs)
  // NUL バイトを含む場合はバイナリとみなす（簡易判定）。
  if (buf.includes(0)) {
    return { relPath: req.relPath, content: '', isBinary: true }
  }
  return { relPath: req.relPath, content: buf.toString('utf8'), isBinary: false }
}

// ファイル内容を UTF-8 テキストとして書き込む。project root 外は resolveWithinRoot で拒否する。
// 既存パスがディレクトリの場合は拒否する（新規ファイル作成は許可する）。
async function handleWriteFile(_e: unknown, req: WriteFileRequest): Promise<WriteFileResult> {
  const abs = resolveWithinRoot(req.relPath)
  try {
    const stat = await fs.stat(abs)
    if (stat.isDirectory()) {
      throw new Error(`ディレクトリには書き込めません: ${req.relPath}`)
    }
  } catch (err) {
    // ENOENT（未存在）は新規作成として許可する。それ以外は再送出する。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
  await fs.writeFile(abs, req.content, 'utf8')
  return { relPath: req.relPath }
}

// workspace 関連の IPC ハンドラを登録する。app 起動後に 1 度だけ呼ぶ。
export function registerWorkspaceHandlers(): void {
  ipcMain.handle(IpcChannel.OpenFolder, handleOpenFolder)
  ipcMain.handle(IpcChannel.ReadDir, handleReadDir)
  ipcMain.handle(IpcChannel.ReadFile, handleReadFile)
  ipcMain.handle(IpcChannel.WriteFile, handleWriteFile)
}

// アプリ終了時などに watcher を後始末する。
export async function disposeWorkspace(): Promise<void> {
  await stopWatching()
}
