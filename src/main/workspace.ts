import { dialog, ipcMain, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { basename, join, normalize, relative, sep } from 'path'
import {
  IpcChannel,
  type FileNode,
  type OpenFolderResult,
  type ReadDirRequest,
  type ReadFileRequest,
  type ReadFileResult
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
async function handleOpenFolder(): Promise<OpenFolderResult | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  const root = result.filePaths[0]
  projectRoot = root
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

// workspace 関連の IPC ハンドラを登録する。app 起動後に 1 度だけ呼ぶ。
export function registerWorkspaceHandlers(): void {
  ipcMain.handle(IpcChannel.OpenFolder, handleOpenFolder)
  ipcMain.handle(IpcChannel.ReadDir, handleReadDir)
  ipcMain.handle(IpcChannel.ReadFile, handleReadFile)
}
