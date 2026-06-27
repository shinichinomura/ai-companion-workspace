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

// 折りたたみ時に残すターミナルヘッダーバーの高さ（CSS の .terminal-header と合わせる）。
const TERMINAL_HEADER_PX = 30

// UI 設定（レイアウト・ターミナル折りたたみ・ペイン幅）は localStorage に保存するが、
// 全タブが localStorage を共有するため、root（プロジェクト）をキーに含めてタブ単位で分ける。
function layoutKey(root: string | null): string {
  return `work-layout:${root ?? '__none__'}`
}
function collapsedKey(root: string | null): string {
  return `terminal-collapsed:${root ?? '__none__'}`
}

// localStorage から、指定 root のレイアウトを復元する（不正値は左右にフォールバック）。
function loadLayout(root: string | null): WorkLayout {
  return localStorage.getItem(layoutKey(root)) === 'vertical' ? 'vertical' : 'horizontal'
}

// localStorage から、指定 root のターミナル折りたたみ状態を復元する。
function loadCollapsed(root: string | null): boolean {
  return localStorage.getItem(collapsedKey(root)) === 'true'
}

// アプリ全体のシェル。spec 2.1 の 3 ペイン構成（Explorer / Editor / Terminal）。
// ペイン幅はドラッグで調整できる（spec 4.2 アプリ全体）。
function App(): JSX.Element {
  const applyFsChanges = useWorkspaceStore((s) => s.applyFsChanges)
  const restoreLastFolder = useWorkspaceStore((s) => s.restoreLastFolder)
  const openFolder = useWorkspaceStore((s) => s.openFolder)
  const openFolderByPath = useWorkspaceStore((s) => s.openFolderByPath)
  const refreshGitStatus = useWorkspaceStore((s) => s.refreshGitStatus)
  const goBack = useWorkspaceStore((s) => s.goBack)
  const goForward = useWorkspaceStore((s) => s.goForward)
  const loadSettings = useSettingsStore((s) => s.load)
  // 現在のプロジェクト root。UI 設定（レイアウト等）の保存キーに使う。
  const root = useWorkspaceStore((s) => s.root)
  // react-resizable-panels の autoSaveId / 再マウント key に使う root 識別子。
  const rootKey = root ?? '__none__'

  // 設定モーダルの表示状態。アプリメニューの「設定…」で開く。
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Editor / Terminal の並べ方。ネイティブの「表示」メニューで切り替え、root 別に localStorage 保存する。
  // 起動直後は root 未確定のため既定値で初期化し、フォルダを開いた時点で root 別の値へ切り替える。
  const [layout, setLayout] = useState<WorkLayout>(() => loadLayout(null))

  // ターミナルペインの折りたたみ状態。閉じてもヘッダーバーだけは残す。
  // PTY を生かしたまま畳むため、Panel を collapsible にしてサイズだけを縮める（再マウントしない）。
  const [terminalCollapsed, setTerminalCollapsed] = useState(() => loadCollapsed(null))
  // 折りたたみ時の Panel サイズ（%）。ヘッダーバーの高さがレイアウト方向の実サイズに対して
  // 何 % になるかを実測して求める。
  const [collapsedSize, setCollapsedSize] = useState(6)
  const terminalPanelRef = useRef<ImperativePanelHandle>(null)
  const workRef = useRef<HTMLDivElement>(null)

  // work エリアの実寸からヘッダーバー相当の % を算出する。レイアウト方向で測る軸を変える。
  // ターミナル以外の場所にファイルをドロップすると Chromium が file:// に遷移して
  // アプリ画面が壊れてしまう。ウィンドウ全体で既定のドロップ動作を抑止する。
  // 実際のドロップ受付は各コンポーネント（ターミナル等）が個別に preventDefault する。
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  // マウスのサイドボタン（戻る/進む）でファイル履歴を移動する。
  // Chromium は button 3=戻る / 4=進む を既定でページ履歴ナビゲーションに使うため、
  // preventDefault でその既定動作（SPA からの離脱）を抑止し、自前の履歴移動に振り替える。
  // capture フェーズで拾い、各ペイン（エディタ・ターミナル等）より先に処理する。
  useEffect(() => {
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault()
        void goBack()
      } else if (e.button === 4) {
        e.preventDefault()
        void goForward()
      }
    }
    // mousedown 側でも既定動作が走る環境があるため、両方で抑止する（実処理は mouseup のみ）。
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 3 || e.button === 4) e.preventDefault()
    }
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('mousedown', onMouseDown, true)
    return () => {
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [goBack, goForward])

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

  // 左右並べ（horizontal）ではターミナルの最小化ボタンを隠すため、畳んだまま
  // 横並びに切り替わると解除できなくなる。横並びにしたら自動で展開して最小化を解除する。
  // 上の collapse 用 effect より後に置き、同一コミット内で expand を後勝ちにする。
  useEffect(() => {
    if (layout === 'horizontal' && terminalCollapsed) {
      terminalPanelRef.current?.expand()
    }
  }, [layout, terminalCollapsed])

  // ヘッダーのアイコンから呼ぶ開閉トグル。
  const toggleTerminal = (): void => {
    const panel = terminalPanelRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }

  // root（開いているプロジェクト）が変わったら、そのプロジェクトの UI 設定を読み直し、
  // レイアウトの現在値を main に通知してメニューのチェックを同期する。
  useEffect(() => {
    const nextLayout = loadLayout(root)
    setLayout(nextLayout)
    setTerminalCollapsed(loadCollapsed(root))
    window.api.reportWorkLayout(nextLayout)
  }, [root])

  // 表示メニューからのレイアウト切り替えを購読し、状態と root 別 localStorage に反映する。
  // root が変わるたびに張り直し、保存キーが現在の root を指すようにする。
  useEffect(() => {
    const unsubscribe = window.api.onSetWorkLayout((next) => {
      setLayout(next)
      localStorage.setItem(layoutKey(root), next)
    })
    return unsubscribe
  }, [root])

  // 「ファイル」メニューの「フォルダを開く」を購読し、フォルダ選択を開く。
  useEffect(() => {
    const unsubscribe = window.api.onRequestOpenFolder(() => {
      void openFolder()
    })
    return unsubscribe
  }, [openFolder])

  // 「最近使ったフォルダ」メニューを購読し、アクティブタブで指定パスを開く。
  useEffect(() => {
    const unsubscribe = window.api.onRequestOpenFolderByPath((path) => {
      void openFolderByPath(path)
    })
    return unsubscribe
  }, [openFolderByPath])

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

  // タブ起動時の初期動作。main が query で指示する:
  //   ?root=<path> … 指定フォルダを開く（セッション復元・特定フォルダ起動）
  //   ?restore=1   … 前回フォルダを自動で開き直す（初期タブ。spec 4.2）
  //   いずれも無し  … 新規タブ。何も開かず最近開いたフォルダ一覧を表示する。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const root = params.get('root')
    if (root) void openFolderByPath(root)
    else if (params.get('restore') === '1') void restoreLastFolder()
  }, [openFolderByPath, restoreLastFolder])

  return (
    <div className="app">
      {/* タブストリップ（タイトルバー）はクロームシェル側に移したため、ここでは描画しない。
          各タブビューはストリップの下に配置されるので信号機との干渉も無い。 */}
      {/* ペイン幅も root（プロジェクト）別に保存する。autoSaveId を root 別にし、
          root が変わったら key で貼り直して保存済みサイズを読み直す。
          root 変更（= タブ内でのフォルダ切替）は頻度が低く、その際は元々ターミナルも
          再起動するため、再マウントの副作用は問題にならない。レイアウト方向(左右/上下)の
          切替は rootKey を変えないので、内側 PanelGroup は再マウントされず PTY を保つ。 */}
      <PanelGroup
        key={`outer-${rootKey}`}
        direction="horizontal"
        autoSaveId={`outer-layout:${rootKey}`}
      >
        <Panel defaultSize={20} minSize={12} className="pane pane--soft">
          <FileExplorer />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={80} minSize={30}>
          {/* Editor と Terminal は内側の PanelGroup でまとめ、方向だけを切り替える。
              key を付けて再マウントすると Terminal の PTY が破棄されてしまうため、
              direction prop の変更だけで切り替える（v2 は再マウント不要。サイズは % で保持され方向を変えても崩れない）。
              ヘッダー相当 % を実測するため PanelGroup を div でラップして寸法を測る。 */}
          <div className="work-area" ref={workRef}>
            <PanelGroup direction={layout} autoSaveId={`work-layout:${rootKey}`} className="work-group">
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
                  localStorage.setItem(collapsedKey(root), 'true')
                }}
                onExpand={() => {
                  setTerminalCollapsed(false)
                  localStorage.setItem(collapsedKey(root), 'false')
                }}
                className="pane pane--soft"
              >
                <TerminalPane
                  collapsed={terminalCollapsed}
                  onToggle={toggleTerminal}
                  layout={layout}
                />
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
