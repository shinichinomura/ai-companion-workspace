import { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useSettingsStore } from '../store/settings'
import type { WorkLayout } from '../../../shared/ipc'
import TerminalInstance, { type TerminalHandle } from './TerminalInstance'

interface TerminalPaneProps {
  // 折りたたみ中か。ヘッダーバーのアイコン向きと本体の表示/非表示に使う。
  collapsed: boolean
  // ヘッダーの開閉アイコンから呼ぶトグル。
  onToggle: () => void
  // Editor / Terminal の並べ方。左右並べ（horizontal）では最小化ボタンを隠す。
  layout: WorkLayout
}

// タブ内の 1 ターミナル。id は PTY と対応する識別子、num は表示用の連番（閉じてもずれない）。
interface TermTab {
  id: string
  num: number
}

// 右ペイン: 統合ターミナル（spec 2.2.4）。
// 1 つのアプリタブ内で複数のターミナルをタブで開ける。各ターミナルは TerminalInstance が
// xterm.js（renderer）と node-pty（main）を IPC で結びつけて保持し、非アクティブなものも
// マウントしたまま隠す（PTY を保持する）。フォルダ未選択時は起動しない。
function TerminalPane({ collapsed, onToggle, layout }: TerminalPaneProps): JSX.Element {
  // project root。未選択ならターミナルは起動しない。root 変更時は App 側で本コンポーネントごと
  // 再マウントされる（rootKey による key 付け）ため、初期状態（ターミナル 1 つ）から作り直る。
  const root = useWorkspaceStore((s) => s.root)
  // 現在ビューワー/エディタで開いているファイル。null なら「@ で渡す」ボタンは無効。
  const activeFile = useWorkspaceStore((s) => s.activeFile)
  // よく使う Git 操作のボタン定義（設定画面で編集可能）。押すとアクティブな統合ターミナルへ prompt を送る。
  // 送信先はユーザーが見ている統合ターミナル。Claude が対話モードで起動している前提の
  // ショートカットで、裏でプロンプトを投入するものではない（spec 設計原則）。
  const quickPrompts = useSettingsStore((s) => s.quickPrompts)

  // ターミナルに振る連番。閉じても再利用せず、表示番号を安定させる。
  const counterRef = useRef(0)
  const makeTab = (): TermTab => {
    counterRef.current += 1
    return { id: `t${counterRef.current}`, num: counterRef.current }
  }

  const [tabs, setTabs] = useState<TermTab[]>(() => [makeTab()])
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id)
  // ベル通知クリックからの「このターミナルを開いて」要求で、存在チェックに使う最新の tabs。
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  // 各ターミナルの終了状態。アクティブなターミナルが終了していたら再起動ボタンを出す。
  const [exited, setExited] = useState<Record<string, boolean>>({})

  // 各 TerminalInstance が登録する操作ハンドル（フォーカス・送信・再起動）。
  const handlesRef = useRef<Map<string, TerminalHandle>>(new Map())
  const setHandle = (id: string, handle: TerminalHandle | null): void => {
    if (handle) handlesRef.current.set(id, handle)
    else handlesRef.current.delete(id)
  }
  const handleExitedChange = (id: string, ex: boolean): void => {
    setExited((m) => ({ ...m, [id]: ex }))
  }

  // 定型プロンプトのメニューを開いているか。
  const [promptMenuOpen, setPromptMenuOpen] = useState(false)
  const promptMenuRef = useRef<HTMLDivElement>(null)

  // 新しいターミナルを追加してアクティブにする。
  const addTerminal = (): void => {
    const t = makeTab()
    setTabs((ts) => [...ts, t])
    setActiveId(t.id)
  }

  // 指定ターミナルを閉じる。最後の 1 つは残す（ペインを空にしない）。
  const closeTerminal = (id: string): void => {
    if (tabs.length <= 1) return
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    // 閉じたのがアクティブなら、隣（できるだけ右、無ければ左）をアクティブにする。
    if (id === activeId) {
      const fallback = next[Math.min(idx, next.length - 1)]
      setActiveId(fallback.id)
    }
    setExited((m) => {
      const c = { ...m }
      delete c[id]
      return c
    })
  }

  // 定型プロンプトをアクティブなターミナルへ送る（末尾に改行 \r を付けて即実行）。
  // 折りたたみ中なら開いて見せる。
  const sendPrompt = (prompt: string): void => {
    if (!root) return
    if (collapsed) onToggle()
    const handle = handlesRef.current.get(activeId)
    handle?.sendText(prompt + '\r')
    handle?.focus()
  }

  // 現在開いているファイルの相対パスを、アクティブなターミナルの入力欄に `@relPath ` として挿入する。
  // relPath は project root 基準＝claude の起動 cwd 基準なので、そのまま claude の @ 参照に使える。
  // 改行は付けない。入力欄に乗るだけで、送信するかどうかはユーザーの Enter に委ねる（自動送信しない・設計原則）。
  const insertActiveFile = (): void => {
    if (!root || !activeFile) return
    if (collapsed) onToggle()
    const handle = handlesRef.current.get(activeId)
    handle?.sendText(`@${activeFile.relPath} `)
    handle?.focus()
  }

  // 終了したアクティブターミナルを再起動する。
  const restartActive = (): void => {
    handlesRef.current.get(activeId)?.restart()
  }

  // 現在アクティブなターミナルを main に報告する。main はこれを使って
  // 「今まさに見ているターミナルが鳴ったとき」だけベル通知を抑制する。
  useEffect(() => {
    window.api.reportActiveTerminal(activeId)
  }, [activeId])

  // ベル通知のクリックで、発生元ターミナル（サブタブ）をアクティブにする。
  // 既に閉じられている場合は何もしない。アプリタブ自体の切替は main 側で行う。
  useEffect(() => {
    const unsubscribe = window.api.onActivateTerminal((id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id)
    })
    return unsubscribe
  }, [])

  // 定型プロンプトのメニューを開いている間は、外側クリックと Escape で閉じる。
  useEffect(() => {
    if (!promptMenuOpen) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!promptMenuRef.current?.contains(e.target as Node | null)) setPromptMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPromptMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [promptMenuOpen])

  return (
    <div className="pane-inner">
      {/* 開閉バー兼タブバー。折りたたんでもこのバーだけは残る。 */}
      <div className="terminal-header">
        {/* ターミナルのタブ。各タブはクリックで切替、× で閉じる。+ で新規追加。 */}
        <div className="terminal-tabs" role="tablist">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`terminal-tab${t.id === activeId ? ' active' : ''}`}
              role="tab"
              aria-selected={t.id === activeId}
              onClick={() => setActiveId(t.id)}
              title={`ターミナル ${t.num}`}
            >
              <span className="terminal-tab-label">
                {/* 終了済みのターミナルは印を付けて分かるようにする。 */}
                {exited[t.id] ? '○ ' : ''}
                {t.num}
              </span>
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="terminal-tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTerminal(t.id)
                  }}
                  title="このターミナルを閉じる"
                  aria-label="このターミナルを閉じる"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {/* 新規ターミナルを追加する。 */}
          <button
            type="button"
            className="terminal-tab-add"
            onClick={addTerminal}
            disabled={!root}
            title="ターミナルを追加"
            aria-label="ターミナルを追加"
          >
            +
          </button>
        </div>

        {/* 現在開いているファイルを、アクティブなターミナルの入力欄に `@パス` として挿入する。
            改行は付けないため、そのまま claude に渡すかどうかはユーザーが Enter で決める。
            ファイル未オープン時は無効。ヘッダー右側（定型プロンプトの左隣）に置く。 */}
        <button
          type="button"
          className="terminal-action-trigger terminal-insert-file"
          onClick={insertActiveFile}
          disabled={!root || !activeFile}
          title={
            activeFile
              ? `@${activeFile.name} をターミナルに挿入（Enter は自分で押す）`
              : 'ファイルを開くと現在のファイルを @ で渡せます'
          }
          aria-label="現在開いているファイルを @ でターミナルに挿入"
        >
          {/* 「@」は claude の `@path` 参照記法そのもの。機能を最も端的に表す。 */}
          <span aria-hidden="true" className="terminal-insert-file-glyph">
            @
          </span>
        </button>

        {/* よく使う Git 操作を Claude に送る定型プロンプト。ヘッダーにはアイコンだけを置き、
            押すと登録済みの選択肢をメニューとして展開する（設定画面で編集可能）。
            ラベルが空の行は表示しない。 */}
        {(() => {
          const items = quickPrompts.filter((q) => q.label.trim())
          return (
            <div className="terminal-actions" ref={promptMenuRef}>
              <button
                type="button"
                className={`terminal-action-trigger${promptMenuOpen ? ' open' : ''}`}
                onClick={() => setPromptMenuOpen((v) => !v)}
                disabled={!root || items.length === 0}
                title="定型プロンプト"
                aria-label="定型プロンプト"
                aria-haspopup="menu"
                aria-expanded={promptMenuOpen}
              >
                {/* 稲妻アイコン。「素早く送るショートカット」を表す。 */}
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M13 2 L4 14 H11 L11 22 L20 10 H13 Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {promptMenuOpen && items.length > 0 && (
                <div className="terminal-action-menu" role="menu">
                  {items.map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      role="menuitem"
                      className="terminal-action-menu-item"
                      onClick={() => {
                        setPromptMenuOpen(false)
                        sendPrompt(q.prompt)
                      }}
                      disabled={!root || !q.prompt.trim()}
                      title={q.prompt}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
        {/* アクティブな PTY が終了したときだけ再起動ボタンを出す。押すと同じ cwd で起動し直す。 */}
        {root && exited[activeId] && (
          <button
            type="button"
            className="terminal-restart-btn"
            onClick={restartActive}
            title="ターミナルを再起動する"
          >
            ↻ 再起動
          </button>
        )}
        {/* 左右並べ（horizontal）では最小化しても意味が薄く、畳むと復帰できないため
            最小化ボタンを表示しない。上下並べ（vertical）のときだけ出す。 */}
        {layout === 'vertical' && (
          <button
            type="button"
            className={`terminal-toggle${collapsed ? ' collapsed' : ''}`}
            onClick={onToggle}
            title={collapsed ? 'ターミナルを表示' : 'ターミナルを隠す'}
            aria-label={collapsed ? 'ターミナルを表示' : 'ターミナルを隠す'}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2.5 4.5 L6 8 L9.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      {/* 折りたたみ中は本体を display:none で隠す。各 xterm はマウントしたままにして PTY を保持する。 */}
      <div className="terminal-content" style={{ display: collapsed ? 'none' : undefined }}>
        {root ? (
          // すべてのターミナルをマウントし続け、アクティブなものだけ表示する（PTY を保持）。
          tabs.map((t) => (
            <TerminalInstance
              key={t.id}
              id={t.id}
              num={t.num}
              active={t.id === activeId}
              collapsed={collapsed}
              setHandle={setHandle}
              onExitedChange={handleExitedChange}
            />
          ))
        ) : (
          <div className="pane-body placeholder">フォルダを開くとターミナルが起動します</div>
        )}
      </div>
    </div>
  )
}

export default TerminalPane
