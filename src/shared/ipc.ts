// main / preload / renderer で共有する IPC の型定義とチャンネル名。

// IPC チャンネル名。文字列のタイポを防ぐため定数化する。
export const IpcChannel = {
  OpenFolder: 'workspace:open-folder',
  ReadDir: 'workspace:read-dir',
  ReadFile: 'workspace:read-file',
  WriteFile: 'workspace:write-file'
} as const

// ファイルツリーの 1 ノード。ディレクトリは遅延展開するため children は持たない。
export interface FileNode {
  // project root からの相対パス（'/' 区切り）。ルート自身は ''。
  relPath: string
  name: string
  isDirectory: boolean
}

// Open Folder の結果。キャンセル時は null。
export interface OpenFolderResult {
  root: string // 選択されたフォルダの絶対パス
  name: string // 表示用のフォルダ名
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

// renderer に公開する API の型。preload で実装し window.api として参照する。
export interface WorkspaceApi {
  openFolder: () => Promise<OpenFolderResult | null>
  readDir: (req: ReadDirRequest) => Promise<FileNode[]>
  readFile: (req: ReadFileRequest) => Promise<ReadFileResult>
  writeFile: (req: WriteFileRequest) => Promise<WriteFileResult>
}
