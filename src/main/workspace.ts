import { clipboard, dialog, ipcMain, shell, protocol, BrowserWindow, type WebContents } from 'electron'
import { promises as fs, type Dirent } from 'fs'
import { basename, extname, join, normalize, relative, sep } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  IpcChannel,
  MEDIA_SCHEME,
  DEFAULT_WATCH_IGNORED_DIRS,
  type FileNode,
  type FsChange,
  type FsChangeKind,
  type FsEventBatch,
  type WatchStatus,
  type OpenFolderByPathRequest,
  type OpenFolderResult,
  type ReadDirRequest,
  type ReadFileRequest,
  type ReadFileResult,
  type WriteFileRequest,
  type WriteFileResult,
  type SearchRequest,
  type SearchMatch,
  type SearchFileResult,
  type SearchResult,
  type OpenPathRequest,
  type RenamePathRequest,
  type RenamePathResult,
  type DeletePathRequest,
  type DeletePathResult,
  type RevealPathRequest,
  type CopyPathRequest,
  type AddRecentFileRequest,
  type RemoveRecentFileRequest,
  type AddBookmarkRequest,
  type RemoveBookmarkRequest
} from '../shared/ipc'
import { addRecentFolder, loadRecentFolders, removeRecentFolder } from './settings'
import {
  addRecentFile,
  getRecentFiles,
  removeRecentFile,
  setRecentFiles
} from './recent-files'
import {
  addBookmark,
  getBookmarks,
  removeBookmark,
  setBookmarks
} from './bookmarks'
import { startGitWatching, stopGitWatching } from './git'
import { isCloudSyncedPath, startCloudPolling, type CloudPoller } from './cloud-poller'

// 初期 ignore 対象のディレクトリ名（spec 4.2 / 5.6）。ファイルツリー表示から隠す。
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage'
])

// ファイル監視（chokidar）から除外するディレクトリ名の集合。設定画面で編集でき、
// 起動時と設定変更時に applyWatchIgnoredDirs() で更新される。初期値は共有定数。
// chokidar v4 以降は fsevents を使わず fs.watch(kqueue) で監視するため、macOS では
// 「監視対象のファイル 1 つにつき fd を 1 つ」開く。.venv や各種キャッシュのように
// 大量のファイルを含む生成物ディレクトリを監視すると fd が数千〜万単位で消費され、
// プロセスの fd 上限（Electron では概ね 1 万強）に達する。そうなると新しいターミナルの
// forkpty が pty 用の fd を確保できず、シェルが tty を初期化できずに即 exit(0)（無出力）
// してしまう＝「[プロセスが終了しました (code 0)]」の即時表示。
// これらは編集対象ではなく監視する価値がないため、監視だけ止める（ツリー表示には残す）。
let watchIgnoredDirs = new Set<string>(DEFAULT_WATCH_IGNORED_DIRS)

// 全タブ合計で監視してよい対象数（ファイル + フォルダ）の上限。
// macOS + chokidar(kqueue) では監視対象 1 つ = fd 1 つで、プロセスの fd 上限は約 1 万。
// 除外リストはフォルダ名の網羅に限界がある（Unity の Library、独自キャッシュ等）ため、
// 事前スキャンで対象数を数え、この予算を超えるフォルダは監視自体を諦めてターミナルを守る。
const MAX_WATCHED_ENTRIES = 8000

// 監視除外フォルダ名を更新し、開いている全タブの watcher を新しい設定で貼り直す。
// 起動時（設定読み込み後）と、設定画面での保存時に呼ぶ。
export async function applyWatchIgnoredDirs(dirs: string[]): Promise<void> {
  watchIgnoredDirs = new Set(dirs)
  // 稼働中の watcher があれば、同じ root で貼り直して新しい除外設定を反映する。
  // snapshot を取ってから回す（startWatching が watchByWcId を書き換えるため）。
  // 逐次で回す: 並行に走らせると各タブが監視予算（MAX_WATCHED_ENTRIES）の残量を
  // 互いの更新前の値で計算してしまい、合計が予算を超え得るため。
  const active = [...watchByWcId.values()].map((s) => ({ root: s.root, target: s.target }))
  for (const { root, target } of active) {
    await startWatching(root, target)
  }
}

// root 配下の監視対象数（ファイル + フォルダ）を数える。watcher と同じ除外
// （watchIgnoredDirs のフォルダ名一致）を適用する。budget を超えたらそれ以上は
// 数えずに打ち切る（巨大フォルダでスキャン自体が長引かないように）。
async function countWatchTargets(root: string, budget: number): Promise<number> {
  let count = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // 読めないディレクトリ（権限など）は数えない。
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (watchIgnoredDirs.has(entry.name)) continue
        count++
        stack.push(join(dir, entry.name))
      } else if (entry.isFile()) {
        count++
      }
      if (count > budget) return count
    }
  }
  return count
}

// テキストとして開くファイルの上限サイズ（バイト）。これを超えるものは binary 扱い。
const MAX_TEXT_FILE_SIZE = 5 * 1024 * 1024

// タブ（webContents）単位の file 監視状態。各タブが別 project root を開けるため、
// root・watcher・通知バッファをすべて webContents.id でキーした Map で管理する。
interface WatchState {
  // 監視中の project root（絶対パス）。
  root: string
  // 変更通知の送信先 renderer（このタブ）。
  target: WebContents
  // 稼働中の file watcher。張り替え中・非開始時・上限超過で停止中は null。
  watcher: FSWatcher | null
  // このタブが消費している監視対象数（事前スキャンの結果）。全タブ合計の予算管理に使う。
  watchedCount: number
  // クラウド同期フォルダ（Dropbox 等）用の定期スキャン。通常フォルダでは null。
  // File Provider 経由の同期変更は fs.watch に載らないことがあるため、その補完として使う。
  poller: CloudPoller | null
  // watcher が直近に通知したパス（絶対パス → 時刻）。poller が同じ変更を二重通知しないための抑制用。
  recentWatcherEvents: Map<string, number>
  // debounce 用バッファとタイマー（spec 2.2.5 の near real-time）。
  pending: FsChange[]
  flushTimer: NodeJS.Timeout | null
}

const FS_EVENT_DEBOUNCE_MS = 150
// watcher が通知したパスを poller の重複抑制に使う期間。poller の最長スキャン間隔より長めにとる。
const WATCHER_EVENT_SUPPRESS_MS = 15000

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

// chokidar からの変更を積む。poller との重複抑制のため、通知したパスと時刻を記録する。
function enqueueWatcherChange(wcId: number, kind: FsChangeKind, absPath: string): void {
  const state = watchByWcId.get(wcId)
  if (!state) return
  state.recentWatcherEvents.set(absPath, Date.now())
  enqueueChange(wcId, kind, absPath)
}

// poller からの変更を積む。watcher が直近に同じパスを通知済みなら二重通知しない。
function enqueuePolledChange(wcId: number, kind: FsChangeKind, absPath: string): void {
  const state = watchByWcId.get(wcId)
  if (!state) return
  const now = Date.now()
  for (const [p, t] of state.recentWatcherEvents) {
    if (now - t > WATCHER_EVENT_SUPPRESS_MS) state.recentWatcherEvents.delete(p)
  }
  if (state.recentWatcherEvents.has(absPath)) return
  enqueueChange(wcId, kind, absPath)
}

// クラウド同期フォルダなら定期スキャンを開始する。
function startPollerIfCloud(wcId: number, state: WatchState): void {
  if (!isCloudSyncedPath(state.root)) return
  state.poller = startCloudPolling(
    state.root,
    (name) => watchIgnoredDirs.has(name),
    (kind, abs) => enqueuePolledChange(wcId, kind, abs)
  )
}

// file watcher の稼働状態を該当タブの renderer に通知する（監視停止バナーの表示・解除用）。
function sendWatchStatus(target: WebContents, status: WatchStatus): void {
  if (!target.isDestroyed()) {
    target.send(IpcChannel.WatchStatus, status)
  }
}

// 指定タブの project root の監視を開始する。既存 watcher があれば閉じてから張り替える。
// 監視対象数を事前に数え、全タブ合計の予算（MAX_WATCHED_ENTRIES）を超える場合は
// 監視せずに renderer へ通知する（fd 枯渇でターミナルが起動できなくなる方が致命的なため）。
async function startWatching(root: string, target: WebContents): Promise<void> {
  const wcId = target.id
  await stopWatching(wcId)
  const state: WatchState = {
    root,
    target,
    watcher: null,
    watchedCount: 0,
    poller: null,
    recentWatcherEvents: new Map(),
    pending: [],
    flushTimer: null
  }
  watchByWcId.set(wcId, state)

  // 他タブが消費している分を差し引いた、このタブに使える監視予算。
  const used = [...watchByWcId.values()].reduce(
    (sum, s) => (s === state ? sum : sum + s.watchedCount),
    0
  )
  const budget = Math.max(0, MAX_WATCHED_ENTRIES - used)
  const entryCount = await countWatchTargets(root, budget)
  if (entryCount > budget) {
    // 監視は諦める（ツリー・編集・ターミナルは通常どおり）。.git の監視は対象数が
    // 小さく Git status の追従に必要なため続ける。renderer はバナーで停止を知らせる。
    sendWatchStatus(target, { watching: false, entryCount, limit: budget })
    // クラウド同期フォルダなら、イベント監視を諦めても定期スキャンで変更は追従する。
    startPollerIfCloud(wcId, state)
    await startGitWatching(root, target)
    return
  }
  state.watchedCount = entryCount
  sendWatchStatus(target, { watching: true, entryCount, limit: budget })

  state.watcher = chokidar.watch(root, {
    // 初期スキャンの add イベントは不要（ツリーは readDir で取得済み）。
    ignoreInitial: true,
    // 監視除外ディレクトリはパスセグメント単位で除外する。.venv 等の大量ファイルを
    // 監視すると fd を使い切り、ターミナルが起動できなくなるため広めに除外する（設定で編集可）。
    ignored: (p: string) => p.split(sep).some((seg) => watchIgnoredDirs.has(seg)),
    // 保存途中の中間状態を読まないよう、書き込み完了を待ってから通知する。
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  })
  state.watcher
    .on('add', (p) => enqueueWatcherChange(wcId, 'add', p))
    .on('change', (p) => enqueueWatcherChange(wcId, 'change', p))
    .on('unlink', (p) => enqueueWatcherChange(wcId, 'unlink', p))
    .on('addDir', (p) => enqueueWatcherChange(wcId, 'addDir', p))
    .on('unlinkDir', (p) => enqueueWatcherChange(wcId, 'unlinkDir', p))
  // Dropbox 等の同期フォルダでは fs.watch が同期経由の変更を取りこぼすため定期スキャンを併用する。
  startPollerIfCloud(wcId, state)
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
  if (state.poller) {
    state.poller.stop()
    state.poller = null
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

// 最近開いたファイル（現在の project root 内）の一覧を返す。
// ディスク上に無くなったファイルはこの時点で除外し、永続データも掃除する（自動管理）。
async function handleGetRecentFiles(e: Electron.IpcMainInvokeEvent): Promise<string[]> {
  const root = getProjectRoot(e.sender.id)
  if (!root) return []
  const list = await getRecentFiles(root)
  const surviving: string[] = []
  for (const relPath of list) {
    try {
      await fs.stat(join(root, relPath))
      surviving.push(relPath)
    } catch {
      // 削除・リネーム済みのファイルは一覧から落とす。
    }
  }
  if (surviving.length !== list.length) {
    return setRecentFiles(root, surviving)
  }
  return list
}

// 最近開いたファイルに relPath を記録し、更新後の一覧を返す。root 未選択なら記録しない。
async function handleAddRecentFile(
  e: Electron.IpcMainInvokeEvent,
  req: AddRecentFileRequest
): Promise<string[]> {
  const root = getProjectRoot(e.sender.id)
  if (!root) return []
  return addRecentFile(root, req.relPath)
}

// 最近開いたファイルから relPath を除外し、更新後の一覧を返す。
async function handleRemoveRecentFile(
  e: Electron.IpcMainInvokeEvent,
  req: RemoveRecentFileRequest
): Promise<string[]> {
  const root = getProjectRoot(e.sender.id)
  if (!root) return []
  return removeRecentFile(root, req.relPath)
}

// ブックマーク（現在の project root 内）の一覧を返す。
// ディスク上に無くなったファイルはこの時点で除外し、永続データも掃除する（自動管理）。
async function handleGetBookmarks(e: Electron.IpcMainInvokeEvent): Promise<string[]> {
  const root = getProjectRoot(e.sender.id)
  if (!root) return []
  const list = await getBookmarks(root)
  const surviving: string[] = []
  for (const relPath of list) {
    try {
      await fs.stat(join(root, relPath))
      surviving.push(relPath)
    } catch {
      // 削除・リネーム済みのファイルは一覧から落とす。
    }
  }
  if (surviving.length !== list.length) {
    return setBookmarks(root, surviving)
  }
  return list
}

// ブックマークに relPath を追加し、更新後の一覧を返す。root 未選択なら記録しない。
async function handleAddBookmark(
  e: Electron.IpcMainInvokeEvent,
  req: AddBookmarkRequest
): Promise<string[]> {
  const root = getProjectRoot(e.sender.id)
  if (!root) return []
  return addBookmark(root, req.relPath)
}

// ブックマークから relPath を除外し、更新後の一覧を返す。
async function handleRemoveBookmark(
  e: Electron.IpcMainInvokeEvent,
  req: RemoveBookmarkRequest
): Promise<string[]> {
  const root = getProjectRoot(e.sender.id)
  if (!root) return []
  return removeBookmark(root, req.relPath)
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

// ファイル横断検索の上限（暴走・過負荷の防止）。
// マッチ総数・走査ファイル数・1 ファイルあたりのマッチ数をそれぞれ制限する。
const SEARCH_MAX_TOTAL_MATCHES = 5000
const SEARCH_MAX_MATCHES_PER_FILE = 500
const SEARCH_MAX_FILES_SCANNED = 20000
// プレビュー行の最大長と、長い行でマッチの前に残す文脈の文字数。
const SEARCH_PREVIEW_MAX = 300
const SEARCH_PREVIEW_LEAD = 40

// 検索リクエストから正規表現を組み立てる。regex=false のときは特殊文字をエスケープして
// リテラル検索にする。wholeWord のときは \b で囲んで単語単位にする。無効な正規表現は例外。
function buildSearchRegex(req: SearchRequest): RegExp {
  const flags = req.caseSensitive ? 'g' : 'gi'
  let pattern = req.regex ? req.query : req.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (req.wholeWord) pattern = `\\b(?:${pattern})\\b`
  return new RegExp(pattern, flags)
}

// 1 行からマッチを収集する。remaining はこの行で許容する残りマッチ数。
// preview は長い行だとマッチ周辺だけ切り出す。previewColumn は切り詰め後のオフセット。
function collectLineMatches(
  line: string,
  re: RegExp,
  lineNo: number,
  remaining: number
): SearchMatch[] {
  const matches: SearchMatch[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const column = m.index + 1
    const length = m[0].length
    // 長い行はマッチ周辺だけを切り出してプレビューにする。
    let start = 0
    let lead = ''
    if (line.length > SEARCH_PREVIEW_MAX && m.index > SEARCH_PREVIEW_LEAD) {
      start = m.index - SEARCH_PREVIEW_LEAD
      lead = '…'
    }
    const preview = lead + line.slice(start, start + SEARCH_PREVIEW_MAX)
    const previewColumn = lead.length + (m.index - start)
    matches.push({ line: lineNo, column, length, preview, previewColumn })
    if (matches.length >= remaining) break
    // 長さ 0 のマッチ（例: a* が空にマッチ）で無限ループにならないよう前進させる。
    if (length === 0) re.lastIndex++
  }
  return matches
}

// project root 配下のテキストファイルを横断検索する（spec Phase 2 相当・VSCode の Ctrl+Shift+F）。
// ツリー非表示ディレクトリ（IGNORED_DIRS）と監視除外ディレクトリ（watchIgnoredDirs）を除外し、
// node_modules や .venv・.git などの大量ファイルは走査しない。バイナリ/巨大ファイルも除外する。
// fd 枯渇（terminal の即終了）を避けるため、ファイルは逐次で読む。
async function handleSearch(
  e: Electron.IpcMainInvokeEvent,
  req: SearchRequest
): Promise<SearchResult> {
  const root = getProjectRoot(e.sender.id)
  if (root === null || req.query.length === 0) {
    return { files: [], totalMatches: 0, truncated: false }
  }
  const base = root

  let re: RegExp
  try {
    re = buildSearchRegex(req)
  } catch {
    // 無効な正規表現。空結果で返す（renderer 側でも事前検証してメッセージを出す）。
    return { files: [], totalMatches: 0, truncated: false }
  }

  const files: SearchFileResult[] = []
  let totalMatches = 0
  let filesScanned = 0
  let truncated = false

  // 1 ファイルを検索して結果を積む。
  const searchFile = async (relPath: string): Promise<void> => {
    const abs = join(base, relPath)
    let buf: Buffer
    try {
      const stat = await fs.stat(abs)
      if (!stat.isFile() || stat.size > MAX_TEXT_FILE_SIZE) return
      buf = await fs.readFile(abs)
    } catch {
      return
    }
    // NUL バイトを含む場合はバイナリとみなす（readFile と同じ簡易判定）。
    if (buf.includes(0)) return
    const lines = buf.toString('utf8').split('\n')
    const fileMatches: SearchMatch[] = []
    for (let i = 0; i < lines.length; i++) {
      // 行末の CR を落として列位置・表示を安定させる。
      const raw = lines[i]
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      const remaining = Math.min(
        SEARCH_MAX_MATCHES_PER_FILE - fileMatches.length,
        SEARCH_MAX_TOTAL_MATCHES - totalMatches
      )
      if (remaining <= 0) {
        truncated = true
        break
      }
      const found = collectLineMatches(line, re, i + 1, remaining)
      if (found.length > 0) {
        fileMatches.push(...found)
        totalMatches += found.length
      }
      if (totalMatches >= SEARCH_MAX_TOTAL_MATCHES) {
        truncated = true
        break
      }
    }
    if (fileMatches.length > 0) {
      files.push({ relPath, matches: fileMatches })
    }
  }

  // ルートから深さ優先で走査する。ツリーと同じくディレクトリ先・名前順で安定させる。
  const walk = async (relDir: string): Promise<void> => {
    if (truncated) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(join(base, relDir), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => {
      const ad = a.isDirectory()
      const bd = b.isDirectory()
      if (ad !== bd) return ad ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (truncated) return
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // 生成物・キャッシュ・.git などは検索対象から外す（非表示 + 監視除外の和集合）。
        if (IGNORED_DIRS.has(entry.name) || watchIgnoredDirs.has(entry.name)) continue
        await walk(childRel)
      } else if (entry.isFile()) {
        if (filesScanned >= SEARCH_MAX_FILES_SCANNED) {
          truncated = true
          return
        }
        filesScanned++
        await searchFile(childRel)
      }
    }
  }

  await walk('')
  return { files, totalMatches, truncated }
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
  ipcMain.handle(IpcChannel.GetRecentFiles, handleGetRecentFiles)
  ipcMain.handle(IpcChannel.AddRecentFile, handleAddRecentFile)
  ipcMain.handle(IpcChannel.RemoveRecentFile, handleRemoveRecentFile)
  ipcMain.handle(IpcChannel.GetBookmarks, handleGetBookmarks)
  ipcMain.handle(IpcChannel.AddBookmark, handleAddBookmark)
  ipcMain.handle(IpcChannel.RemoveBookmark, handleRemoveBookmark)
  ipcMain.handle(IpcChannel.ReadDir, handleReadDir)
  ipcMain.handle(IpcChannel.ReadFile, handleReadFile)
  ipcMain.handle(IpcChannel.WriteFile, handleWriteFile)
  ipcMain.handle(IpcChannel.SearchInFiles, handleSearch)
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
