import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../store/workspace'
import { useSettingsStore } from '../store/settings'
import type { WorkLayout } from '../../../shared/ipc'

interface TerminalPaneProps {
  // 折りたたみ中か。ヘッダーバーのアイコン向きと本体の表示/非表示に使う。
  collapsed: boolean
  // ヘッダーの開閉アイコンから呼ぶトグル。
  onToggle: () => void
  // Editor / Terminal の並べ方。左右並べ（horizontal）では最小化ボタンを隠す。
  layout: WorkLayout
}

// 右ペイン: 統合ターミナル（spec 2.2.4）。
// xterm.js（renderer）と node-pty（main）を IPC で接続する。
// MVP は単一インスタンス。フォルダ未選択時は起動せず、root が変わったら再起動する。
function TerminalPane({ collapsed, onToggle, layout }: TerminalPaneProps): JSX.Element {
  // project root。変化したらターミナルを張り替える（cwd を新 root にする）。
  const root = useWorkspaceStore((s) => s.root)
  // よく使う Git 操作のボタン定義（設定画面で編集可能）。押すと prompt を統合ターミナルに送る。
  // 送信先はユーザーが見ている統合ターミナル。Claude が対話モードで起動している前提の
  // ショートカットで、裏でプロンプトを投入するものではない（spec 設計原則）。
  const quickPrompts = useSettingsStore((s) => s.quickPrompts)
  const containerRef = useRef<HTMLDivElement>(null)
  // 折りたたみから復帰したときにサイズを測り直すため、fit/term を保持する。
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  // PTY 起動処理を header の再起動ボタンからも呼べるよう ref に保持する。
  const startPtyRef = useRef<(() => void) | null>(null)
  // PTY が終了済みかどうか。終了時のみ再起動ボタンを出すために使う。
  const [exited, setExited] = useState(false)
  // ファイルを drag 中かどうか。ドロップ可能であることを視覚的に示すために使う。
  const [dragOver, setDragOver] = useState(false)
  // 定型プロンプトのメニューを開いているか。ヘッダーのアイコンを押すと展開する。
  const [promptMenuOpen, setPromptMenuOpen] = useState(false)
  // メニューの外側クリック判定のため、トリガー＋メニュー全体を包む要素を保持する。
  const promptMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // フォルダ未選択時はターミナルを起動しない。
    if (!root || !containerRef.current) return

    // xterm 本体と FitAddon を生成する。
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      // ペインの配色に合わせた最低限のテーマ。背景は CSS の --bg-pane(#252526) と揃える。
      theme: { background: '#252526', foreground: '#d4d4d4' }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitRef.current = fitAddon
    termRef.current = term

    // コンテナのサイズに合わせて端末サイズを確定する。
    // 初回はレイアウト確定後に測りたいため、サイズが取れるまで安全側に倒す。
    fitAddon.fit()

    // PTY を起動する。初回起動と、終了後の再起動の両方で使う。
    let disposed = false
    const startPty = (): void => {
      if (disposed) return
      // 再起動時はコンテナサイズが変わっている可能性があるので測り直す。
      try {
        fitAddon.fit()
      } catch {
        // サイズが取れないタイミングは無視する。
      }
      setExited(false)
      void window.api.terminalStart({ cols: term.cols, rows: term.rows }).then((res) => {
        if (disposed) return
        if (res.error) {
          term.writeln(`\x1b[31m${res.error}\x1b[0m`)
          setExited(true)
        }
      })
    }
    startPtyRef.current = startPty
    startPty()

    // ユーザー入力 → main(PTY)。
    const inputSub = term.onData((data) => {
      window.api.terminalInput(data)
    })

    // ベル（\x07）を main に通知する。claude CLI が操作待ちになると鳴らすため、
    // アプリが非アクティブ／別タブのときに main 側で OS 通知を出す。
    const bellSub = term.onBell(() => {
      window.api.notifyTerminalBell()
    })

    // PTY 出力 → xterm。
    const offData = window.api.onTerminalData((data) => {
      if (!disposed) term.write(data)
    })

    // プロセス終了通知。再起動ボタンを出すため exited を立てる。
    const offExit = window.api.onTerminalExit(({ exitCode }) => {
      if (!disposed) {
        term.writeln(`\r\n\x1b[90m[プロセスが終了しました (code ${exitCode})]\x1b[0m`)
        setExited(true)
      }
    })

    // ペインのリサイズに追従し、サイズ変更を main に伝える。
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        window.api.terminalResize({ cols: term.cols, rows: term.rows })
      } catch {
        // コンテナが一時的に 0 サイズの場合などは無視する。
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      disposed = true
      resizeObserver.disconnect()
      inputSub.dispose()
      bellSub.dispose()
      offData()
      offExit()
      // main 側の PTY も破棄する（root 切替・アンマウント時）。
      window.api.terminalDispose()
      term.dispose()
      fitRef.current = null
      termRef.current = null
      startPtyRef.current = null
    }
  }, [root])

  // 終了したターミナルを再起動する。header の再起動ボタンから呼ぶ。
  const restartTerminal = (): void => {
    const term = termRef.current
    if (!term) return
    // 前回の出力を消してから起動し直し、画面を綺麗にする。
    term.reset()
    startPtyRef.current?.()
    term.focus()
  }

  // 定型プロンプトをそのまま PTY に送る（末尾に改行 \r を付けて即実行）。
  // 送信先はユーザーが見ている統合ターミナルなので、折りたたみ中なら開いて見せる。
  const sendPrompt = (prompt: string): void => {
    if (!root) return
    if (collapsed) onToggle()
    window.api.terminalInput(prompt + '\r')
    // 入力後の文字がターミナルに反映されるよう、フォーカスを端末本体へ戻す。
    termRef.current?.focus()
  }

  // ターミナルへドロップしたファイルパスを、シェルでそのまま使える形にエスケープする。
  // 標準ターミナルへのドロップと同じく、空白やシェル特殊文字を backslash で退避する。
  const escapePath = (p: string): string => p.replace(/([ !"#$&'()*,;<>?@[\\\]^`{|}~])/g, '\\$1')

  // ファイルがターミナル本体にドロップされたとき。
  // 各ファイルの絶対パスをエスケープして空白区切りで挿入する（改行は付けず実行はしない）。
  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    if (!root) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const text = files
      .map((f) => escapePath(window.api.getPathForFile(f)))
      .filter((p) => p.length > 0)
      .join(' ')
    if (!text) return
    // 末尾に空白を付けて、続けて入力しやすくする（標準ターミナルの挙動に合わせる）。
    window.api.terminalInput(text + ' ')
    termRef.current?.focus()
  }

  // drag 中はドロップを受け付けるため preventDefault が必須。
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (!dragOver) setDragOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    // 子要素間の移動では leave が誤発火するため、コンテナ外に出たときだけ解除する。
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
  }

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

  // 折りたたみから表示に戻ったらサイズを測り直す（非表示中は 0 サイズなので fit がずれる）。
  useEffect(() => {
    if (collapsed) return
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const t = termRef.current
        if (t) window.api.terminalResize({ cols: t.cols, rows: t.rows })
      } catch {
        // サイズが取れないタイミングは無視する。
      }
    })
    return () => cancelAnimationFrame(id)
  }, [collapsed])

  return (
    <div className="pane-inner">
      {/* 開閉バー。折りたたんでもこのバーだけは残る。 */}
      <div className="terminal-header">
        <span>Terminal</span>
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
        {/* PTY が終了したときだけ再起動ボタンを出す。押すと同じ cwd でシェルを起動し直す。 */}
        {root && exited && (
          <button
            type="button"
            className="terminal-restart-btn"
            onClick={restartTerminal}
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
      {/* 折りたたみ中は本体を display:none で隠す。xterm 自体はマウントしたままにして PTY を保持する。 */}
      <div className="terminal-content" style={{ display: collapsed ? 'none' : undefined }}>
        {root ? (
          <div
            ref={containerRef}
            className={`terminal-body${dragOver ? ' drag-over' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          />
        ) : (
          <div className="pane-body placeholder">フォルダを開くとターミナルが起動します</div>
        )}
      </div>
    </div>
  )
}

export default TerminalPane
