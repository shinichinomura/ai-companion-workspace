import { Fragment } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useWorkspaceStore } from '../store/workspace'
import EditorPane from './EditorPane'

// 中央のエディタ領域。エディタペインを横に並べる。
// 基本は 1 枚（分割しなければ従来と同じ見た目）で、ペイン内の分割ボタンや
// エクスプローラーの「横に開く」で 2 枚以上になる。
function EditorArea(): JSX.Element {
  const panes = useWorkspaceStore((s) => s.panes)

  return (
    // 並びが変わる（ペインの追加/削除）ため、Panel には id と order を付ける（react-resizable-panels の要件）。
    // 幅は保存せず、増減のたびに均等割りにリセットされる（2 枚以上は一時的な使い方のため）。
    <PanelGroup direction="horizontal" className="editor-group">
      {panes.map((pane, index) => (
        <Fragment key={pane.id}>
          {index > 0 && <PanelResizeHandle className="resize-handle" />}
          <Panel id={pane.id} order={index} minSize={15} className="pane">
            <EditorPane paneId={pane.id} />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  )
}

export default EditorArea
