import { create } from 'zustand'
import type {
  FileNode,
  FsEventBatch,
  GitFileStatus,
  OpenFolderResult
} from '../../../shared/ipc'

// 開いているファイルの状態。
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

// relPath の親ディレクトリの relPath を返す（トップレベルは ''）。
function parentDir(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

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

// 履歴に relPath を積む。現在位置（historyIndex）より後ろは破棄してから積む。
// ＝戻った後に別ファイルを開くと、それ以降の「進む」履歴は消える（ブラウザ標準の挙動）。
// 直前と同じファイルを開いた場合は記録しない（履歴の重複を避ける）。
function pushHistory(
  relPath: string,
  get: () => WorkspaceState,
  set: (partial: Partial<WorkspaceState>) => void
): void {
  const { history, historyIndex } = get()
  if (history[historyIndex] === relPath) return
  const next = history.slice(0, historyIndex + 1)
  next.push(relPath)
  set({ history: next, historyIndex: next.length - 1 })
}

// ファイルを開く共通処理。
// テキストは activeFile に展開してエディタ/プレビューに表示する。
// バイナリ/巨大ファイルは OS の既定アプリ（関連付け）で開き、エディタの表示は変更しない。
// 外部アプリで開けなかった場合のみ、従来どおりプレースホルダ表示にフォールバックする。
// recordHistory が true のとき、実際にエディタへ展開できたファイルだけを履歴に積む
// （バイナリを OS アプリで開いただけのケースは履歴に残さない）。
async function openFileInternal(
  relPath: string,
  name: string,
  get: () => WorkspaceState,
  set: (partial: Partial<WorkspaceState>) => void,
  recordHistory = true
): Promise<void> {
  const result = await window.api.readFile({ relPath })
  if (result.isBinary) {
    const error = await window.api.openPath({ relPath })
    // 開けたらエディタは差し替えない（現在の表示を維持する）。
    if (!error) return
    // 失敗時（関連付けが無い等）はプレースホルダ表示に倒す。
  }
  set({
    activeFile: {
      relPath,
      name,
      content: result.content,
      savedContent: result.content,
      isBinary: result.isBinary
    }
  })
  if (recordHistory) pushHistory(relPath, get, set)
}

// openFolder / openFolderByPath の結果をストアに反映する共通処理。
// 結果が null（キャンセル・開けないフォルダ）の場合は何もしない。
async function applyOpenResult(
  result: OpenFolderResult | null,
  set: (partial: Partial<WorkspaceState>) => void
): Promise<void> {
  if (!result) return
  const rootChildren = await window.api.readDir({ relPath: '' })
  set({
    root: result.root,
    rootName: result.name,
    childrenByDir: { '': rootChildren },
    expandedDirs: new Set(),
    activeFile: null,
    // 別フォルダに切り替えたらファイル履歴（戻る/進む）はリセットする。
    history: [],
    historyIndex: -1,
    // 前のフォルダの Git status を持ち越さない。直後に refreshGitStatus で埋め直す。
    gitStatuses: {},
    // 開いたプロジェクト固有の隠しファイル表示設定に切り替える。
    showHidden: loadShowHidden(result.root),
    // 「変更ファイルのみ表示」設定もプロジェクト固有に切り替える。
    showOnlyChanged: loadShowOnlyChanged(result.root)
  })
}

interface WorkspaceState {
  // project root（絶対パス）と表示名。未選択は null。
  root: string | null
  rootName: string | null

  // 展開済みディレクトリの relPath とその子ノード一覧のキャッシュ。
  childrenByDir: Record<string, FileNode[]>
  // 展開中のディレクトリ relPath の集合。
  expandedDirs: Set<string>

  // 中央ペインで開いているファイル。未選択は null。
  activeFile: OpenFile | null

  // ファイル履歴（戻る/進む）。開いたファイルの relPath を新しい順ではなく時系列で積む。
  // historyIndex が現在位置。戻ると index が減り、進むと増える。空のときは -1。
  history: string[]
  historyIndex: number

  // 最近開いたフォルダの絶対パス一覧（新しい順）。
  recentFolders: string[]

  // 隠しファイル（. で始まる名前）をツリーに表示するか。
  showHidden: boolean

  // 未コミットの変更があるファイルだけをフラット表示するか。
  showOnlyChanged: boolean

  // ファイルの Git status。project root 相対パス → 状態。非リポジトリ・変更なしは空。
  gitStatuses: Record<string, GitFileStatus>

  // 操作。
  openFolder: () => Promise<void>
  // 最近開いた一覧を main から取得して反映する。
  loadRecentFolders: () => Promise<void>
  // 前回フォルダ（最新の最近開いた一覧）を自動で開き直す。起動時に呼ぶ。
  restoreLastFolder: () => Promise<void>
  // 指定パスのフォルダを開く（最近開いた一覧からの選択）。
  openFolderByPath: (path: string) => Promise<void>
  toggleDir: (relPath: string) => Promise<void>
  openFile: (node: FileNode) => Promise<void>
  // project root 相対パスを指定してファイルを開く（プレビュー内リンク等から呼ぶ）。
  // 開けない（存在しない・ディレクトリ・root 外）場合は何もしない。
  openFileByRelPath: (relPath: string) => Promise<void>
  // ファイル履歴を 1 つ戻る / 進む。端にいるときは何もしない。
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  // エディタの編集内容を反映する。
  updateContent: (content: string) => void
  // 現在のファイルを保存する。binary / 未選択 / 未変更時は何もしない。
  saveActiveFile: () => Promise<void>
  // file watcher の変更バッチを反映する（ツリー更新 + 開いているファイルへの反映）。
  applyFsChanges: (batch: FsEventBatch) => Promise<void>
  // 開いているファイルをディスクから読み直す（外部変更の取り込み）。
  reloadActiveFromDisk: () => Promise<void>
  // 外部変更の衝突通知を閉じる（自分の編集を保持する）。
  dismissExternalChange: () => void
  // ファイル/フォルダをリネームする。開いているファイルが対象（配下含む）なら追従させる。
  // ツリー自体は file watcher の変更通知で更新される。
  renamePath: (relPath: string, newName: string) => Promise<void>
  // 隠しファイルの表示設定を切り替える（localStorage にも保存する）。
  setShowHidden: (show: boolean) => void
  // 「変更ファイルのみ表示」設定を切り替える（localStorage にも保存する）。
  setShowOnlyChanged: (show: boolean) => void
  // Git status を main から取得し直してツリー表示に反映する。
  refreshGitStatus: () => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  rootName: null,
  childrenByDir: {},
  expandedDirs: new Set(),
  activeFile: null,
  history: [],
  historyIndex: -1,
  recentFolders: [],
  // 起動直後は root 未確定のため既定値で初期化し、フォルダを開いた時点で root 別の値に切り替える。
  showHidden: loadShowHidden(null),
  showOnlyChanged: loadShowOnlyChanged(null),
  gitStatuses: {},

  // フォルダを開き、ルート直下を読み込む。
  openFolder: async () => {
    const result = await window.api.openFolder()
    await applyOpenResult(result, set)
    await get().refreshGitStatus()
    await get().loadRecentFolders()
  },

  // 最近開いた一覧を main から取得して反映する。
  loadRecentFolders: async () => {
    const recent = await window.api.getRecentFolders()
    set({ recentFolders: recent })
  },

  // 前回フォルダを自動で開き直す。存在しなければ何もしない（一覧は main 側で掃除される）。
  restoreLastFolder: async () => {
    const recent = await window.api.getRecentFolders()
    set({ recentFolders: recent })
    const last = recent[0]
    if (!last) return
    const result = await window.api.openFolderByPath({ path: last })
    await applyOpenResult(result, set)
    await get().refreshGitStatus()
    // 開けずに一覧から除外された場合に備えて再取得する。
    await get().loadRecentFolders()
  },

  // 指定パスのフォルダを開く（最近開いた一覧からの選択）。
  openFolderByPath: async (path: string) => {
    const result = await window.api.openFolderByPath({ path })
    await applyOpenResult(result, set)
    await get().refreshGitStatus()
    await get().loadRecentFolders()
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

  // ファイルを開いて中央ペインに表示する（バイナリは OS の既定アプリで開く）。
  openFile: async (node: FileNode) => {
    if (node.isDirectory) return
    await openFileInternal(node.relPath, node.name, get, set)
  },

  // project root 相対パスを指定してファイルを開く。
  // explorer の openFile と同じ共通処理を使い、挙動を揃える。
  openFileByRelPath: async (relPath: string) => {
    try {
      const name = relPath.slice(relPath.lastIndexOf('/') + 1)
      await openFileInternal(relPath, name, get, set)
    } catch {
      // 読めない（存在しない・ディレクトリ・root 外を main が拒否）場合は何もしない。
    }
  },

  // ファイル履歴を 1 つ戻る。先頭にいるときは何もしない。
  // 履歴移動なので recordHistory=false で開き、履歴は書き換えない。
  goBack: async () => {
    const { history, historyIndex } = get()
    if (historyIndex <= 0) return
    const newIndex = historyIndex - 1
    const relPath = history[newIndex]
    const name = relPath.slice(relPath.lastIndexOf('/') + 1)
    set({ historyIndex: newIndex })
    try {
      await openFileInternal(relPath, name, get, set, false)
    } catch {
      // 履歴上のファイルが削除された等で開けない場合は index だけ移動した状態にする。
    }
  },

  // ファイル履歴を 1 つ進む。末尾にいるときは何もしない。
  goForward: async () => {
    const { history, historyIndex } = get()
    if (historyIndex >= history.length - 1) return
    const newIndex = historyIndex + 1
    const relPath = history[newIndex]
    const name = relPath.slice(relPath.lastIndexOf('/') + 1)
    set({ historyIndex: newIndex })
    try {
      await openFileInternal(relPath, name, get, set, false)
    } catch {
      // 同上。開けない場合も index は進めた状態にする。
    }
  },

  // エディタの編集内容をストアに反映する。
  updateContent: (content: string) => {
    const { activeFile } = get()
    if (!activeFile) return
    set({ activeFile: { ...activeFile, content } })
  },

  // 現在のファイルを保存する。
  saveActiveFile: async () => {
    const { activeFile } = get()
    if (!activeFile || activeFile.isBinary) return
    if (activeFile.content === activeFile.savedContent) return
    // 保存する内容を固定しておき、保存中の追加編集と取り違えないようにする。
    const contentToSave = activeFile.content
    await window.api.writeFile({ relPath: activeFile.relPath, content: contentToSave })
    // 保存対象が依然 active な場合のみ savedContent を同期する。
    const current = get().activeFile
    if (current && current.relPath === activeFile.relPath) {
      // 自分の保存で衝突フラグが残っていれば解消する。
      set({
        activeFile: {
          ...current,
          savedContent: contentToSave,
          externallyChanged: false,
          externallyDeleted: false
        }
      })
    }
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

    // 2. 開いているファイルへの反映。
    const active = get().activeFile
    if (!active) return
    const change = batch.changes.find((c) => c.relPath === active.relPath)
    if (!change) return

    if (change.kind === 'unlink') {
      // 削除: バッファは保持し、削除されたことだけ通知する。
      set({ activeFile: { ...active, externallyDeleted: true } })
      return
    }
    if (change.kind === 'change' || change.kind === 'add') {
      if (isDirty(active)) {
        // dirty: 上書きせず衝突を通知する（spec 受け入れ条件 4.4）。
        set({ activeFile: { ...active, externallyChanged: true } })
      } else {
        // not dirty: 自動でディスクの内容に追従する。
        await get().reloadActiveFromDisk()
      }
    }
  },

  // 開いているファイルをディスクから読み直す。
  reloadActiveFromDisk: async () => {
    const active = get().activeFile
    if (!active) return
    try {
      const result = await window.api.readFile({ relPath: active.relPath })
      const current = get().activeFile
      if (current && current.relPath === active.relPath) {
        set({
          activeFile: {
            ...current,
            content: result.content,
            savedContent: result.content,
            isBinary: result.isBinary,
            externallyChanged: false,
            externallyDeleted: false
          }
        })
      }
    } catch {
      // 読めない（削除された等）場合は削除フラグに倒す。
      const current = get().activeFile
      if (current && current.relPath === active.relPath) {
        set({ activeFile: { ...current, externallyDeleted: true } })
      }
    }
  },

  // 外部変更の衝突 / 削除通知を閉じる（自分の編集を保持する）。
  dismissExternalChange: () => {
    const active = get().activeFile
    if (!active) return
    set({ activeFile: { ...active, externallyChanged: false, externallyDeleted: false } })
  },

  // ファイル/フォルダをリネームする。
  // 開いているファイルがリネーム対象そのもの、またはリネームしたフォルダ配下なら relPath を付け替える。
  renamePath: async (relPath: string, newName: string) => {
    const result = await window.api.renamePath({ relPath, newName })
    const active = get().activeFile
    if (!active) return
    if (active.relPath === relPath) {
      // 対象ファイルそのものを開いていた場合は新しいパス・名前に追従する。
      set({ activeFile: { ...active, relPath: result.relPath, name: newName } })
    } else if (active.relPath.startsWith(`${relPath}/`)) {
      // リネームしたフォルダ配下のファイルを開いていた場合は接頭辞を付け替える。
      const suffix = active.relPath.slice(relPath.length)
      set({ activeFile: { ...active, relPath: `${result.relPath}${suffix}` } })
    }
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
  }
}))
