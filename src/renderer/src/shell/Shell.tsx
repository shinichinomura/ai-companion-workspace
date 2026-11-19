import { useEffect, useState } from 'react'
import type { TabsState } from '../../../shared/ipc'
import { APP_VERSION, buildDetail } from '../../../shared/build-info'

// クロームシェル本体。タブバーを描画し、タブの新規作成・切替・クローズを main に依頼する。
// タブの状態（一覧・アクティブ）は main が真値として持ち、tabs:state push で受け取る。
function Shell(): JSX.Element {
  const [state, setState] = useState<TabsState>({ tabs: [], activeId: null })
  // ドラッグ中のタブ id と、挿入位置（タブ間の隙間の番号 0..tabs.length）。
  const [dragId, setDragId] = useState<number | null>(null)
  const [gap, setGap] = useState<number | null>(null)

  const endDrag = (): void => {
    setDragId(null)
    setGap(null)
  }

  // 隙間番号を「ドラッグ元を取り除いた後の位置」に直して main に並べ替えを依頼する。
  const dropAt = (g: number): void => {
    const from = state.tabs.findIndex((t) => t.id === dragId)
    if (from !== -1) {
      const to = g > from ? g - 1 : g
      if (to !== from) window.api.reorderTab(state.tabs[from].id, to)
    }
    endDrag()
  }

  useEffect(() => {
    // main からのタブ状態更新を購読する。マウント時に現在状態を要求する。
    const unsubscribe = window.api.onTabsState((s) => setState(s))
    window.api.requestTabsState()
    return unsubscribe
  }, [])

  return (
    <div className="tabbar">
      <div className="tabs">
        {state.tabs.map((tab, i) => (
          <div
            key={tab.id}
            className={[
              'tab',
              tab.id === state.activeId ? 'active' : '',
              tab.id === dragId ? 'dragging' : '',
              gap === i && dragId !== null ? 'drop-before' : '',
              gap === i + 1 && i === state.tabs.length - 1 && dragId !== null ? 'drop-after' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            title={tab.title}
            draggable
            onDragStart={(e) => {
              setDragId(tab.id)
              e.dataTransfer.effectAllowed = 'move'
              // 他アプリへのドロップで意味を持たないよう、識別用の最小データだけ載せる。
              e.dataTransfer.setData('text/plain', tab.title)
            }}
            onDragOver={(e) => {
              if (dragId === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              // カーソルがタブの左半分なら手前、右半分なら後ろに挿入する。
              const rect = e.currentTarget.getBoundingClientRect()
              const g = e.clientX < rect.left + rect.width / 2 ? i : i + 1
              if (g !== gap) setGap(g)
            }}
            onDrop={(e) => {
              if (dragId === null || gap === null) return
              e.preventDefault()
              dropAt(gap)
            }}
            onDragEnd={endDrag}
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
