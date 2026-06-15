import { create } from 'zustand'
import type { FileNode, FsEventBatch, OpenFolderResult } from '../../../shared/ipc'

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

// 未保存変更があるか。content と savedContent の差分で判定する。
export function isDirty(file: OpenFile | null): boolean {
  return file != null && !file.isBinary && file.content !== file.savedContent
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
    activeFile: null
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

  // 最近開いたフォルダの絶対パス一覧（新しい順）。
  recentFolders: string[]

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
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  rootName: null,
  childrenByDir: {},
  expandedDirs: new Set(),
  activeFile: null,
  recentFolders: [],

  // フォルダを開き、ルート直下を読み込む。
  openFolder: async () => {
    const result = await window.api.openFolder()
    await applyOpenResult(result, set)
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
    // 開けずに一覧から除外された場合に備えて再取得する。
    await get().loadRecentFolders()
  },

  // 指定パスのフォルダを開く（最近開いた一覧からの選択）。
  openFolderByPath: async (path: string) => {
    const result = await window.api.openFolderByPath({ path })
    await applyOpenResult(result, set)
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

  // ファイルを開いて中央ペインに表示する。
  openFile: async (node: FileNode) => {
    if (node.isDirectory) return
    const result = await window.api.readFile({ relPath: node.relPath })
    set({
      activeFile: {
        relPath: node.relPath,
        name: node.name,
        content: result.content,
        savedContent: result.content,
        isBinary: result.isBinary
      }
    })
  },

  // project root 相対パスを指定してファイルを開く。
  // explorer の openFile と同じく activeFile を差し替えるだけにし、挙動を揃える。
  openFileByRelPath: async (relPath: string) => {
    try {
      const result = await window.api.readFile({ relPath })
      const name = relPath.slice(relPath.lastIndexOf('/') + 1)
      set({
        activeFile: {
          relPath,
          name,
          content: result.content,
          savedContent: result.content,
          isBinary: result.isBinary
        }
      })
    } catch {
      // 読めない（存在しない・ディレクトリ・root 外を main が拒否）場合は何もしない。
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
  }
}))
