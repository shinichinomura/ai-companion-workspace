// 左ペイン: ファイルエクスプローラー。
// Step 1 ではプレースホルダ。Step 2 で Open Folder / ファイルツリーを実装する。
function FileExplorer(): JSX.Element {
  return (
    <div className="pane-inner">
      <div className="pane-header">Explorer</div>
      <div className="pane-body placeholder">
        フォルダが開かれていません
      </div>
    </div>
  )
}

export default FileExplorer
