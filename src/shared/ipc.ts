// main / preload / renderer で共有する IPC の型定義とチャンネル名。

// IPC チャンネル名。文字列のタイポを防ぐため定数化する。
export const IpcChannel = {
  OpenFolder: 'workspace:open-folder',
  // 指定パス（最近開いた一覧・前回フォルダ）を直接開く。
  OpenFolderByPath: 'workspace:open-folder-by-path',
  // 最近開いたフォルダの絶対パス一覧を取得する。
  GetRecentFolders: 'workspace:get-recent-folders',
  // 最近開いたファイル（現在の project root 内）。relPath 一覧の取得・追加・削除。
  GetRecentFiles: 'workspace:get-recent-files',
  AddRecentFile: 'workspace:add-recent-file',
  RemoveRecentFile: 'workspace:remove-recent-file',
  // ブックマーク（現在の project root 内でユーザーが固定したファイル）。relPath 一覧の取得・追加・削除。
  GetBookmarks: 'workspace:get-bookmarks',
  AddBookmark: 'workspace:add-bookmark',
  RemoveBookmark: 'workspace:remove-bookmark',
  ReadDir: 'workspace:read-dir',
  ReadFile: 'workspace:read-file',
  WriteFile: 'workspace:write-file',
  // project root 配下のテキストファイルを横断検索する（VSCode の Ctrl+Shift+F 相当）。
  SearchInFiles: 'workspace:search',
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
  // M→R push: file watcher の稼働状態。ファイル数が上限を超えて監視を停止した場合に
  // watching=false で通知し、renderer はバナーで知らせる（fd 枯渇によるターミナル即死の防止）。
  WatchStatus: 'workspace:watch-status',
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
  // M→R push: 「編集」メニューの「ファイル内を検索…」（⇧⌘F）が選ばれた。renderer は検索ペインを開く。
  OpenSearch: 'view:open-search',

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
  TerminalActiveChanged: 'terminal:active-changed',
  // M→R push: このアプリタブ内で「ベルが鳴ったがまだ見ていない（未確認）」ターミナルの id 一覧。
  // 通知を閉じても、そのターミナルを開くまではサブタブに印を出し続けるために使う。
  TerminalUnread: 'terminal:unread'
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
  // このタブ内に「ベルが鳴ったがまだ見ていない（未確認）」ターミナルがあるか。
  // 通知を閉じても、該当ターミナルを開くまでタブに印を出し続けるために使う。
  attention?: boolean
}

// クロームシェルに push するタブバーの状態。
export interface TabsState {
  tabs: TabInfo[]
  // アクティブタブの id。タブが無ければ null。
  activeId: number | null
}

// Editor と Terminal の並べ方。'horizontal' = 左右, 'vertical' = 上下。
export type WorkLayout = 'horizontal' | 'vertical'

// ペインの配置（列位置）のカスタマイズ。
// PTY を壊さないため、構造は「Explorer | (Editor, Terminal)」の入れ子のまま保ち、
// Explorer を左右どちらに置くか・Terminal を Editor の前（左/上）に置くかだけを切り替える。
export interface PaneArrangement {
  // ファイルツリー（検索ペイン含む）を作業エリアの左右どちらに置くか。
  explorerSide: 'left' | 'right'
  // true ならターミナルをエディタの前（左右並びなら左、上下並びなら上）に置く。
  terminalFirst: boolean
}

// ペイン配置の初期値（従来どおり: 左に Explorer、Editor の後ろに Terminal）。
export const DEFAULT_PANE_ARRANGEMENT: PaneArrangement = {
  explorerSide: 'left',
  terminalFirst: false
}

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
  // ファイル監視（chokidar）から除外するディレクトリ名。フォルダ名の完全一致で除外する。
  // 目的はファイルディスクリプタ（fd）枯渇の防止。chokidar は macOS で監視対象ファイル 1 つに
  // つき fd を 1 つ使うため、.venv のような大量ファイルを含むフォルダを監視すると fd が枯渇し、
  // 新しいターミナルが起動できず即終了する（[プロセスが終了しました (code 0)]）。
  watchIgnoredDirs: string[]
  // ペインの配置（ファイルツリーの左右・ターミナルの前後）。
  paneArrangement: PaneArrangement
}

// 監視から除外するフォルダ名の初期値。fd 枯渇を避けるため、生成物・キャッシュ・仮想環境など
// 「編集対象ではなく、監視する価値のない大量ファイルを含むフォルダ」を既定で除外する。
// これらはファイルツリーには表示される（監視だけを止める）。設定画面で編集できる。
export const DEFAULT_WATCH_IGNORED_DIRS: string[] = [
  // バージョン管理・パッケージ・ビルド生成物
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  // Python の仮想環境・キャッシュ
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  '__pycache__',
  // JS/その他パッケージ・ビルド生成物
  '.pnpm-store',
  '.yarn',
  '.turbo',
  '.gradle',
  '.terraform',
  'vendor',
  'target',
  'out',
  '.cache',
  // Unity の生成物（Library だけで数万ファイルになる）。名前がやや一般的だが、
  // 除外してもツリー表示・編集はでき、監視（自動更新）が止まるだけなので許容する。
  'Library',
  'Temp',
  'Logs',
  // .NET / MSBuild の中間生成物
  'obj',
  // Xcode / CocoaPods の生成物
  'DerivedData',
  'Pods'
]

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
  quickPrompts: DEFAULT_QUICK_PROMPTS,
  watchIgnoredDirs: DEFAULT_WATCH_IGNORED_DIRS,
  paneArrangement: DEFAULT_PANE_ARRANGEMENT
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

// 最近開いたファイルの追加リクエスト。relPath は現在の project root 相対。
export interface AddRecentFileRequest {
  relPath: string
}

// 最近開いたファイルの削除リクエスト。relPath は現在の project root 相対。
export interface RemoveRecentFileRequest {
  relPath: string
}

// ブックマークの追加リクエスト。relPath は現在の project root 相対。
export interface AddBookmarkRequest {
  relPath: string
}

// ブックマークの削除リクエスト。relPath は現在の project root 相対。
export interface RemoveBookmarkRequest {
  relPath: string
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

// ファイル横断検索のリクエスト。query は検索文字列（regex=true なら正規表現）。
export interface SearchRequest {
  query: string
  // 大文字小文字を区別するか。
  caseSensitive: boolean
  // 単語単位でマッチさせるか（\b で囲む）。
  wholeWord: boolean
  // query を正規表現として解釈するか。
  regex: boolean
}

// 1 ファイル内の 1 マッチ。行・列は 1 始まり（Monaco の座標系に合わせる）。
export interface SearchMatch {
  // マッチした行番号（1 始まり）。
  line: number
  // マッチ開始の列（1 始まり、UTF-16 コード単位）。エディタでの選択に使う。
  column: number
  // マッチした文字列の長さ（ハイライト範囲・選択範囲に使う）。
  length: number
  // 表示用の行プレビュー（長い行はマッチ周辺だけ切り出す）。
  preview: string
  // preview 内でのマッチ開始オフセット（0 始まり）。切り詰めで column とはずれるため別に持つ。
  previewColumn: number
}

// 1 ファイル分の検索結果。
export interface SearchFileResult {
  // project root からの相対パス（'/' 区切り）。
  relPath: string
  matches: SearchMatch[]
}

// 検索結果全体。
export interface SearchResult {
  // マッチのあったファイル（ディレクトリ先・名前順）。
  files: SearchFileResult[]
  // マッチ総数（上限で打ち切った場合は打ち切り後の数）。
  totalMatches: number
  // 上限（総マッチ数・走査ファイル数）に達して打ち切ったか。
  truncated: boolean
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

// file watcher の稼働状態（WatchStatus チャンネルで push する）。
// macOS では監視対象 1 つにつき fd を 1 つ使うため、監視対象がプロセスの fd 上限（約 1 万）に
// 迫るとターミナル（forkpty）が起動できなくなる。これを防ぐため、監視対象数が上限を超える
// フォルダでは監視を止め、renderer にはこの通知でバナーを出してもらう。
export interface WatchStatus {
  // このタブの project root を監視しているか。false = 対象数が上限を超えて停止した。
  watching: boolean
  // 事前スキャンで数えた監視対象数（ファイル + フォルダ）。上限超過時は打ち切った時点の数。
  entryCount: number
  // 監視対象数の上限（全タブ合計の予算から算出した、このタブに許された数）。
  limit: number
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

// terminal:bell の送信。どのターミナルが鳴らしたか（id）と表示名（label）を渡す。
// label は OS 通知に発生元を出すために使う。ユーザーが付けた名前があればそれ、
// 無ければ「ターミナル N」の形（組み立ては renderer 側が行う）。
export interface TerminalBellMessage {
  id: string
  label: string
}

// terminal:activate の通知。クリックされたベル通知の発生元ターミナルを id で示す。
export interface TerminalActivateMessage {
  id: string
}

// terminal:active-changed の送信。アプリタブ内で今アクティブなターミナルの id。
export interface TerminalActiveChangedMessage {
  id: string
}

// terminal:unread の push。このアプリタブ内で未確認（ベルが鳴ったが未表示）のターミナル id 一覧。
export interface TerminalUnreadMessage {
  ids: string[]
}

// renderer に公開する API の型。preload で実装し window.api として参照する。
export interface WorkspaceApi {
  openFolder: () => Promise<OpenFolderResult | null>
  // 指定パスを開く。存在しない・ディレクトリでない場合は null。
  openFolderByPath: (req: OpenFolderByPathRequest) => Promise<OpenFolderResult | null>
  // 最近開いたフォルダの絶対パス一覧（新しい順）。
  getRecentFolders: () => Promise<string[]>
  // 最近開いたファイル（現在の project root 内、新しい順の relPath 一覧）を取得する。
  // main 側でディスク上に無くなったファイルは除外して返す。
  getRecentFiles: () => Promise<string[]>
  // 最近開いたファイルに relPath を記録し、更新後の一覧を返す。
  addRecentFile: (req: AddRecentFileRequest) => Promise<string[]>
  // 最近開いたファイルから relPath を除外し、更新後の一覧を返す。
  removeRecentFile: (req: RemoveRecentFileRequest) => Promise<string[]>
  // ブックマーク（現在の project root 内、登録順の relPath 一覧）を取得する。
  // main 側でディスク上に無くなったファイルは除外して返す。
  getBookmarks: () => Promise<string[]>
  // ブックマークに relPath を追加し、更新後の一覧を返す。
  addBookmark: (req: AddBookmarkRequest) => Promise<string[]>
  // ブックマークから relPath を除外し、更新後の一覧を返す。
  removeBookmark: (req: RemoveBookmarkRequest) => Promise<string[]>
  readDir: (req: ReadDirRequest) => Promise<FileNode[]>
  readFile: (req: ReadFileRequest) => Promise<ReadFileResult>
  writeFile: (req: WriteFileRequest) => Promise<WriteFileResult>
  // project root 配下のテキストファイルを横断検索する。フォルダ未選択・空クエリは空結果。
  searchInFiles: (req: SearchRequest) => Promise<SearchResult>
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
  // file watcher の稼働状態（監視停止の通知）を購読する。返り値は購読解除関数。
  onWatchStatus: (cb: (status: WatchStatus) => void) => () => void
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
  // 「ファイル内を検索…」（⇧⌘F）が選ばれたら通知を受ける。返り値は購読解除関数。
  onOpenSearch: (cb: () => void) => () => void

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
  // このアプリタブ内で未確認（ベルが鳴ったが未表示）のターミナル id 一覧を購読する。
  // 該当サブタブに印を出すために使う。返り値は購読解除関数。
  onTerminalUnread: (cb: (ids: string[]) => void) => () => void
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
