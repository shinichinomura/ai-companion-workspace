import { create } from 'zustand'
import type { FileNode } from '../../../shared/ipc'

// 開いているファイルの状態。
export interface OpenFile {
  relPath: string
  name: string
  // 現在エディタに表示している内容（編集で変化する）。
  content: string
  // 直近に保存（または読み込み）した内容。dirty 判定の基準。
  savedContent: string
  isBinary: boolean
}

// 未保存変更があるか。content と savedContent の差分で判定する。
export function isDirty(file: OpenFile | null): boolean {
  return file != null && !file.isBinary && file.content !== file.savedContent
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

  // 操作。
  openFolder: () => Promise<void>
  toggleDir: (relPath: string) => Promise<void>
  openFile: (node: FileNode) => Promise<void>
  // エディタの編集内容を反映する。
  updateContent: (content: string) => void
  // 現在のファイルを保存する。binary / 未選択 / 未変更時は何もしない。
  saveActiveFile: () => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  rootName: null,
  childrenByDir: {},
  expandedDirs: new Set(),
  activeFile: null,

  // フォルダを開き、ルート直下を読み込む。
  openFolder: async () => {
    const result = await window.api.openFolder()
    if (!result) return
    const rootChildren = await window.api.readDir({ relPath: '' })
    set({
      root: result.root,
      rootName: result.name,
      childrenByDir: { '': rootChildren },
      expandedDirs: new Set(),
      activeFile: null
    })
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
      set({ activeFile: { ...current, savedContent: contentToSave } })
    }
  }
}))
