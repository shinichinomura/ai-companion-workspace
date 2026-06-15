import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../store/workspace'

interface TerminalPaneProps {
  // 折りたたみ中か。ヘッダーバーのアイコン向きと本体の表示/非表示に使う。
  collapsed: boolean
  // ヘッダーの開閉アイコンから呼ぶトグル。
  onToggle: () => void
}

// よく使う Git 操作を、ボタン1つで統合ターミナルの Claude に送るための定型プロンプト。
// 注意: 送信先はあくまでユーザーが見ている統合ターミナル。Claude が対話モードで
// 起動している前提のショートカットで、裏でプロンプトを投入するものではない（spec 設計原則）。
interface QuickPrompt {
  // ボタンに表示するラベル。
  label: string
  // ホバー時の説明。実際に何を送るかを明示する。
  title: string
  // PTY に書き込むプロンプト本文（末尾の改行はここには含めない）。
  prompt: string
}

const QUICK_PROMPTS: QuickPrompt[] = [
  {
    label: 'コミット',
    title: '変更内容を確認してコミットするよう Claude に依頼します',
    prompt: '変更内容を確認して、適切な粒度でコミットして'
  },
  {
    label: 'プッシュ',
    title: 'リモート（origin）と同期するよう Claude に依頼します',
    prompt: 'リモート（origin）と同期して。必要なら pull してから push して'
  },
  {
    label: 'コミット&プッシュ',
    title: '変更をコミットしてから origin と同期するよう Claude に依頼します',
    prompt: '変更内容を確認して適切な粒度でコミットし、その後 origin と同期（必要なら pull してから push）して'
  }
]

// 右ペイン: 統合ターミナル（spec 2.2.4）。
// xterm.js（renderer）と node-pty（main）を IPC で接続する。
// MVP は単一インスタンス。フォルダ未選択時は起動せず、root が変わったら再起動する。
function TerminalPane({ collapsed, onToggle }: TerminalPaneProps): JSX.Element {
  // project root。変化したらターミナルを張り替える（cwd を新 root にする）。
  const root = useWorkspaceStore((s) => s.root)
  const containerRef = useRef<HTMLDivElement>(null)
  // 折りたたみから復帰したときにサイズを測り直すため、fit/term を保持する。
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    // フォルダ未選択時はターミナルを起動しない。
    if (!root || !containerRef.current) return

    // xterm 本体と FitAddon を生成する。
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      // ペインの配色に合わせた最低限のテーマ。
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitRef.current = fitAddon
    termRef.current = term

    // コンテナのサイズに合わせて端末サイズを確定する。
    // 初回はレイアウト確定後に測りたいため、サイズが取れるまで安全側に倒す。
    fitAddon.fit()

    // PTY を起動する。初期サイズを渡す。
    let disposed = false
    void window.api.terminalStart({ cols: term.cols, rows: term.rows }).then((res) => {
      if (res.error) {
        term.writeln(`\x1b[31m${res.error}\x1b[0m`)
      }
    })

    // ユーザー入力 → main(PTY)。
    const inputSub = term.onData((data) => {
      window.api.terminalInput(data)
    })

    // PTY 出力 → xterm。
    const offData = window.api.onTerminalData((data) => {
      if (!disposed) term.write(data)
    })

    // プロセス終了通知。
    const offExit = window.api.onTerminalExit(({ exitCode }) => {
      if (!disposed) {
        term.writeln(`\r\n\x1b[90m[プロセスが終了しました (code ${exitCode})]\x1b[0m`)
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
      offData()
      offExit()
      // main 側の PTY も破棄する（root 切替・アンマウント時）。
      window.api.terminalDispose()
      term.dispose()
      fitRef.current = null
      termRef.current = null
    }
  }, [root])

  // 定型プロンプトをそのまま PTY に送る（末尾に改行 \r を付けて即実行）。
  // 送信先はユーザーが見ている統合ターミナルなので、折りたたみ中なら開いて見せる。
  const sendPrompt = (prompt: string): void => {
    if (!root) return
    if (collapsed) onToggle()
    window.api.terminalInput(prompt + '\r')
    // 入力後の文字がターミナルに反映されるよう、フォーカスを端末本体へ戻す。
    termRef.current?.focus()
  }

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
        {/* よく使う Git 操作を Claude に送る定型プロンプトのボタン群。 */}
        <div className="terminal-actions">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q.label}
              type="button"
              className="terminal-action-btn"
              onClick={() => sendPrompt(q.prompt)}
              disabled={!root}
              title={q.title}
            >
              {q.label}
            </button>
          ))}
        </div>
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
      </div>
      {/* 折りたたみ中は本体を display:none で隠す。xterm 自体はマウントしたままにして PTY を保持する。 */}
      <div className="terminal-content" style={{ display: collapsed ? 'none' : undefined }}>
        {root ? (
          <div ref={containerRef} className="terminal-body" />
        ) : (
          <div className="pane-body placeholder">フォルダを開くとターミナルが起動します</div>
        )}
      </div>
    </div>
  )
}

export default TerminalPane
