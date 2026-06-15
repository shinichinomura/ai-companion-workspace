// main / preload / renderer で共有する IPC の型定義とチャンネル名。

// IPC チャンネル名。文字列のタイポを防ぐため定数化する。
export const IpcChannel = {
  OpenFolder: 'workspace:open-folder',
  // 指定パス（最近開いた一覧・前回フォルダ）を直接開く。
  OpenFolderByPath: 'workspace:open-folder-by-path',
  // 最近開いたフォルダの絶対パス一覧を取得する。
  GetRecentFolders: 'workspace:get-recent-folders',
  ReadDir: 'workspace:read-dir',
  ReadFile: 'workspace:read-file',
  WriteFile: 'workspace:write-file',
  // バイナリ/巨大ファイルを OS の既定アプリ（関連付け）で開く。
  OpenPath: 'workspace:open-path',
  // main → renderer への push。file watcher が検知した変更を通知する。
  FsEvent: 'workspace:fs-event',
  // R→M invoke: 現在の project root の Git status（追加/変更/削除）を取得する。
  GitStatus: 'workspace:git-status',
  // M→R push: .git（index/HEAD/refs）の変化を検知した。renderer は GitStatus を取り直す。
  GitStatusChanged: 'workspace:git-status-changed',

  // 表示メニュー（ネイティブアプリメニュー）と renderer の連携。
  // M→R push: メニューの「表示」でレイアウト切り替えが選ばれた。
  SetWorkLayout: 'view:set-work-layout',
  // R→M send: renderer の現在レイアウトを通知し、メニューのチェック状態を同期する。
  WorkLayoutChanged: 'view:work-layout-changed',
  // M→R push: 「表示」メニューで「. で始まるファイルを表示」が切り替えられた。
  SetShowHidden: 'view:set-show-hidden',
  // R→M send: renderer の現在の表示状態を通知し、メニューのチェック状態を同期する。
  ShowHiddenChanged: 'view:show-hidden-changed',
  // M→R push: 「ファイル」メニューの「フォルダを開く」が選ばれた。
  RequestOpenFolder: 'view:request-open-folder',

  // 統合ターミナル（spec 2.2.4）。MVP は単一インスタンス。
  TerminalStart: 'terminal:start', // R→M invoke: cwd(project root) で PTY 起動
  TerminalInput: 'terminal:input', // R→M send: キー入力を PTY に書き込む
  TerminalResize: 'terminal:resize', // R→M send: cols/rows 変更
  TerminalDispose: 'terminal:dispose', // R→M send: PTY 破棄
  TerminalData: 'terminal:data', // M→R push: PTY 出力
  TerminalExit: 'terminal:exit' // M→R push: プロセス終了通知
} as const

// Markdown プレビューで画像を表示するためのカスタムスキーム。
// renderer は img の src をこのスキームの URL に書き換え、main 側のハンドラが
// project root 内のファイルとして読み出して返す（project root 外・非画像は拒否）。
export const MEDIA_SCHEME = 'atelier-img'

// project root 相対パス（'/' 区切り）を MEDIA_SCHEME の URL に変換する。
// 各セグメントを encodeURIComponent し、空白や日本語を含むパスも安全に運ぶ。
// host は固定値 'r'（root の意）。main 側は pathname を decode して relPath に戻す。
export function mediaUrl(relPath: string): string {
  const encoded = relPath
    .split('/')
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join('/')
  return `${MEDIA_SCHEME}://r/${encoded}`
}

// Editor と Terminal の並べ方。'horizontal' = 左右, 'vertical' = 上下。
export type WorkLayout = 'horizontal' | 'vertical'

// ファイルツリーの 1 ノード。ディレクトリは遅延展開するため children は持たない。
export interface FileNode {
  // project root からの相対パス（'/' 区切り）。ルート自身は ''。
  relPath: string
  name: string
  isDirectory: boolean
}

// ファイル 1 件の Git status。3 状態に集約する（spec Phase 2）。
//   added    … 新規（untracked、または index へ add 済み）
//   modified … 変更
//   deleted  … 削除（ディスク上に無い。ツリーにはファントム行として復元表示する）
export type GitFileStatus = 'added' | 'modified' | 'deleted'

// Git status の取得結果。
export interface GitStatusResult {
  // project root が Git リポジトリ（配下）か。false ならマークは一切出さない。
  isRepo: boolean
  // project root 相対パス（'/' 区切り）→ status のマップ。変更の無いファイルは含まない。
  statuses: Record<string, GitFileStatus>
}

// Open Folder の結果。キャンセル時は null。
export interface OpenFolderResult {
  root: string // 選択されたフォルダの絶対パス
  name: string // 表示用のフォルダ名
}

// 指定パスを開くリクエスト。最近開いた一覧・前回フォルダの復元に使う。
export interface OpenFolderByPathRequest {
  path: string // 開くフォルダの絶対パス
}

// readDir / readFile のリクエスト。relPath は project root からの相対パス。
export interface ReadDirRequest {
  relPath: string
}

export interface ReadFileRequest {
  relPath: string
}

// readFile の結果。テキストとして読めない場合は isBinary=true。
export interface ReadFileResult {
  relPath: string
  content: string
  isBinary: boolean
}

// writeFile のリクエスト。relPath は project root からの相対パス、content は UTF-8 テキスト。
export interface WriteFileRequest {
  relPath: string
  content: string
}

// writeFile の結果。
export interface WriteFileResult {
  relPath: string
}

// openPath のリクエスト。relPath は project root からの相対パス。
export interface OpenPathRequest {
  relPath: string
}

// file watcher が検知した 1 件の変更。relPath は project root からの相対パス（'/' 区切り）。
export type FsChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

export interface FsChange {
  kind: FsChangeKind
  relPath: string
}

// debounce してまとめて push される変更バッチ。
export interface FsEventBatch {
  changes: FsChange[]
}

// terminal:start のリクエスト。初期サイズを渡す（FitAddon の測定結果）。
export interface TerminalStartRequest {
  cols: number
  rows: number
}

// terminal:start の結果。
export interface TerminalStartResult {
  // 起動できなかった場合（フォルダ未選択など）はエラーメッセージを返す。
  error?: string
}

// terminal:resize のリクエスト。
export interface TerminalResizeRequest {
  cols: number
  rows: number
}

// terminal:exit の通知。シェルプロセスの終了コード。
export interface TerminalExit {
  exitCode: number
}

// renderer に公開する API の型。preload で実装し window.api として参照する。
export interface WorkspaceApi {
  openFolder: () => Promise<OpenFolderResult | null>
  // 指定パスを開く。存在しない・ディレクトリでない場合は null。
  openFolderByPath: (req: OpenFolderByPathRequest) => Promise<OpenFolderResult | null>
  // 最近開いたフォルダの絶対パス一覧（新しい順）。
  getRecentFolders: () => Promise<string[]>
  readDir: (req: ReadDirRequest) => Promise<FileNode[]>
  readFile: (req: ReadFileRequest) => Promise<ReadFileResult>
  writeFile: (req: WriteFileRequest) => Promise<WriteFileResult>
  // バイナリ/巨大ファイルを OS の既定アプリで開く。戻り値は失敗時のエラーメッセージ（成功時は空文字）。
  openPath: (req: OpenPathRequest) => Promise<string>
  // file watcher の変更通知を購読する。返り値は購読解除関数。
  onFsEvent: (cb: (batch: FsEventBatch) => void) => () => void
  // 現在の project root の Git status を取得する。非リポジトリなら isRepo=false。
  getGitStatus: () => Promise<GitStatusResult>
  // .git の変化（commit / add / checkout 等）通知を購読する。返り値は購読解除関数。
  onGitStatusChanged: (cb: () => void) => () => void

  // 表示メニューからのレイアウト切り替えを購読する。返り値は購読解除関数。
  onSetWorkLayout: (cb: (layout: WorkLayout) => void) => () => void
  // 現在のレイアウトを main に通知し、メニューのチェック状態を同期する。
  reportWorkLayout: (layout: WorkLayout) => void
  // 「表示」メニューからの「. で始まるファイルを表示」切り替えを購読する。返り値は購読解除関数。
  onSetShowHidden: (cb: (show: boolean) => void) => () => void
  // 現在の表示状態を main に通知し、メニューのチェック状態を同期する。
  reportShowHidden: (show: boolean) => void
  // 「ファイル」メニューの「フォルダを開く」を購読する。返り値は購読解除関数。
  onRequestOpenFolder: (cb: () => void) => () => void

  // 統合ターミナル。project root を cwd に PTY を起動する。
  terminalStart: (req: TerminalStartRequest) => Promise<TerminalStartResult>
  terminalInput: (data: string) => void
  terminalResize: (req: TerminalResizeRequest) => void
  terminalDispose: () => void
  // PTY 出力を購読する。返り値は購読解除関数。
  onTerminalData: (cb: (data: string) => void) => () => void
  // プロセス終了を購読する。返り値は購読解除関数。
  onTerminalExit: (cb: (exit: TerminalExit) => void) => () => void
}
