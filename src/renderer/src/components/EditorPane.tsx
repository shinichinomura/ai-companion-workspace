import { useWorkspaceStore } from '../store/workspace'

// 中央ペイン: エディタ / ビューワー。
// Step 2 では読み込んだ内容を読み取り専用で表示する。Step 3 で Monaco Editor に置き換える。
function EditorPane(): JSX.Element {
  const activeFile = useWorkspaceStore((s) => s.activeFile)

  return (
    <div className="pane-inner">
      <div className="pane-header">{activeFile ? activeFile.name : 'Editor'}</div>
      <div className="pane-body editor-body">
        {!activeFile ? (
          <div className="placeholder">ファイルが選択されていません</div>
        ) : activeFile.isBinary ? (
          <div className="placeholder">
            バイナリまたは巨大なファイルのため表示できません
          </div>
        ) : (
          <pre className="editor-pre">{activeFile.content}</pre>
        )}
      </div>
    </div>
  )
}

export default EditorPane
