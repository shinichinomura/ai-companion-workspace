import { useWorkspaceStore, isDirty } from '../store/workspace'
import MonacoEditor from './MonacoEditor'

// 中央ペイン: エディタ / ビューワー。Monaco Editor でテキスト編集と保存を行う。
function EditorPane(): JSX.Element {
  const activeFile = useWorkspaceStore((s) => s.activeFile)
  const updateContent = useWorkspaceStore((s) => s.updateContent)
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile)

  const dirty = isDirty(activeFile)

  return (
    <div className="pane-inner">
      <div className="pane-header">
        {activeFile ? (
          <>
            {activeFile.name}
            {dirty && <span className="dirty-indicator" title="未保存の変更があります"> ●</span>}
          </>
        ) : (
          'Editor'
        )}
      </div>
      <div className="pane-body editor-body">
        {!activeFile ? (
          <div className="placeholder">ファイルが選択されていません</div>
        ) : activeFile.isBinary ? (
          <div className="placeholder">バイナリまたは巨大なファイルのため表示できません</div>
        ) : (
          <MonacoEditor
            path={activeFile.relPath}
            value={activeFile.content}
            onChange={updateContent}
            onSave={saveActiveFile}
          />
        )}
      </div>
    </div>
  )
}

export default EditorPane
