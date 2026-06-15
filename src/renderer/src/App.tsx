import { useEffect, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import FileExplorer from './components/FileExplorer'
import EditorPane from './components/EditorPane'
import TerminalPane from './components/TerminalPane'
import { useWorkspaceStore } from './store/workspace'
import type { WorkLayout } from '../../shared/ipc'

const LAYOUT_STORAGE_KEY = 'work-layout'

// localStorage から初期レイアウトを復元する（不正値は左右にフォールバック）。
function loadLayout(): WorkLayout {
  return localStorage.getItem(LAYOUT_STORAGE_KEY) === 'vertical' ? 'vertical' : 'horizontal'
}

// アプリ全体のシェル。spec 2.1 の 3 ペイン構成（Explorer / Editor / Terminal）。
// ペイン幅はドラッグで調整できる（spec 4.2 アプリ全体）。
function App(): JSX.Element {
  const applyFsChanges = useWorkspaceStore((s) => s.applyFsChanges)
  const restoreLastFolder = useWorkspaceStore((s) => s.restoreLastFolder)

  // Editor / Terminal の並べ方。ネイティブの「表示」メニューで切り替え、localStorage に保存する。
  const [layout, setLayout] = useState<WorkLayout>(loadLayout)

  // 表示メニューからの切り替え通知を購読し、状態と localStorage に反映する。
  // マウント時に現在のレイアウトを main へ通知してメニューのチェックを同期する。
  useEffect(() => {
    window.api.reportWorkLayout(loadLayout())
    const unsubscribe = window.api.onSetWorkLayout((next) => {
      setLayout(next)
      localStorage.setItem(LAYOUT_STORAGE_KEY, next)
    })
    return unsubscribe
  }, [])

  // file watcher の変更通知を購読し、ツリー / エディタに反映する（spec 2.2.5）。
  useEffect(() => {
    const unsubscribe = window.api.onFsEvent((batch) => {
      void applyFsChanges(batch)
    })
    return unsubscribe
  }, [applyFsChanges])

  // 起動時に前回フォルダを自動で開き直す（spec 4.2 最近開いたフォルダの保存）。
  useEffect(() => {
    void restoreLastFolder()
  }, [restoreLastFolder])

  return (
    <div className="app">
      {/* ウィンドウ移動用のトップバー。-webkit-app-region: drag で帯全体を掴めるようにする。
          信号機ボタンの領域を空けるため左に余白を取る（main の trafficLightPosition と対応）。 */}
      <div className="titlebar">
        <span className="titlebar-title">Atelier</span>
      </div>
      <PanelGroup direction="horizontal" autoSaveId="outer-layout">
        <Panel defaultSize={20} minSize={12} className="pane">
          <FileExplorer />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={80} minSize={30}>
          {/* Editor と Terminal は内側の PanelGroup でまとめ、方向だけを切り替える。
              key を付けて再マウントすると Terminal の PTY が破棄されてしまうため、
              direction prop の変更だけで切り替える（v2 は再マウント不要。サイズは % で保持され方向を変えても崩れない）。 */}
          <PanelGroup direction={layout} autoSaveId="work-layout" className="work-group">
            <Panel defaultSize={60} minSize={20} className="pane">
              <EditorPane />
            </Panel>
            <PanelResizeHandle className="resize-handle" />
            <Panel defaultSize={40} minSize={15} className="pane">
              <TerminalPane />
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  )
}

export default App
