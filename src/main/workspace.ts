import { clipboard, dialog, ipcMain, shell, protocol, BrowserWindow, type WebContents } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, join, normalize, relative, sep } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  IpcChannel,
  MEDIA_SCHEME,
  type FileNode,
  type FsChange,
  type FsChangeKind,
  type FsEventBatch,
  type OpenFolderByPathRequest,
  type OpenFolderResult,
  type ReadDirRequest,
  type ReadFileRequest,
  type ReadFileResult,
  type WriteFileRequest,
  type WriteFileResult,
  type OpenPathRequest,
  type RenamePathRequest,
  type RenamePathResult,
  type DeletePathRequest,
  type DeletePathResult,
  type RevealPathRequest,
  type CopyPathRequest
} from '../shared/ipc'
import { addRecentFolder, loadRecentFolders, removeRecentFolder } from './settings'
import { startGitWatching, stopGitWatching } from './git'

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

// タブ（webContents）単位の file 監視状態。各タブが別 project root を開けるため、
// root・watcher・通知バッファをすべて webContents.id でキーした Map で管理する。
interface WatchState {
  // 監視中の project root（絶対パス）。
  root: string
  // 変更通知の送信先 renderer（このタブ）。
  target: WebContents
  // 稼働中の file watcher。張り替え中・非開始時は null。
  watcher: FSWatcher | null
  // debounce 用バッファとタイマー（spec 2.2.5 の near real-time）。
  pending: FsChange[]
  flushTimer: NodeJS.Timeout | null
}

const FS_EVENT_DEBOUNCE_MS = 150

// webContents.id → 開いている project root（絶対パス）。
const rootByWcId = new Map<number, string>()
// webContents.id → file 監視状態。
const watchByWcId = new Map<number, WatchState>()
// destroyed リスナーを二重登録しないための記録。
const cleanupBound = new Set<number>()

// project root が変わったときの通知先（タブのタイトル更新に使う）。tabs.ts が登録する。
let rootChangedCb: ((wcId: number, root: string | null) => void) | null = null
export function setRootChangedListener(cb: (wcId: number, root: string | null) => void): void {
  rootChangedCb = cb
}

// メディアプロトコルが解決に使う root を返す getter。tabs.ts が「アクティブタブの root」を登録する。
// 媒体ハンドラは送信元 webContents を取れないため、表示中タブの root で解決する。
let activeRootResolver: (() => string | null) | null = null
export function setActiveRootResolver(fn: () => string | null): void {
  activeRootResolver = fn
}

// 絶対パスを root 相対・'/' 区切りに正規化する。
function toRelPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

// バッファ済みの変更をまとめて該当タブの renderer に送る。
function flushChanges(wcId: number): void {
  const state = watchByWcId.get(wcId)
  if (!state) return
  state.flushTimer = null
  if (state.pending.length === 0) return
  const batch: FsEventBatch = { changes: state.pending }
  state.pending = []
  if (!state.target.isDestroyed()) {
    state.target.send(IpcChannel.FsEvent, batch)
  }
}

// 1 件の変更をバッファに積み、debounce して flush する。
function enqueueChange(wcId: number, kind: FsChangeKind, absPath: string): void {
  const state = watchByWcId.get(wcId)
  if (!state) return
  state.pending.push({ kind, relPath: toRelPath(state.root, absPath) })
  if (state.flushTimer === null) {
    state.flushTimer = setTimeout(() => flushChanges(wcId), FS_EVENT_DEBOUNCE_MS)
  }
}

// 指定タブの project root の監視を開始する。既存 watcher があれば閉じてから張り替える。
async function startWatching(root: string, target: WebContents): Promise<void> {
  const wcId = target.id
  await stopWatching(wcId)
  const state: WatchState = { root, target, watcher: null, pending: [], flushTimer: null }
  watchByWcId.set(wcId, state)
  state.watcher = chokidar.watch(root, {
    // 初期スキャンの add イベントは不要（ツリーは readDir で取得済み）。
    ignoreInitial: true,
    // ignore 対象ディレクトリはパスセグメント単位で除外する。
    ignored: (p: string) => p.split(sep).some((seg) => IGNORED_DIRS.has(seg)),
    // 保存途中の中間状態を読まないよう、書き込み完了を待ってから通知する。
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  })
  state.watcher
    .on('add', (p) => enqueueChange(wcId, 'add', p))
    .on('change', (p) => enqueueChange(wcId, 'change', p))
    .on('unlink', (p) => enqueueChange(wcId, 'unlink', p))
    .on('addDir', (p) => enqueueChange(wcId, 'addDir', p))
    .on('unlinkDir', (p) => enqueueChange(wcId, 'unlinkDir', p))
  // .git（index/HEAD/refs）も監視し、ターミナルでの commit/add 等を Git status に反映する。
  await startGitWatching(root, target)
}

// 指定タブの監視を停止し、保留中の通知も破棄する。
async function stopWatching(wcId: number): Promise<void> {
  const state = watchByWcId.get(wcId)
  await stopGitWatching(wcId)
  if (!state) return
  watchByWcId.delete(wcId)
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer)
    state.flushTimer = null
  }
  if (state.watcher) {
    const w = state.watcher
    state.watcher = null
    await w.close()
  }
}

// 指定タブ（webContents）が破棄されたときの後始末。root と監視を解放する。
async function cleanupWebContents(wcId: number): Promise<void> {
  cleanupBound.delete(wcId)
  rootByWcId.delete(wcId)
  await stopWatching(wcId)
}

// relPath を root 配下の絶対パスに解決する。root 外は拒否する（spec 2.3.3 / 6.3）。
function resolveWithin(root: string, relPath: string): string {
  // 先頭の '/' を除去し、normalize した上で root と結合する。
  const cleaned = normalize(relPath).replace(/^[/\\]+/, '')
  const abs = normalize(join(root, cleaned))
  const rel = relative(root, abs)
  // rel が '..' で始まる、または絶対パスになる場合は root 外。
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`project root 外へのアクセスは許可されていません: ${relPath}`)
  }
  return abs
}

// 送信元タブの project root を基準に relPath を絶対パスへ解決する。
function resolveWithinRoot(wcId: number, relPath: string): string {
  const root = rootByWcId.get(wcId)
  if (root === undefined) {
    throw new Error('フォルダが開かれていません')
  }
  return resolveWithin(root, relPath)
}

// 指定した root を、送信元タブの project root として開く。
// watcher を張り替え、最近開いた一覧を更新する。存在しない／ディレクトリでなければ null。
async function openRoot(
  root: string,
  target: WebContents
): Promise<OpenFolderResult | null> {
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) {
      await removeRecentFolder(root)
      return null
    }
  } catch {
    // 削除・リネーム済みなど開けないフォルダは一覧から除外する。
    await removeRecentFolder(root)
    return null
  }
  rootByWcId.set(target.id, root)
  // 新しい root の監視を開始する（このタブの前の root の watcher は張り替えで閉じる）。
  await startWatching(root, target)
  await addRecentFolder(root)
  // タブのタイトルを更新する（renderer 改修なしで反映）。
  rootChangedCb?.(target.id, root)
  // タブ（webContents）の破棄時に root と監視を解放する。1 タブにつき 1 度だけ束ねる。
  if (!cleanupBound.has(target.id)) {
    cleanupBound.add(target.id)
    target.once('destroyed', () => {
      void cleanupWebContents(target.id)
    })
  }
  return { root, name: basename(root) }
}

// Open Folder ダイアログを表示し、選択された root を開く。
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
  return openRoot(result.filePaths[0], e.sender)
}

// 指定パス（最近開いた一覧・前回フォルダ）を直接開く。
async function handleOpenFolderByPath(
  e: Electron.IpcMainInvokeEvent,
  req: OpenFolderByPathRequest
): Promise<OpenFolderResult | null> {
  return openRoot(req.path, e.sender)
}

// 最近開いたフォルダの絶対パス一覧を返す（新しい順）。
async function handleGetRecentFolders(): Promise<string[]> {
  return loadRecentFolders()
}

// 指定ディレクトリの直下のエントリを返す（遅延展開のため 1 階層のみ）。
// ディレクトリを先・名前順でソートして返す。
async function handleReadDir(
  e: Electron.IpcMainInvokeEvent,
  req: ReadDirRequest
): Promise<FileNode[]> {
  const absDir = resolveWithinRoot(e.sender.id, req.relPath)
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
async function handleReadFile(
  e: Electron.IpcMainInvokeEvent,
  req: ReadFileRequest
): Promise<ReadFileResult> {
  const abs = resolveWithinRoot(e.sender.id, req.relPath)
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
async function handleWriteFile(
  e: Electron.IpcMainInvokeEvent,
  req: WriteFileRequest
): Promise<WriteFileResult> {
  const abs = resolveWithinRoot(e.sender.id, req.relPath)
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

// Markdown プレビューでの表示を許可する画像拡張子と対応する MIME タイプ。
// ここに無い拡張子は配信しない（カスタムスキーム経由の任意ファイル読み出しを防ぐ）。
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
}

// メディアリクエストの解決に使う project root を返す。
// 媒体プロトコルのハンドラは送信元 webContents を受け取れないため、
// 表示中（アクティブ）のタブの root で解決する（tabs.ts が resolver を登録する）。
// 全タブビューは同一 session を共有し URL に root を含めないため、別タブの同名
// パスとキャッシュが衝突しないよう、レスポンスは cache-control: no-store にする。
function getRootForMedia(): string | null {
  if (activeRootResolver) return activeRootResolver()
  // resolver 未登録時（タブ機構の起動前）の安全側フォールバック。
  if (rootByWcId.size === 1) return [...rootByWcId.values()][0]
  return null
}

// MEDIA_SCHEME のリクエストを処理し、project root 内の画像ファイルを返す。
// URL は mediaUrl() が生成する `noetelier-img://r/<encoded relPath>` 形式。
// project root 外・存在しない・非画像・フォルダ未選択はいずれもエラー応答にする。
async function handleMediaRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    // pathname は '/photos/foo.png' のような形。先頭 '/' を除いて relPath に戻す。
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!relPath) return new Response(null, { status: 404 })

    const root = getRootForMedia()
    if (root === null) return new Response(null, { status: 404 })
    // project root 外は resolveWithin が例外を投げる（catch で 404）。
    const abs = resolveWithin(root, relPath)
    const mime = IMAGE_MIME[extname(abs).toLowerCase()]
    // 許可した画像拡張子以外は配信しない。
    if (!mime) return new Response(null, { status: 415 })

    const stat = await fs.stat(abs)
    if (!stat.isFile()) return new Response(null, { status: 404 })

    const buf = await fs.readFile(abs)
    // 全タブが同一 session を共有するため、別タブの同名パスとキャッシュが衝突しないよう
    // キャッシュを無効化する（root は URL に含めず、アクティブタブで解決するため）。
    return new Response(buf, {
      headers: { 'content-type': mime, 'cache-control': 'no-store' }
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}

// 画像表示用カスタムスキームのハンドラを登録する。app ready 後に 1 度だけ呼ぶ。
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)
}

// 指定ファイルを OS の既定アプリ（関連付け）で開く。バイナリ/巨大ファイル用。
// project root 外は resolveWithinRoot が拒否する。ディレクトリは対象外。
// 戻り値は shell.openPath のエラーメッセージ（成功時は空文字）。
async function handleOpenPath(
  e: Electron.IpcMainInvokeEvent,
  req: OpenPathRequest
): Promise<string> {
  const abs = resolveWithinRoot(e.sender.id, req.relPath)
  const stat = await fs.stat(abs)
  if (!stat.isFile()) {
    return `ファイルではありません: ${req.relPath}`
  }
  return shell.openPath(abs)
}

// relPath の親ディレクトリ（root 相対・'/' 区切り。トップレベルは ''）。
function parentRelDir(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

// ファイル/フォルダを同階層でリネームする。新しい root 相対パスを返す。
// newName にパス区切りを含む（= 別階層への移動）場合は拒否する。
async function handleRenamePath(
  e: Electron.IpcMainInvokeEvent,
  req: RenamePathRequest
): Promise<RenamePathResult> {
  const newName = req.newName.trim()
  if (!newName || newName.includes('/') || newName.includes('\\')) {
    throw new Error(`不正な名前です: ${req.newName}`)
  }
  const abs = resolveWithinRoot(e.sender.id, req.relPath)
  const parent = parentRelDir(req.relPath)
  const newRel = parent ? `${parent}/${newName}` : newName
  const newAbs = resolveWithinRoot(e.sender.id, newRel)
  // 同名の項目が既にある場合は上書きせず拒否する。
  let exists = true
  try {
    await fs.access(newAbs)
  } catch {
    exists = false
  }
  if (exists) {
    throw new Error(`同名の項目が既に存在します: ${newName}`)
  }
  await fs.rename(abs, newAbs)
  return { relPath: newRel }
}

// ファイル/フォルダをゴミ箱へ移動する。実行前に確認ダイアログを出す（spec / Mac 固有の注意点）。
// shell.trashItem を使うため、ユーザーはゴミ箱から元に戻せる。
async function handleDeletePath(
  e: Electron.IpcMainInvokeEvent,
  req: DeletePathRequest
): Promise<DeletePathResult> {
  const abs = resolveWithinRoot(e.sender.id, req.relPath)
  const name = basename(abs)
  const win = BrowserWindow.fromWebContents(e.sender)
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['ゴミ箱に移動', 'キャンセル'],
    defaultId: 0,
    cancelId: 1,
    message: `「${name}」をゴミ箱に移動しますか？`,
    detail: 'ゴミ箱から元に戻せます。'
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response !== 0) {
    return { deleted: false }
  }
  await shell.trashItem(abs)
  return { deleted: true }
}

// Finder で項目を表示する（親フォルダを開いて当該項目を選択する）。
async function handleRevealPath(
  e: Electron.IpcMainInvokeEvent,
  req: RevealPathRequest
): Promise<void> {
  const abs = resolveWithinRoot(e.sender.id, req.relPath)
  shell.showItemInFolder(abs)
}

// 項目の絶対パスをクリップボードにコピーする。コピーしたパスを返す。
async function handleCopyPath(
  e: Electron.IpcMainInvokeEvent,
  req: CopyPathRequest
): Promise<string> {
  const abs = resolveWithinRoot(e.sender.id, req.relPath)
  clipboard.writeText(abs)
  return abs
}

// workspace 関連の IPC ハンドラを登録する。app 起動後に 1 度だけ呼ぶ。
export function registerWorkspaceHandlers(): void {
  ipcMain.handle(IpcChannel.OpenFolder, handleOpenFolder)
  ipcMain.handle(IpcChannel.OpenFolderByPath, handleOpenFolderByPath)
  ipcMain.handle(IpcChannel.GetRecentFolders, handleGetRecentFolders)
  ipcMain.handle(IpcChannel.ReadDir, handleReadDir)
  ipcMain.handle(IpcChannel.ReadFile, handleReadFile)
  ipcMain.handle(IpcChannel.WriteFile, handleWriteFile)
  ipcMain.handle(IpcChannel.OpenPath, handleOpenPath)
  ipcMain.handle(IpcChannel.RenamePath, handleRenamePath)
  ipcMain.handle(IpcChannel.DeletePath, handleDeletePath)
  ipcMain.handle(IpcChannel.RevealPath, handleRevealPath)
  ipcMain.handle(IpcChannel.CopyPath, handleCopyPath)
}

// アプリ終了時などに全タブの watcher を後始末する。
export async function disposeWorkspace(): Promise<void> {
  await Promise.all([...watchByWcId.keys()].map((wcId) => stopWatching(wcId)))
}

// 指定タブ（webContents）の project root（絶対パス）。未選択は null。ターミナルの cwd に使う。
export function getProjectRoot(wcId: number): string | null {
  return rootByWcId.get(wcId) ?? null
}
