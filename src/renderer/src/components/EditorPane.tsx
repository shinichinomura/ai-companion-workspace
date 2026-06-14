import { useWorkspaceStore, isDirty } from '../store/workspace'
import MonacoEditor from './MonacoEditor'

// 中央ペイン: エディタ / ビューワー。Monaco Editor でテキスト編集と保存を行う。
function EditorPane(): JSX.Element {
  const activeFile = useWorkspaceStore((s) => s.activeFile)
  const updateContent = useWorkspaceStore((s) => s.updateContent)
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile)
  const reloadActiveFromDisk = useWorkspaceStore((s) => s.reloadActiveFromDisk)
  const dismissExternalChange = useWorkspaceStore((s) => s.dismissExternalChange)

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
      {activeFile?.externallyChanged && (
        <div className="conflict-banner">
          <span className="conflict-msg">
            このファイルは外部で変更されました。未保存の編集があります。
          </span>
          <button className="btn" onClick={() => void reloadActiveFromDisk()}>
            外部変更を読み込む（編集を破棄）
          </button>
          <button className="btn" onClick={() => dismissExternalChange()}>
            自分の変更を保持
          </button>
        </div>
      )}
      {activeFile?.externallyDeleted && (
        <div className="conflict-banner">
          <span className="conflict-msg">
            このファイルは外部で削除されました。保存すると再作成されます。
          </span>
          <button className="btn" onClick={() => dismissExternalChange()}>
            通知を閉じる
          </button>
        </div>
      )}
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
