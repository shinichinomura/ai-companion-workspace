import { useEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import FileExplorer from './components/FileExplorer'
import EditorPane from './components/EditorPane'
import TerminalPane from './components/TerminalPane'
import SettingsModal from './components/SettingsModal'
import { useWorkspaceStore } from './store/workspace'
import { useSettingsStore } from './store/settings'
import type { WorkLayout } from '../../shared/ipc'

const LAYOUT_STORAGE_KEY = 'work-layout'
const TERMINAL_COLLAPSED_KEY = 'terminal-collapsed'

// 折りたたみ時に残すターミナルヘッダーバーの高さ（CSS の .terminal-header と合わせる）。
const TERMINAL_HEADER_PX = 30

// localStorage から初期レイアウトを復元する（不正値は左右にフォールバック）。
function loadLayout(): WorkLayout {
  return localStorage.getItem(LAYOUT_STORAGE_KEY) === 'vertical' ? 'vertical' : 'horizontal'
}

// アプリ全体のシェル。spec 2.1 の 3 ペイン構成（Explorer / Editor / Terminal）。
// ペイン幅はドラッグで調整できる（spec 4.2 アプリ全体）。
function App(): JSX.Element {
  const applyFsChanges = useWorkspaceStore((s) => s.applyFsChanges)
  const restoreLastFolder = useWorkspaceStore((s) => s.restoreLastFolder)
  const openFolder = useWorkspaceStore((s) => s.openFolder)
  const setShowHidden = useWorkspaceStore((s) => s.setShowHidden)
  const refreshGitStatus = useWorkspaceStore((s) => s.refreshGitStatus)
  const loadSettings = useSettingsStore((s) => s.load)

  // 設定モーダルの表示状態。アプリメニューの「設定…」で開く。
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Editor / Terminal の並べ方。ネイティブの「表示」メニューで切り替え、localStorage に保存する。
  const [layout, setLayout] = useState<WorkLayout>(loadLayout)

  // ターミナルペインの折りたたみ状態。閉じてもヘッダーバーだけは残す。
  // PTY を生かしたまま畳むため、Panel を collapsible にしてサイズだけを縮める（再マウントしない）。
  const [terminalCollapsed, setTerminalCollapsed] = useState(
    () => localStorage.getItem(TERMINAL_COLLAPSED_KEY) === 'true'
  )
  // 折りたたみ時の Panel サイズ（%）。ヘッダーバーの高さがレイアウト方向の実サイズに対して
  // 何 % になるかを実測して求める。
  const [collapsedSize, setCollapsedSize] = useState(6)
  const terminalPanelRef = useRef<ImperativePanelHandle>(null)
  const workRef = useRef<HTMLDivElement>(null)

  // work エリアの実寸からヘッダーバー相当の % を算出する。レイアウト方向で測る軸を変える。
  useEffect(() => {
    const el = workRef.current
    if (!el) return
    const recompute = (): void => {
      const rect = el.getBoundingClientRect()
      const px = layout === 'vertical' ? rect.height : rect.width
      if (px <= 0) return
      setCollapsedSize(Math.min(50, Math.max(2, (TERMINAL_HEADER_PX / px) * 100)))
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [layout])

  // collapsedSize が変わったとき（ウィンドウリサイズ・レイアウト切替）に、
  // 折りたたみ中なら新しいサイズで畳み直してヘッダー高さを一定に保つ。
  useEffect(() => {
    if (terminalCollapsed) terminalPanelRef.current?.collapse()
  }, [collapsedSize, terminalCollapsed])

  // ヘッダーのアイコンから呼ぶ開閉トグル。
  const toggleTerminal = (): void => {
    const panel = terminalPanelRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }

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

  // 「表示」メニューの隠しファイル表示トグルを購読し、状態と localStorage に反映する。
  // マウント時に現在の設定を main へ通知してメニューのチェックを同期する。
  useEffect(() => {
    window.api.reportShowHidden(useWorkspaceStore.getState().showHidden)
    const unsubscribe = window.api.onSetShowHidden((show) => {
      setShowHidden(show)
    })
    return unsubscribe
  }, [setShowHidden])

  // 「ファイル」メニューの「フォルダを開く」を購読し、フォルダ選択を開く。
  useEffect(() => {
    const unsubscribe = window.api.onRequestOpenFolder(() => {
      void openFolder()
    })
    return unsubscribe
  }, [openFolder])

  // file watcher の変更通知を購読し、ツリー / エディタに反映する（spec 2.2.5）。
  useEffect(() => {
    const unsubscribe = window.api.onFsEvent((batch) => {
      void applyFsChanges(batch)
    })
    return unsubscribe
  }, [applyFsChanges])

  // .git の変化（ターミナルでの commit / add / checkout 等）を購読し、Git status を取り直す。
  useEffect(() => {
    const unsubscribe = window.api.onGitStatusChanged(() => {
      void refreshGitStatus()
    })
    return unsubscribe
  }, [refreshGitStatus])

  // 起動時にアプリ設定を読み込む（クイック操作のボタン定義など）。
  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // アプリメニューの「設定…」を購読し、設定モーダルを開く。
  useEffect(() => {
    const unsubscribe = window.api.onOpenSettings(() => setSettingsOpen(true))
    return unsubscribe
  }, [])

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
              direction prop の変更だけで切り替える（v2 は再マウント不要。サイズは % で保持され方向を変えても崩れない）。
              ヘッダー相当 % を実測するため PanelGroup を div でラップして寸法を測る。 */}
          <div className="work-area" ref={workRef}>
            <PanelGroup direction={layout} autoSaveId="work-layout" className="work-group">
              <Panel defaultSize={60} minSize={20} className="pane">
                <EditorPane />
              </Panel>
              <PanelResizeHandle className="resize-handle" />
              {/* collapsible にしてサイズを縮めるだけ。中身（PTY）はマウントしたまま保持する。 */}
              <Panel
                ref={terminalPanelRef}
                defaultSize={40}
                minSize={15}
                collapsible
                collapsedSize={collapsedSize}
                onCollapse={() => {
                  setTerminalCollapsed(true)
                  localStorage.setItem(TERMINAL_COLLAPSED_KEY, 'true')
                }}
                onExpand={() => {
                  setTerminalCollapsed(false)
                  localStorage.setItem(TERMINAL_COLLAPSED_KEY, 'false')
                }}
                className="pane"
              >
                <TerminalPane collapsed={terminalCollapsed} onToggle={toggleTerminal} />
              </Panel>
            </PanelGroup>
          </div>
        </Panel>
      </PanelGroup>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

export default App
