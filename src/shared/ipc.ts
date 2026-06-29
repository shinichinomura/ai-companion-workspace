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
  // ファイル/フォルダをリネームする。
  RenamePath: 'workspace:rename-path',
  // ファイル/フォルダをゴミ箱へ移動する（main 側で確認ダイアログを出す）。
  DeletePath: 'workspace:delete-path',
  // Finder で項目を表示する（shell.showItemInFolder）。
  RevealPath: 'workspace:reveal-path',
  // 項目の絶対パスをクリップボードにコピーする。
  CopyPath: 'workspace:copy-path',
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
  // M→R push: 「ファイル」メニューの「フォルダを開く」が選ばれた。
  RequestOpenFolder: 'view:request-open-folder',
  // M→R push: 「最近使ったフォルダ」メニューの項目が選ばれた。renderer はそのパスを開く。
  RequestOpenFolderByPath: 'view:request-open-folder-by-path',
  // M→R push: アプリメニューの「設定…」が選ばれた。renderer は設定モーダルを開く。
  OpenSettings: 'view:open-settings',

  // アプリ設定（設定画面）。userData の app-settings.json に永続化する。
  SettingsGet: 'settings:get', // R→M invoke: 現在のアプリ設定を取得する
  SettingsSet: 'settings:set', // R→M invoke: アプリ設定を保存し、正規化後の値を返す

  // タブ（複数プロジェクトの同時オープン）。クロームシェル（タブバー）と main の連携。
  // M→shell push: タブ一覧とアクティブタブの最新状態。
  TabsState: 'tabs:state',
  // shell→M send: 現在のタブ状態を要求する（マウント直後の初期同期用）。
  TabsRequestState: 'tabs:request-state',
  // shell→M send: 新しいタブ（空）を作成する。
  TabNew: 'tabs:new',
  // shell→M send: 指定タブをアクティブにする。
  TabActivate: 'tabs:activate',
  // shell→M send: 指定タブを閉じる。
  TabClose: 'tabs:close',

  // 統合ターミナル（spec 2.2.4）。1 タブ（webContents）内に複数のターミナルをタブで持てる。
  // PTY は (webContents.id, terminalId) の組で一意に保持する。terminalId は各メッセージに含める。
  TerminalStart: 'terminal:start', // R→M invoke: cwd(project root) で PTY 起動
  TerminalInput: 'terminal:input', // R→M send: キー入力を PTY に書き込む
  TerminalResize: 'terminal:resize', // R→M send: cols/rows 変更
  TerminalDispose: 'terminal:dispose', // R→M send: PTY 破棄
  TerminalData: 'terminal:data', // M→R push: PTY 出力
  TerminalExit: 'terminal:exit', // M→R push: プロセス終了通知
  // R→M send: ターミナルでベル（\x07）が鳴った。main は非アクティブ時に OS 通知を出す。
  // claude CLI が操作待ち（入力・許可待ち）になると鳴らすベルを拾う用途。どのターミナルが
  // 鳴らしたかを id で示し、通知クリック時にそのターミナルへ復帰できるようにする。
  TerminalBell: 'terminal:bell',
  // M→R push: ベル通知のクリックで、該当ターミナル（サブタブ）をアクティブにするよう促す。
  TerminalActivate: 'terminal:activate',
  // R→M send: そのアプリタブで現在アクティブなターミナル（サブタブ）の id を報告する。
  // main は「今まさに見ているターミナルが鳴ったときだけ」通知を抑制するために使う。
  TerminalActiveChanged: 'terminal:active-changed'
} as const

// Markdown プレビューで画像を表示するためのカスタムスキーム。
// renderer は img の src をこのスキームの URL に書き換え、main 側のハンドラが
// project root 内のファイルとして読み出して返す（project root 外・非画像は拒否）。
export const MEDIA_SCHEME = 'noetelier-img'

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

// タブ 1 件の表示情報（クロームシェルに渡す）。id は webContents.id（安定・一意）。
export interface TabInfo {
  id: number
  // タブに表示するラベル（プロジェクト名。未選択時は「新規タブ」）。
  title: string
  // 未保存の変更があるか（Phase 5 で利用。当面は常に false）。
  dirty?: boolean
}

// クロームシェルに push するタブバーの状態。
export interface TabsState {
  tabs: TabInfo[]
  // アクティブタブの id。タブが無ければ null。
  activeId: number | null
}

// Editor と Terminal の並べ方。'horizontal' = 左右, 'vertical' = 上下。
export type WorkLayout = 'horizontal' | 'vertical'

// ターミナルのクイック操作（ヘッダのボタン）。押すと prompt を統合ターミナルに送る。
// id は React の key と保存後の識別に使う安定 ID。
export interface QuickPrompt {
  id: string
  // ボタンに表示するラベル。
  label: string
  // ボタンを押したときに統合ターミナルへ送るメッセージ（末尾の改行は送信側で付ける）。
  prompt: string
}

// アプリ全体の設定（設定画面で編集する）。項目はここに追加していく。
// main 側で読み込み時にデフォルト補完するため、項目を増やしても後方互換を保てる。
export interface AppSettings {
  quickPrompts: QuickPrompt[]
}

// クイック操作の初期値。main の正規化と renderer のフォールバックで共有する。
export const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  {
    id: 'commit',
    label: 'コミット',
    prompt: '変更内容を確認して、適切な粒度でコミットして'
  },
  {
    id: 'push',
    label: 'プッシュ',
    prompt: 'リモート（origin）と同期して。必要なら pull してから push して'
  },
  {
    id: 'commit-push',
    label: 'コミット&プッシュ',
    prompt:
      '変更内容を確認して適切な粒度でコミットし、その後 origin と同期（必要なら pull してから push）して'
  }
]

// アプリ設定の初期値。
export const DEFAULT_APP_SETTINGS: AppSettings = {
  quickPrompts: DEFAULT_QUICK_PROMPTS
}

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

// renamePath のリクエスト。relPath は対象（root 相対）、newName は同階層での新しい名前。
export interface RenamePathRequest {
  relPath: string
  newName: string
}

// renamePath の結果。relPath はリネーム後の新しい root 相対パス。
export interface RenamePathResult {
  relPath: string
}

// deletePath のリクエスト。relPath は対象（root 相対）。
export interface DeletePathRequest {
  relPath: string
}

// deletePath の結果。deleted はゴミ箱へ移動したか（false はユーザーが確認ダイアログでキャンセル）。
export interface DeletePathResult {
  deleted: boolean
}

// revealPath / copyPath のリクエスト。relPath は対象（root 相対）。
export interface RevealPathRequest {
  relPath: string
}

export interface CopyPathRequest {
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

// terminal:start のリクエスト。terminalId（タブ内でのターミナル識別子）と初期サイズを渡す。
export interface TerminalStartRequest {
  id: string
  cols: number
  rows: number
}

// terminal:start の結果。
export interface TerminalStartResult {
  // 起動できなかった場合（フォルダ未選択など）はエラーメッセージを返す。
  error?: string
}

// terminal:input の送信。どのターミナルへの入力かを id で指定する。
export interface TerminalInputMessage {
  id: string
  data: string
}

// terminal:resize のリクエスト。
export interface TerminalResizeRequest {
  id: string
  cols: number
  rows: number
}

// terminal:dispose のリクエスト。破棄するターミナルを id で指定する。
export interface TerminalDisposeRequest {
  id: string
}

// terminal:data の通知。どのターミナルの出力かを id で示す。
export interface TerminalDataMessage {
  id: string
  data: string
}

// terminal:exit の通知。どのターミナルが終了したかと、シェルプロセスの終了コード。
export interface TerminalExit {
  id: string
  exitCode: number
}

// terminal:bell の送信。どのターミナルが鳴らしたか（id）と表示番号（num）を渡す。
// num は OS 通知に「ターミナル N」と出して発生元を分かりやすくするために使う。
export interface TerminalBellMessage {
  id: string
  num: number
}

// terminal:activate の通知。クリックされたベル通知の発生元ターミナルを id で示す。
export interface TerminalActivateMessage {
  id: string
}

// terminal:active-changed の送信。アプリタブ内で今アクティブなターミナルの id。
export interface TerminalActiveChangedMessage {
  id: string
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
  // ファイル/フォルダをリネームする。新しい root 相対パスを返す。失敗時は例外。
  renamePath: (req: RenamePathRequest) => Promise<RenamePathResult>
  // ファイル/フォルダをゴミ箱へ移動する。main 側で確認ダイアログを出す。
  deletePath: (req: DeletePathRequest) => Promise<DeletePathResult>
  // Finder で項目を表示する。
  revealPath: (req: RevealPathRequest) => Promise<void>
  // 項目の絶対パスをクリップボードにコピーする。コピーしたパスを返す。
  copyPath: (req: CopyPathRequest) => Promise<string>
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
  // 「ファイル」メニューの「フォルダを開く」を購読する。返り値は購読解除関数。
  onRequestOpenFolder: (cb: () => void) => () => void
  // 「最近使ったフォルダ」メニューで選ばれたパスを購読する。返り値は購読解除関数。
  onRequestOpenFolderByPath: (cb: (path: string) => void) => () => void
  // 「設定…」メニューが選ばれたら通知を受ける。返り値は購読解除関数。
  onOpenSettings: (cb: () => void) => () => void

  // 現在のアプリ設定を取得する。
  getAppSettings: () => Promise<AppSettings>
  // アプリ設定を保存する。main 側で正規化した結果を返す。
  setAppSettings: (settings: AppSettings) => Promise<AppSettings>

  // 統合ターミナル。project root を cwd に、id で識別する PTY を起動する。
  terminalStart: (req: TerminalStartRequest) => Promise<TerminalStartResult>
  terminalInput: (msg: TerminalInputMessage) => void
  terminalResize: (req: TerminalResizeRequest) => void
  terminalDispose: (req: TerminalDisposeRequest) => void
  // PTY 出力を購読する。msg.id でターミナルを判別する。返り値は購読解除関数。
  onTerminalData: (cb: (msg: TerminalDataMessage) => void) => () => void
  // プロセス終了を購読する。返り値は購読解除関数。
  onTerminalExit: (cb: (exit: TerminalExit) => void) => () => void
  // ターミナルでベルが鳴ったことを main に通知する。main 側で非アクティブ時に OS 通知を出す。
  notifyTerminalBell: (msg: TerminalBellMessage) => void
  // ベル通知のクリックで発生元ターミナルへ復帰する指示を購読する。返り値は購読解除関数。
  onActivateTerminal: (cb: (id: string) => void) => () => void
  // 現在アクティブなターミナル（サブタブ）の id を main に報告する。通知抑制の判定に使う。
  reportActiveTerminal: (id: string) => void
  // drag & drop された File の OS 上の絶対パスを得る（Electron 32+ で File.path が廃止されたため）。
  getPathForFile: (file: File) => string

  // --- タブバー（クロームシェル）専用。タブ本体（App）からは使わない。 ---
  // タブ状態の更新を購読する。返り値は購読解除関数。
  onTabsState: (cb: (state: TabsState) => void) => () => void
  // 現在のタブ状態を要求する（マウント直後の初期同期）。
  requestTabsState: () => void
  // 新しいタブ（空）を作成する。
  newTab: () => void
  // 指定タブをアクティブにする。
  activateTab: (id: number) => void
  // 指定タブを閉じる。
  closeTab: (id: number) => void
}
