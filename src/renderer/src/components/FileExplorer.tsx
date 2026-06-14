import type { FileNode } from '../../../shared/ipc'
import { useWorkspaceStore } from '../store/workspace'

// ツリーの 1 ノード。ディレクトリは展開状態に応じて子を再帰描画する。
function TreeNode({ node, depth }: { node: FileNode; depth: number }): JSX.Element {
  const expandedDirs = useWorkspaceStore((s) => s.expandedDirs)
  const childrenByDir = useWorkspaceStore((s) => s.childrenByDir)
  const activeFile = useWorkspaceStore((s) => s.activeFile)
  const toggleDir = useWorkspaceStore((s) => s.toggleDir)
  const openFile = useWorkspaceStore((s) => s.openFile)

  const isExpanded = node.isDirectory && expandedDirs.has(node.relPath)
  const isActive = !node.isDirectory && activeFile?.relPath === node.relPath
  const children = childrenByDir[node.relPath]

  const handleClick = (): void => {
    if (node.isDirectory) {
      void toggleDir(node.relPath)
    } else {
      void openFile(node)
    }
  }

  return (
    <>
      <div
        className={`tree-row${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleClick}
        title={node.name}
      >
        <span className="tree-twisty">
          {node.isDirectory ? (isExpanded ? '▾' : '▸') : ''}
        </span>
        <span className="tree-icon">{node.isDirectory ? '📁' : '📄'}</span>
        <span className="tree-label">{node.name}</span>
      </div>
      {isExpanded &&
        children?.map((child) => (
          <TreeNode key={child.relPath} node={child} depth={depth + 1} />
        ))}
    </>
  )
}

// 絶対パスから表示用のフォルダ名（末尾セグメント）を取り出す。
function folderName(path: string): string {
  const segs = path.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? path
}

// フォルダ未選択時に表示する、最近開いたフォルダの一覧。
function RecentFolders(): JSX.Element {
  const recentFolders = useWorkspaceStore((s) => s.recentFolders)
  const openFolderByPath = useWorkspaceStore((s) => s.openFolderByPath)

  if (recentFolders.length === 0) {
    return <div className="placeholder">フォルダが開かれていません</div>
  }
  return (
    <div className="recent-list">
      <div className="recent-title">最近開いたフォルダ</div>
      {recentFolders.map((path) => (
        <div
          key={path}
          className="recent-item"
          title={path}
          onClick={() => void openFolderByPath(path)}
        >
          <span className="recent-name">{folderName(path)}</span>
          <span className="recent-path">{path}</span>
        </div>
      ))}
    </div>
  )
}

// 左ペイン: ファイルエクスプローラー。
function FileExplorer(): JSX.Element {
  const rootName = useWorkspaceStore((s) => s.rootName)
  const rootChildren = useWorkspaceStore((s) => s.childrenByDir[''])
  const openFolder = useWorkspaceStore((s) => s.openFolder)

  return (
    <div className="pane-inner">
      <div className="pane-header explorer-header">
        <span className="explorer-title">{rootName ?? 'Explorer'}</span>
        <button className="btn" onClick={() => void openFolder()}>
          {rootName ? '別のフォルダ' : 'フォルダを開く'}
        </button>
      </div>
      <div className="pane-body tree">
        {rootChildren ? (
          rootChildren.map((node) => (
            <TreeNode key={node.relPath} node={node} depth={0} />
          ))
        ) : (
          <RecentFolders />
        )}
      </div>
    </div>
  )
}

export default FileExplorer
