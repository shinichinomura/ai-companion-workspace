import { useEffect, useState } from 'react'
import type { TabsState } from '../../../shared/ipc'
import { APP_VERSION, buildDetail } from '../../../shared/build-info'

// クロームシェル本体。タブバーを描画し、タブの新規作成・切替・クローズを main に依頼する。
// タブの状態（一覧・アクティブ）は main が真値として持ち、tabs:state push で受け取る。
function Shell(): JSX.Element {
  const [state, setState] = useState<TabsState>({ tabs: [], activeId: null })

  useEffect(() => {
    // main からのタブ状態更新を購読する。マウント時に現在状態を要求する。
    const unsubscribe = window.api.onTabsState((s) => setState(s))
    window.api.requestTabsState()
    return unsubscribe
  }, [])

  return (
    <div className="tabbar">
      <div className="tabs">
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === state.activeId ? 'tab active' : 'tab'}
            title={tab.title}
            onMouseDown={(e) => {
              // 中クリックでタブを閉じる（最後の 1 枚は閉じない）。
              if (e.button === 1 && state.tabs.length > 1) {
                e.preventDefault()
                window.api.closeTab(tab.id)
              } else if (e.button === 0) {
                window.api.activateTab(tab.id)
              }
            }}
          >
            {tab.dirty && <span className="tab-dirty" />}
            {/* このタブ内に未確認（ベルが鳴ったが未表示）のターミナルがあると印を出す。
                通知を閉じても、該当ターミナルを開くまで残る。 */}
            {tab.attention && (
              <span className="tab-attention" title="操作待ちのターミナルがあります" />
            )}
            <span className="tab-title">{tab.title}</span>
            {state.tabs.length > 1 && (
              <button
                className="tab-close"
                title="タブを閉じる"
                onMouseDown={(e) => {
                  // タブ本体の onMouseDown（=切替）に伝播させない。
                  e.stopPropagation()
                  e.preventDefault()
                  window.api.closeTab(tab.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <button className="tab-new" title="新しいタブ" onClick={() => window.api.newTab()}>
        +
      </button>
      {/* 動いているビルドのバージョン。ツールチップに git ハッシュ + ビルド日時を出す。 */}
      <div className="shell-version" title={`ビルド: ${buildDetail()}`}>
        v{APP_VERSION}
      </div>
    </div>
  )
}

export default Shell
