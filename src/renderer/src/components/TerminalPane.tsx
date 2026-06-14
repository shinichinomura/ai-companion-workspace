import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../store/workspace'

// 右ペイン: 統合ターミナル（spec 2.2.4）。
// xterm.js（renderer）と node-pty（main）を IPC で接続する。
// MVP は単一インスタンス。フォルダ未選択時は起動せず、root が変わったら再起動する。
function TerminalPane(): JSX.Element {
  // project root。変化したらターミナルを張り替える（cwd を新 root にする）。
  const root = useWorkspaceStore((s) => s.root)
  const containerRef = useRef<HTMLDivElement>(null)

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
    }
  }, [root])

  return (
    <div className="pane-inner">
      <div className="pane-header">Terminal</div>
      {root ? (
        <div ref={containerRef} className="terminal-body" />
      ) : (
        <div className="pane-body placeholder">フォルダを開くとターミナルが起動します</div>
      )}
    </div>
  )
}

export default TerminalPane
