// 右ペイン: 統合ターミナル。
// Step 1 ではプレースホルダ。Step 6 で xterm.js + node-pty を統合する。
function TerminalPane(): JSX.Element {
  return (
    <div className="pane-inner">
      <div className="pane-header">Terminal</div>
      <div className="pane-body placeholder">
        ターミナルは未起動です
      </div>
    </div>
  )
}

export default TerminalPane
