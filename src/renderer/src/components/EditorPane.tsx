// 中央ペイン: エディタ / ビューワー。
// Step 1 ではプレースホルダ。Step 3 で Monaco Editor を組み込む。
function EditorPane(): JSX.Element {
  return (
    <div className="pane-inner">
      <div className="pane-header">Editor</div>
      <div className="pane-body placeholder">
        ファイルが選択されていません
      </div>
    </div>
  )
}

export default EditorPane
