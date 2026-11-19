import { create } from 'zustand'
import type {
  FileNode,
  FsEventBatch,
  GitFileStatus,
  OpenFolderResult,
  WatchStatus
} from '../../../shared/ipc'

// 開いているファイル（バッファ）の状態。relPath をキーにストアで 1 つだけ持つ。
// 同じファイルが複数のタブ（履歴の移動で起こりうる）に現れても内容（編集・dirty 状態）は共有される。
export interface OpenFile {
  relPath: string
  name: string
  // 現在エディタに表示している内容（編集で変化する）。
  content: string
  // 直近に保存（または読み込み）した内容。dirty 判定の基準。
  savedContent: string
  isBinary: boolean
  // dirty なまま外部で内容が変更された（衝突）。上書きせずユーザーに通知する。
  externallyChanged?: boolean
  // 開いている最中に外部で削除された。バッファは保持する。
  externallyDeleted?: boolean
}

// エディタタブ 1 枚の状態。どのファイルを表示しているかと、そのタブ固有の履歴（戻る/進む）を持つ。
// 基本は 1 枚で、必要なときだけ新しいタブを開いて 2 枚以上にする（発展的な使い方）。
// （アプリ全体のプロジェクトタブとは別物。こちらは中央のエディタ内のタブ。）
export interface EditorTab {
  id: string
  // 表示しているファイルの relPath。未選択は null。
  relPath: string | null
  // ファイル履歴（戻る/進む）。historyIndex が現在位置。空のときは -1。
  history: string[]
  historyIndex: number
}

// エディタで特定位置へジャンプ・選択させる指示（検索結果クリック等）。
// seq は同じ位置を続けてクリックしても再度スクロール・選択させるための単調増加カウンタ。
export interface PendingReveal {
  // ジャンプ先のタブ。
  tabId: string
  relPath: string
  // 1 始まりの行・列（Monaco の座標系）。
  line: number
  column: number
  // 選択（ハイライト）する長さ。0 ならキャレット移動のみ。
  length: number
  seq: number
}

// ファイルを開く先の指定。
export interface OpenOptions {
  // true なら新しいタブ（アクティブタブの右隣）で開く。省略時はアクティブタブのファイルを置き換える。
  // どちらの場合も、そのファイルを既に別のタブで開いていればそのタブに切り替える。
  newTab?: boolean
}

// PendingReveal.seq を採番する単調増加カウンタ。
let revealSeq = 0

// エディタタブ ID を採番するカウンタ。
let tabSeq = 0
function newTab(relPath: string | null = null): EditorTab {
  return {
    id: `tab-${++tabSeq}`,
    relPath,
    history: relPath ? [relPath] : [],
    historyIndex: relPath ? 0 : -1
  }
}

// relPath の親ディレクトリの relPath を返す（トップレベルは ''）。
function parentDir(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

// relPath の末尾（ファイル名）を返す。
function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1)
}

// watcher の 1 バッチに含まれる新規作成（add）をこの件数まで「最近開いたファイル」に記録する。
// これを超える add は git checkout・clone・scaffold 等の一括生成とみなし、
// 手動／AI が個別に作ったファイルの履歴が流れてしまわないよう記録しない。
const RECENT_FILES_BULK_ADD_LIMIT = 5

// 隠しファイル表示設定の localStorage キー。プロジェクト（root）ごとに分ける。
// 全タブは localStorage を共有するため、root をキーに含めてタブ（プロジェクト）単位で保存する。
function showHiddenKey(root: string | null): string {
  return `show-hidden:${root ?? '__none__'}`
}

// localStorage から、指定 root の隠しファイル表示設定を復元する（既定は非表示）。
function loadShowHidden(root: string | null): boolean {
  return localStorage.getItem(showHiddenKey(root)) === 'true'
}

// 「変更ファイルのみ表示」設定の localStorage キー。隠しファイル設定と同様に root ごとに分ける。
function showOnlyChangedKey(root: string | null): string {
  return `show-only-changed:${root ?? '__none__'}`
}

// localStorage から、指定 root の「変更ファイルのみ表示」設定を復元する（既定は off）。
function loadShowOnlyChanged(root: string | null): boolean {
  return localStorage.getItem(showOnlyChangedKey(root)) === 'true'
}

// 未保存変更があるか。content と savedContent の差分で判定する。
export function isDirty(file: OpenFile | null): boolean {
  return file != null && !file.isBinary && file.content !== file.savedContent
}

// アクティブなタブで開いているファイル。未選択は null。
// ターミナルの「@」やエクスプローラーのハイライトなど、「いま見ているファイル」を参照する側が使う。
export function selectActiveFile(s: {
  files: Record<string, OpenFile>
  tabs: EditorTab[]
  activeTabId: string
}): OpenFile | null {
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  return tab?.relPath ? (s.files[tab.relPath] ?? null) : null
}

// どのタブからも参照されなくなったバッファを捨てる。
// （従来どおり、別ファイルへ移ったら元ファイルのバッファは破棄する。他のタブが表示中なら残す。）
function pruneFiles(
  files: Record<string, OpenFile>,
  tabs: EditorTab[]
): Record<string, OpenFile> {
  const used = new Set(tabs.map((p) => p.relPath).filter((r): r is string => r != null))
  const next: Record<string, OpenFile> = {}
  for (const [key, file] of Object.entries(files)) {
    if (used.has(key)) next[key] = file
  }
  return next
}

// 1 タブの履歴に relPath を積む。現在位置（historyIndex）より後ろは破棄してから積む。
// ＝戻った後に別ファイルを開くと、それ以降の「進む」履歴は消える（ブラウザ標準の挙動）。
// 直前と同じファイルを開いた場合は記録しない（履歴の重複を避ける）。
function withHistory(tab: EditorTab, relPath: string): EditorTab {
  if (tab.history[tab.historyIndex] === relPath) return tab
  const history = tab.history.slice(0, tab.historyIndex + 1)
  history.push(relPath)
  return { ...tab, history, historyIndex: history.length - 1 }
}

type StateSetter = (
  partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)
) => void

// ファイルを開く先のタブを決める。
// そのファイルを既に開いているタブがあればそこへ切り替える（同じファイルのタブを重複させない）。
// なければ、newTab のときは新しいタブをアクティブの右隣に作り、通常はアクティブタブを置き換える。
// 新規タブを作る場合は、挿入後の tabs も返す。
function resolveTarget(
  state: WorkspaceState,
  relPath: string,
  newTabRequested: boolean | undefined
): { tabId: string; tabs: EditorTab[] } {
  const { tabs, activeTabId } = state
  const existing = tabs.find((t) => t.relPath === relPath)
  if (existing) return { tabId: existing.id, tabs }
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === activeTabId)
  )
  if (!newTabRequested) return { tabId: tabs[activeIndex].id, tabs }
  const created = newTab()
  const next = [...tabs]
  next.splice(activeIndex + 1, 0, created)
  return { tabId: created.id, tabs: next }
}

// ファイルを開く共通処理。
// テキストは対象タブに展開してエディタ/プレビューに表示する。
// バイナリ/巨大ファイルは OS の既定アプリ（関連付け）で開き、エディタの表示は変更しない。
// 外部アプリで開けなかった場合のみ、従来どおりプレースホルダ表示にフォールバックする。
// recordHistory が true のとき、実際にエディタへ展開できたファイルだけを履歴に積む
// （バイナリを OS アプリで開いただけのケースは履歴に残さない）。
async function openFileInternal(
  relPath: string,
  name: string,
  get: () => WorkspaceState,
  set: StateSetter,
  options: {
    recordHistory?: boolean
    newTab?: boolean
    // 履歴移動（戻る/進む）で特定のタブを対象にするときに指定する。
    tabId?: string
    // 指定があれば、開いたあとにエディタをその行・列へスクロールし、範囲を選択する。
    reveal?: { line: number; column: number; length: number }
    // 前回セッションの復元による自動オープン。「最近開いたファイル」へは記録せず、
    // バイナリは OS の既定アプリで勝手に開かない（何も開かずに戻る）。
    restore?: boolean
  } = {}
): Promise<void> {
  const { recordHistory = true, newTab: openInNewTab, tabId, reveal, restore = false } = options
  // 既に（他のタブを含め）開いているバッファは読み直さず再利用する。
  // ディスクから読み直すと、別タブで編集中の内容を失ってしまうため。
  let buffer: OpenFile | undefined = get().files[relPath]
  if (!buffer) {
    const result = await window.api.readFile({ relPath })
    if (result.isBinary) {
      if (restore) return
      const error = await window.api.openPath({ relPath })
      // 開けたらエディタは差し替えない（現在の表示を維持する）。
      if (!error) return
      // 失敗時（関連付けが無い等）はプレースホルダ表示に倒す。
    }
    buffer = {
      relPath,
      name,
      content: result.content,
      savedContent: result.content,
      isBinary: result.isBinary
    }
  }
  const opened = buffer
  set((state) => {
    // 履歴移動で指定されたタブが（待っている間に）閉じられていたら何もしない。
    if (tabId && !state.tabs.some((p) => p.id === tabId)) return {}
    const target = tabId ? { tabId, tabs: state.tabs } : resolveTarget(state, relPath, openInNewTab)
    const tabs = target.tabs.map((p) => {
      if (p.id !== target.tabId) return p
      const moved = { ...p, relPath }
      return recordHistory ? withHistory(moved, relPath) : moved
    })
    return {
      files: pruneFiles({ ...state.files, [relPath]: opened }, tabs),
      tabs,
      activeTabId: target.tabId,
      // 復元による自動オープンではペインを開き直さない。
      fileOpenSeq: restore ? state.fileOpenSeq : state.fileOpenSeq + 1,
      // テキストとして開けたときだけジャンプ指示を積む（バイナリは reveal しない）。
      // reveal 指定の無い通常のオープンでは null にクリアする。そうしないと、以前検索から
      // ジャンプしたファイルを後で普通に開き直した際に、古い位置へ誤ってジャンプしてしまう。
      pendingReveal:
        reveal && !opened.isBinary
          ? {
              tabId: target.tabId,
              relPath,
              line: reveal.line,
              column: reveal.column,
              length: reveal.length,
              seq: ++revealSeq
            }
          : null
    }
  })
  if (recordHistory && !restore) {
    // 最近開いたファイルに記録する（現在の root 内のファイルのみ。更新後の一覧で置き換える）。
    // 履歴移動（戻る/進む）や、バイナリを OS アプリで開いただけのケースはここに来ないため記録されない。
    void window.api
      .addRecentFile({ relPath })
      .then((list) => set({ recentFiles: list }))
      .catch(() => {
        // 記録の失敗は表示に影響しないため無視する。
      })
  }
}

// 開いているバッファの一部フィールドだけを更新する（存在しなければ何もしない）。
function patchFile(relPath: string, patch: Partial<OpenFile>): void {
  useWorkspaceStore.setState((state) => {
    const file = state.files[relPath]
    return file ? { files: { ...state.files, [relPath]: { ...file, ...patch } } } : {}
  })
}

// タブのファイル履歴を delta（-1: 戻る / +1: 進む）だけ移動して、そのファイルを開く。
// 端にいるときは何もしない。履歴は書き換えず、位置だけ動かす。
async function moveHistory(
  tabId: string,
  delta: -1 | 1,
  get: () => WorkspaceState,
  set: StateSetter
): Promise<void> {
  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab) return
  const newIndex = tab.historyIndex + delta
  if (newIndex < 0 || newIndex >= tab.history.length) return
  const relPath = tab.history[newIndex]
  set((state) => ({
    tabs: state.tabs.map((p) => (p.id === tabId ? { ...p, historyIndex: newIndex } : p))
  }))
  try {
    await openFileInternal(relPath, baseName(relPath), get, set, {
      recordHistory: false,
      tabId
    })
  } catch {
    // 履歴上のファイルが削除された等で開けない場合は index だけ移動した状態にする。
  }
}

// エディタ関連の初期状態（空タブ 1 枚）。
function freshEditorState(): Pick<
  WorkspaceState,
  'files' | 'tabs' | 'activeTabId' | 'pendingReveal'
> {
  const tab = newTab()
  return { files: {}, tabs: [tab], activeTabId: tab.id, pendingReveal: null }
}

// openFolder / openFolderByPath の結果をストアに反映する共通処理。
// 結果が null（キャンセル・開けないフォルダ）の場合は何もしない。
async function applyOpenResult(
  result: OpenFolderResult | null,
  set: StateSetter,
  get: () => WorkspaceState
): Promise<void> {
  if (!result) return
  const rootChildren = await window.api.readDir({ relPath: '' })
  // 空のエディタ状態へ切り替わる間は保存しない（前回の保存内容を空で上書きしないため）。
  // 解除は restoreEditorSession の finally で行う。
  restoringEditor = true
  set({
    root: result.root,
    rootName: result.name,
    childrenByDir: { '': rootChildren },
    expandedDirs: new Set(),
    // 別フォルダに切り替えたらエディタは 1 枚の空タブに戻す（ファイル履歴もタブごとリセット）。
    ...freshEditorState(),
    // 最近開いたファイルは root ごとに管理する。切り替え直後は空にし、直後の loadRecentFiles で埋める。
    recentFiles: [],
    // ブックマークも root ごとに管理する。切り替え直後は空にし、直後の loadBookmarks で埋める。
    bookmarks: [],
    // 前のフォルダの Git status を持ち越さない。直後に refreshGitStatus で埋め直す。
    gitStatuses: {},
    // 開いたプロジェクト固有の隠しファイル表示設定に切り替える。
    showHidden: loadShowHidden(result.root),
    // 「変更ファイルのみ表示」設定もプロジェクト固有に切り替える。
    showOnlyChanged: loadShowOnlyChanged(result.root)
  })
  await restoreEditorSession(result.root, get, set)
}

// エディタのタブ構成（開いているファイル）の保存形式。
interface SavedEditorSession {
  // タブ順の relPath（空タブは含めない）。
  paths: string[]
  // アクティブだったタブの relPath。
  active: string | null
}

// 復元中（および root 切替の途中）は保存を止めるフラグ。
let restoringEditor = false

// エディタのタブ構成の localStorage キー。全アプリタブが localStorage を共有するため root ごとに分ける。
function editorSessionKey(root: string): string {
  return `editor-session:${root}`
}

function loadEditorSession(root: string): SavedEditorSession | null {
  try {
    const raw = localStorage.getItem(editorSessionKey(root))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedEditorSession>
    if (!Array.isArray(parsed.paths)) return null
    const paths = parsed.paths.filter((p): p is string => typeof p === 'string')
    return { paths, active: typeof parsed.active === 'string' ? parsed.active : null }
  } catch {
    return null
  }
}

// 現在のエディタのタブ構成を保存する。
function persistEditorSession(state: {
  root: string | null
  tabs: EditorTab[]
  activeTabId: string
}): void {
  if (!state.root || restoringEditor) return
  const paths = state.tabs.map((t) => t.relPath).filter((r): r is string => r != null)
  const active = state.tabs.find((t) => t.id === state.activeTabId)?.relPath ?? null
  try {
    localStorage.setItem(editorSessionKey(state.root), JSON.stringify({ paths, active }))
  } catch {
    // 保存できなくても動作には影響しない。
  }
}

// 前回開いていたファイルをタブとして開き直す（再起動・アップデート後の復元）。
// 存在しなくなったファイルは黙って飛ばす。内容はディスクから読み直すため、未保存の編集は復元しない。
async function restoreEditorSession(
  root: string,
  get: () => WorkspaceState,
  set: StateSetter
): Promise<void> {
  try {
    const saved = loadEditorSession(root)
    if (!saved) return
    let first = true
    for (const relPath of saved.paths) {
      // 復元の途中で別フォルダに切り替えられたら中止する。
      if (get().root !== root) return
      try {
        // 最初の 1 枚は初期の空タブを置き換え、以降は新しいタブを右へ足していく。
        await openFileInternal(relPath, baseName(relPath), get, set, {
          newTab: !first,
          restore: true
        })
      } catch {
        // 削除・移動されたファイルは飛ばす。
        continue
      }
      if (get().tabs.some((t) => t.relPath === relPath)) first = false
    }
    const activeTab = get().tabs.find((t) => t.relPath != null && t.relPath === saved.active)
    if (activeTab) set({ activeTabId: activeTab.id })
  } finally {
    restoringEditor = false
    // 復元結果（飛ばしたファイルを除いた構成）を保存し直す。
    persistEditorSession(useWorkspaceStore.getState())
  }
}

interface WorkspaceState {
  // project root（絶対パス）と表示名。未選択は null。
  root: string | null
  rootName: string | null

  // 展開済みディレクトリの relPath とその子ノード一覧のキャッシュ。
  childrenByDir: Record<string, FileNode[]>
  // 展開中のディレクトリ relPath の集合。
  expandedDirs: Set<string>

  // ユーザー操作でファイルを開くたびに増える連番。エディタペインを閉じている間に
  // ファイルツリー等からファイルを開いたとき、App がこれを見てペインを再表示する。
  fileOpenSeq: number

  // 開いているファイルのバッファ（relPath → 内容）。複数のタブが同じファイルを指しても 1 つを共有する。
  files: Record<string, OpenFile>

  // 中央のエディタタブ（左から順）。基本は 1 枚で、新しいタブで開くと 2 枚以上になる。常に 1 枚以上ある。
  tabs: EditorTab[]
  // 表示中（アクティブ）のタブ。エクスプローラー等から開くファイルの表示先（置き換え対象）になる。
  activeTabId: string

  // エディタへ渡す「この行・列へジャンプして選択せよ」という指示（検索結果クリック等）。
  // MonacoEditor が seq の変化を検知して反映する。未指定は null。
  pendingReveal: PendingReveal | null

  // 最近開いたフォルダの絶対パス一覧（新しい順）。
  recentFolders: string[]

  // 最近開いたファイルの relPath 一覧（新しい順、現在の root 内のみ）。
  recentFiles: string[]

  // ブックマークした relPath 一覧（登録順、現在の root 内のみ）。
  bookmarks: string[]

  // 隠しファイル（. で始まる名前）をツリーに表示するか。
  showHidden: boolean

  // 未コミットの変更があるファイルだけをフラット表示するか。
  showOnlyChanged: boolean

  // ファイルの Git status。project root 相対パス → 状態。非リポジトリ・変更なしは空。
  gitStatuses: Record<string, GitFileStatus>

  // file watcher の稼働状態。監視停止（ファイル数の上限超過）をバナーで知らせるために持つ。
  // main がフォルダを開くたび（＝invoke の応答前）に push してくるため、applyOpenResult では
  // リセットしない（リセットすると、先に届いた通知を後から消してしまう）。未受信は null。
  watchStatus: WatchStatus | null

  // 操作。
  openFolder: () => Promise<void>
  // 最近開いた一覧を main から取得して反映する。
  loadRecentFolders: () => Promise<void>
  // 最近開いたファイル一覧を main から取得して反映する（現在の root 内、存在しないものは除外済み）。
  loadRecentFiles: () => Promise<void>
  // ブックマーク一覧を main から取得して反映する（現在の root 内、存在しないものは除外済み）。
  loadBookmarks: () => Promise<void>
  // 指定 relPath をブックマークに追加する（現在の root 内）。
  addBookmark: (relPath: string) => Promise<void>
  // 指定 relPath をブックマークから外す。
  removeBookmark: (relPath: string) => Promise<void>
  // 前回フォルダ（最新の最近開いた一覧）を自動で開き直す。起動時に呼ぶ。
  restoreLastFolder: () => Promise<void>
  // 指定パスのフォルダを開く（最近開いた一覧からの選択）。
  openFolderByPath: (path: string) => Promise<void>
  toggleDir: (relPath: string) => Promise<void>
  // 既定ではアクティブタブのファイルを置き換えて開く。options.newTab なら新しいタブで開く。
  openFile: (node: FileNode, options?: OpenOptions) => Promise<void>
  // project root 相対パスを指定してファイルを開く（プレビュー内リンク等から呼ぶ）。
  // 開けない（存在しない・ディレクトリ・root 外）場合は何もしない。
  openFileByRelPath: (relPath: string, options?: OpenOptions) => Promise<void>
  // 相対パスのファイルを開き、指定の行・列へジャンプして範囲を選択する（検索結果クリック）。
  openFileAtLocation: (relPath: string, line: number, column: number, length: number) => Promise<void>
  // 指定タブで開いているファイルの指定行へジャンプ指示だけを積む（バックログビューの索引行ジャンプ）。
  // openFileAtLocation と違いディスクから読み直さないため、未保存の編集を保持したまま移動できる。
  revealAt: (tabId: string, line: number) => void
  // タブのファイル履歴を 1 つ戻る / 進む。端にいるときは何もしない。
  goBack: (tabId: string) => Promise<void>
  goForward: (tabId: string) => Promise<void>
  // タブを閉じる（最後の 1 枚は閉じられない）。そのタブだけが持つ未保存の変更があれば確認する。
  closeTab: (tabId: string) => void
  // アクティブタブを切り替える。
  setActiveTab: (tabId: string) => void
  // エディタの編集内容を反映する。
  updateContent: (relPath: string, content: string) => void
  // 指定ファイルを保存する。binary / 未オープン / 未変更時は何もしない。
  saveFile: (relPath: string) => Promise<void>
  // file watcher の変更バッチを反映する（ツリー更新 + 開いているファイルへの反映）。
  applyFsChanges: (batch: FsEventBatch) => Promise<void>
  // 開いているファイルをディスクから読み直す（外部変更の取り込み）。
  reloadFromDisk: (relPath: string) => Promise<void>
  // 外部変更の衝突通知を閉じる（自分の編集を保持する）。
  dismissExternalChange: (relPath: string) => void
  // ファイル/フォルダをリネームする。開いているファイルが対象（配下含む）なら追従させる。
  // ツリー自体は file watcher の変更通知で更新される。
  renamePath: (relPath: string, newName: string) => Promise<void>
  // 隠しファイルの表示設定を切り替える（localStorage にも保存する）。
  setShowHidden: (show: boolean) => void
  // 「変更ファイルのみ表示」設定を切り替える（localStorage にも保存する）。
  setShowOnlyChanged: (show: boolean) => void
  // Git status を main から取得し直してツリー表示に反映する。
  refreshGitStatus: () => Promise<void>
  // file watcher の稼働状態を反映する（main からの push を App が購読して呼ぶ）。
  setWatchStatus: (status: WatchStatus) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  rootName: null,
  childrenByDir: {},
  expandedDirs: new Set(),
  ...freshEditorState(),
  fileOpenSeq: 0,
  recentFolders: [],
  recentFiles: [],
  bookmarks: [],
  // 起動直後は root 未確定のため既定値で初期化し、フォルダを開いた時点で root 別の値に切り替える。
  showHidden: loadShowHidden(null),
  showOnlyChanged: loadShowOnlyChanged(null),
  gitStatuses: {},
  watchStatus: null,

  // フォルダを開き、ルート直下を読み込む。
  openFolder: async () => {
    const result = await window.api.openFolder()
    await applyOpenResult(result, set, get)
    await get().refreshGitStatus()
    await get().loadRecentFolders()
    await get().loadRecentFiles()
    await get().loadBookmarks()
  },

  // 最近開いた一覧を main から取得して反映する。
  loadRecentFolders: async () => {
    const recent = await window.api.getRecentFolders()
    set({ recentFolders: recent })
  },

  // 最近開いたファイル一覧を main から取得して反映する（存在しないものは main 側で除外済み）。
  loadRecentFiles: async () => {
    const recent = await window.api.getRecentFiles()
    set({ recentFiles: recent })
  },

  // ブックマーク一覧を main から取得して反映する（存在しないものは main 側で除外済み）。
  loadBookmarks: async () => {
    const list = await window.api.getBookmarks()
    set({ bookmarks: list })
  },

  // 指定 relPath をブックマークに追加する。更新後の一覧で置き換える。
  addBookmark: async (relPath: string) => {
    const list = await window.api.addBookmark({ relPath })
    set({ bookmarks: list })
  },

  // 指定 relPath をブックマークから外す。更新後の一覧で置き換える。
  removeBookmark: async (relPath: string) => {
    const list = await window.api.removeBookmark({ relPath })
    set({ bookmarks: list })
  },

  // 前回フォルダを自動で開き直す。存在しなければ何もしない（一覧は main 側で掃除される）。
  restoreLastFolder: async () => {
    const recent = await window.api.getRecentFolders()
    set({ recentFolders: recent })
    const last = recent[0]
    if (!last) return
    const result = await window.api.openFolderByPath({ path: last })
    await applyOpenResult(result, set, get)
    await get().refreshGitStatus()
    // 開けずに一覧から除外された場合に備えて再取得する。
    await get().loadRecentFolders()
    await get().loadRecentFiles()
    await get().loadBookmarks()
  },

  // 指定パスのフォルダを開く（最近開いた一覧からの選択）。
  openFolderByPath: async (path: string) => {
    const result = await window.api.openFolderByPath({ path })
    await applyOpenResult(result, set, get)
    await get().refreshGitStatus()
    await get().loadRecentFolders()
    await get().loadRecentFiles()
    await get().loadBookmarks()
  },

  // ディレクトリの展開 / 折りたたみ。未読込なら子を取得する。
  toggleDir: async (relPath: string) => {
    const { expandedDirs, childrenByDir } = get()
    const next = new Set(expandedDirs)
    if (next.has(relPath)) {
      next.delete(relPath)
      set({ expandedDirs: next })
      return
    }
    next.add(relPath)
    // 未キャッシュなら読み込む。
    if (!childrenByDir[relPath]) {
      const children = await window.api.readDir({ relPath })
      set({
        expandedDirs: next,
        childrenByDir: { ...get().childrenByDir, [relPath]: children }
      })
    } else {
      set({ expandedDirs: next })
    }
  },

  // ファイルを開いて中央のエディタに表示する（バイナリは OS の既定アプリで開く）。
  openFile: async (node: FileNode, options?: OpenOptions) => {
    if (node.isDirectory) return
    await openFileInternal(node.relPath, node.name, get, set, { newTab: options?.newTab })
  },

  // project root 相対パスを指定してファイルを開く。
  // explorer の openFile と同じ共通処理を使い、挙動を揃える。
  openFileByRelPath: async (relPath: string, options?: OpenOptions) => {
    try {
      await openFileInternal(relPath, baseName(relPath), get, set, { newTab: options?.newTab })
    } catch {
      // 読めない（存在しない・ディレクトリ・root 外を main が拒否）場合は何もしない。
      // 「最近開いたファイル」から消えたファイルをクリックしたケースに備え、一覧から掃除する。
      try {
        const list = await window.api.removeRecentFile({ relPath })
        set({ recentFiles: list })
      } catch {
        // 掃除の失敗は表示に影響しないため無視する。
      }
    }
  },

  // 相対パスのファイルを開き、指定の行・列へジャンプして範囲を選択する。
  // 検索結果クリックから呼ぶ。同じ位置を続けてクリックしても再度スクロールするよう seq を更新する。
  openFileAtLocation: async (relPath: string, line: number, column: number, length: number) => {
    try {
      await openFileInternal(relPath, baseName(relPath), get, set, {
        reveal: { line, column, length }
      })
    } catch {
      // 読めない（削除・ディレクトリ・root 外）場合は何もしない。
    }
  },

  // 指定タブで開いているファイル内の指定行へジャンプ指示を積む。
  // ディスクを読み直さず pendingReveal だけを更新するので、dirty な編集内容は失われない
  // （EditorPane 側の activeReveal 監視が Edit モードへ切り替えて該当行を選択する）。
  revealAt: (tabId: string, line: number) => {
    const { tabs, files } = get()
    const relPath = tabs.find((p) => p.id === tabId)?.relPath
    if (!relPath || !files[relPath] || files[relPath].isBinary) return
    set({
      pendingReveal: { tabId, relPath, line, column: 1, length: 0, seq: ++revealSeq }
    })
  },

  // タブのファイル履歴を 1 つ戻る。先頭にいるときは何もしない。
  // 履歴移動なので recordHistory=false で開き、履歴は書き換えない。
  goBack: async (tabId: string) => {
    await moveHistory(tabId, -1, get, set)
  },

  // タブのファイル履歴を 1 つ進む。末尾にいるときは何もしない。
  goForward: async (tabId: string) => {
    await moveHistory(tabId, 1, get, set)
  },

  // タブを閉じる。そのタブでしか開いていない dirty なファイルは、破棄してよいか確認する。
  closeTab: (tabId: string) => {
    const { tabs, files, activeTabId } = get()
    if (tabs.length <= 1) return
    const index = tabs.findIndex((p) => p.id === tabId)
    if (index === -1) return
    const closing = tabs[index]
    const remaining = tabs.filter((p) => p.id !== tabId)
    const file = closing.relPath ? files[closing.relPath] : null
    const stillShown =
      closing.relPath != null && remaining.some((p) => p.relPath === closing.relPath)
    if (file && isDirty(file) && !stillShown) {
      const ok = window.confirm(`${file.name} には未保存の変更があります。破棄して閉じますか？`)
      if (!ok) return
    }
    // アクティブを閉じたときは、隣（右、なければ左）のタブへ移す。
    const nextActive =
      activeTabId === tabId ? (remaining[index] ?? remaining[index - 1]).id : activeTabId
    set({
      tabs: remaining,
      activeTabId: nextActive,
      files: pruneFiles(files, remaining)
    })
  },

  // アクティブタブを切り替える。変化がなければ何もしない（不要な再描画を避ける）。
  setActiveTab: (tabId: string) => {
    if (get().activeTabId === tabId) return
    if (!get().tabs.some((p) => p.id === tabId)) return
    set({ activeTabId: tabId })
  },

  // エディタの編集内容をストアに反映する。
  updateContent: (relPath: string, content: string) => {
    const file = get().files[relPath]
    if (!file || file.content === content) return
    set({ files: { ...get().files, [relPath]: { ...file, content } } })
  },

  // 指定ファイルを保存する。
  saveFile: async (relPath: string) => {
    const file = get().files[relPath]
    if (!file || file.isBinary) return
    if (file.content === file.savedContent) return
    // 保存する内容を固定しておき、保存中の追加編集と取り違えないようにする。
    const contentToSave = file.content
    await window.api.writeFile({ relPath, content: contentToSave })
    // 保存対象が依然開かれている場合のみ savedContent を同期する。
    // 自分の保存で衝突フラグが残っていれば解消する。
    patchFile(relPath, {
      savedContent: contentToSave,
      externallyChanged: false,
      externallyDeleted: false
    })
  },

  // file watcher の変更バッチを反映する。
  applyFsChanges: async (batch: FsEventBatch) => {
    if (!get().root) return

    // 1. ツリー更新: 影響を受けた親ディレクトリのうちキャッシュ済みのものを再読込する。
    const affectedParents = new Set<string>()
    for (const c of batch.changes) {
      affectedParents.add(parentDir(c.relPath))
    }
    const dirsToRefresh = [...affectedParents].filter(
      (d) => get().childrenByDir[d] !== undefined
    )
    const refreshed: Record<string, FileNode[]> = {}
    for (const d of dirsToRefresh) {
      try {
        refreshed[d] = await window.api.readDir({ relPath: d })
      } catch {
        // ディレクトリ自体が消えた場合などは後段の掃除に任せる。
      }
    }

    // 削除されたディレクトリ配下のキャッシュ・展開状態を掃除する。
    const removedDirs = batch.changes
      .filter((c) => c.kind === 'unlinkDir')
      .map((c) => c.relPath)

    set((state) => {
      const childrenByDir = { ...state.childrenByDir, ...refreshed }
      const expandedDirs = new Set(state.expandedDirs)
      for (const removed of removedDirs) {
        const prefix = `${removed}/`
        for (const key of Object.keys(childrenByDir)) {
          if (key === removed || key.startsWith(prefix)) delete childrenByDir[key]
        }
        for (const key of [...expandedDirs]) {
          if (key === removed || key.startsWith(prefix)) expandedDirs.delete(key)
        }
      }
      return { childrenByDir, expandedDirs }
    })

    // ディスク上の変更に追従して Git status も取り直す（追加/変更/削除マークの更新）。
    void get().refreshGitStatus()

    // 2. 新規作成されたファイルを「最近開いたファイル」に記録する。
    // ターミナルの Claude Code 等が生成したファイルを、ツリーを辿らずすぐ開けるようにする。
    // 一括生成（RECENT_FILES_BULK_ADD_LIMIT 超の add を含むバッチ）は記録しない。
    const addedFiles = [
      ...new Set(batch.changes.filter((c) => c.kind === 'add').map((c) => c.relPath))
    ]
    if (addedFiles.length > 0 && addedFiles.length <= RECENT_FILES_BULK_ADD_LIMIT) {
      try {
        let list: string[] = get().recentFiles
        for (const relPath of addedFiles) {
          list = await window.api.addRecentFile({ relPath })
        }
        set({ recentFiles: list })
      } catch {
        // 記録の失敗は表示に影響しないため無視する。
      }
    }

    // 3. 開いているファイル（バッファ）への反映。タブに関係なくバッファ単位で行う。
    for (const file of Object.values(get().files)) {
      const change = batch.changes.find((c) => c.relPath === file.relPath)
      if (!change) continue
      if (change.kind === 'unlink') {
        // 削除: バッファは保持し、削除されたことだけ通知する。
        patchFile(file.relPath, { externallyDeleted: true })
        continue
      }
      if (change.kind === 'change' || change.kind === 'add') {
        if (isDirty(file)) {
          // dirty: 上書きせず衝突を通知する（spec 受け入れ条件 4.4）。
          patchFile(file.relPath, { externallyChanged: true })
        } else {
          // not dirty: 自動でディスクの内容に追従する。
          await get().reloadFromDisk(file.relPath)
        }
      }
    }
  },

  // 開いているファイルをディスクから読み直す。
  reloadFromDisk: async (relPath: string) => {
    if (!get().files[relPath]) return
    try {
      const result = await window.api.readFile({ relPath })
      patchFile(relPath, {
        content: result.content,
        savedContent: result.content,
        isBinary: result.isBinary,
        externallyChanged: false,
        externallyDeleted: false
      })
    } catch {
      // 読めない（削除された等）場合は削除フラグに倒す。
      patchFile(relPath, { externallyDeleted: true })
    }
  },

  // 外部変更の衝突 / 削除通知を閉じる（自分の編集を保持する）。
  dismissExternalChange: (relPath: string) => {
    patchFile(relPath, { externallyChanged: false, externallyDeleted: false })
  },

  // ファイル/フォルダをリネームする。
  // 開いているファイルがリネーム対象そのもの、またはリネームしたフォルダ配下なら relPath を付け替える
  // （バッファ・各タブの表示先・履歴のすべて）。
  renamePath: async (relPath: string, newName: string) => {
    const result = await window.api.renamePath({ relPath, newName })
    // 旧 relPath を新 relPath へ写す。対象外はそのまま返す。
    const remap = (p: string): string => {
      if (p === relPath) return result.relPath
      if (p.startsWith(`${relPath}/`)) return `${result.relPath}${p.slice(relPath.length)}`
      return p
    }
    set((state) => {
      const files: Record<string, OpenFile> = {}
      for (const [key, file] of Object.entries(state.files)) {
        const next = remap(key)
        files[next] =
          next === key
            ? file
            : { ...file, relPath: next, name: key === relPath ? newName : file.name }
      }
      const tabs = state.tabs.map((p) => ({
        ...p,
        relPath: p.relPath ? remap(p.relPath) : null,
        history: p.history.map(remap)
      }))
      return { files, tabs }
    })
  },

  // 隠しファイルの表示設定を切り替える（現在のプロジェクト root のキーに保存する）。
  setShowHidden: (show: boolean) => {
    localStorage.setItem(showHiddenKey(get().root), show ? 'true' : 'false')
    set({ showHidden: show })
  },

  // 「変更ファイルのみ表示」設定を切り替える（現在のプロジェクト root のキーに保存する）。
  setShowOnlyChanged: (show: boolean) => {
    localStorage.setItem(showOnlyChangedKey(get().root), show ? 'true' : 'false')
    set({ showOnlyChanged: show })
  },

  // Git status を main から取得し直す。フォルダ未選択・非リポジトリ・失敗時は空にする。
  refreshGitStatus: async () => {
    if (!get().root) {
      set({ gitStatuses: {} })
      return
    }
    // 取得開始時点の root を控え、応答が返るまでにフォルダが切り替わっていたら破棄する。
    const rootAtRequest = get().root
    try {
      const result = await window.api.getGitStatus()
      if (get().root !== rootAtRequest) return
      set({ gitStatuses: result.isRepo ? result.statuses : {} })
    } catch {
      if (get().root !== rootAtRequest) return
      set({ gitStatuses: {} })
    }
  },

  // file watcher の稼働状態を反映する。監視停止時は FileExplorer がバナーを出す。
  setWatchStatus: (status: WatchStatus) => {
    set({ watchStatus: status })
  }
}))

// エディタのタブ構成が変わるたびに保存する（アプリ更新・再起動で復元するため）。
useWorkspaceStore.subscribe((state, prev) => {
  if (state.root !== prev.root || state.tabs !== prev.tabs || state.activeTabId !== prev.activeTabId) {
    persistEditorSession(state)
  }
})
