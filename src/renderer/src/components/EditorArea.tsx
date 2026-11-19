import { useWorkspaceStore, isDirty } from '../store/workspace'
import EditorPane from './EditorPane'

// 中央のエディタ領域。基本は 1 枚（タブバーは出さず従来と同じ見た目）で、
// エクスプローラーの ⌥クリック / 右クリックの「新しいタブで開く」で 2 枚以上になり、
// タブバーが現れて切り替えられる。
// 非アクティブなタブもマウントしたまま隠す。表示モード（Edit/Preview）・スクロール・
// カーソル・undo 履歴・未保存の編集を、切り替えても保つため。
function EditorArea({ onClose }: { onClose: () => void }): JSX.Element {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const files = useWorkspaceStore((s) => s.files)
  const activeTabId = useWorkspaceStore((s) => s.activeTabId)
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab)
  const closeTab = useWorkspaceStore((s) => s.closeTab)

  return (
    <div className="editor-area">
      {tabs.length > 1 && (
        <div className="editor-tabs" role="tablist">
          {tabs.map((tab) => {
            const file = tab.relPath ? files[tab.relPath] : null
            const active = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                className={`editor-tab${active ? ' active' : ''}`}
                title={tab.relPath ?? undefined}
                onMouseDown={(e) => {
                  // 左クリックで切り替え、中クリックで閉じる（ブラウザのタブと同じ）。
                  if (e.button === 0) setActiveTab(tab.id)
                  else if (e.button === 1) {
                    e.preventDefault()
                    closeTab(tab.id)
                  }
                }}
              >
                <span className="editor-tab-name">{file?.name ?? '（未選択）'}</span>
                {isDirty(file) && (
                  <span className="dirty-indicator" title="未保存の変更があります">
                    ●
                  </span>
                )}
                <button
                  type="button"
                  className="editor-tab-close"
                  aria-label="タブを閉じる"
                  title="タブを閉じる"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div className="editor-tab-bodies">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`editor-tab-body${tab.id === activeTabId ? ' active' : ''}`}
          >
            <EditorPane tabId={tab.id} onClose={onClose} />
          </div>
        ))}
      </div>
    </div>
  )
}

export default EditorArea
