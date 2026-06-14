import { create } from 'zustand'
import type { FileNode } from '../../../shared/ipc'

// 開いているファイルの状態。Step 3 以降で dirty 管理などを拡張する。
export interface OpenFile {
  relPath: string
  name: string
  content: string
  isBinary: boolean
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
        isBinary: result.isBinary
      }
    })
  }
}))
