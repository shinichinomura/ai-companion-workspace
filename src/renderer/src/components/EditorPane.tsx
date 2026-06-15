import { useState } from 'react'
import { useWorkspaceStore, isDirty } from '../store/workspace'
import MonacoEditor from './MonacoEditor'
import MarkdownPreview from './MarkdownPreview'

// Markdown として扱う拡張子か判定する。
function isMarkdown(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

// 中央ペイン: エディタ / ビューワー。Monaco Editor でテキスト編集と保存を行う。
function EditorPane(): JSX.Element {
  const activeFile = useWorkspaceStore((s) => s.activeFile)
  const updateContent = useWorkspaceStore((s) => s.updateContent)
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile)
  const reloadActiveFromDisk = useWorkspaceStore((s) => s.reloadActiveFromDisk)
  const dismissExternalChange = useWorkspaceStore((s) => s.dismissExternalChange)

  const dirty = isDirty(activeFile)
  const markdown = activeFile != null && !activeFile.isBinary && isMarkdown(activeFile.relPath)

  // Edit / Preview の表示状態。ストアに持たせずペイン内で管理する。
  // 表示ファイルを切り替えてもモード選択は維持する。
  const [view, setView] = useState<'edit' | 'preview'>('edit')

  return (
    <div className="pane-inner">
      <div className="pane-header">
        {activeFile ? (
          <>
            {activeFile.name}
            {dirty && <span className="dirty-indicator" title="未保存の変更があります"> ●</span>}
            {markdown && (
              <span className="view-toggle">
                <button
                  className={`view-toggle-btn${view === 'edit' ? ' active' : ''}`}
                  onClick={() => setView('edit')}
                >
                  Edit
                </button>
                <button
                  className={`view-toggle-btn${view === 'preview' ? ' active' : ''}`}
                  onClick={() => setView('preview')}
                >
                  Preview
                </button>
              </span>
            )}
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
      <div className={`pane-body${markdown && view === 'preview' ? '' : ' editor-body'}`}>
        {!activeFile ? (
          <div className="placeholder">ファイルが選択されていません</div>
        ) : activeFile.isBinary ? (
          <div className="placeholder">バイナリまたは巨大なファイルのため表示できません</div>
        ) : markdown && view === 'preview' ? (
          // 編集中の最新内容（content）をプレビューする。
          <MarkdownPreview content={activeFile.content} />
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
