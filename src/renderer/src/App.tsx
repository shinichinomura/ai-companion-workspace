import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import FileExplorer from './components/FileExplorer'
import EditorPane from './components/EditorPane'
import TerminalPane from './components/TerminalPane'

// アプリ全体のシェル。spec 2.1 の 3 ペイン構成（Explorer / Editor / Terminal）。
// ペイン幅はドラッグで調整できる（spec 4.2 アプリ全体）。
function App(): JSX.Element {
  return (
    <div className="app">
      <PanelGroup direction="horizontal" autoSaveId="main-layout">
        <Panel defaultSize={20} minSize={12} className="pane">
          <FileExplorer />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={50} minSize={20} className="pane">
          <EditorPane />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={30} minSize={15} className="pane">
          <TerminalPane />
        </Panel>
      </PanelGroup>
    </div>
  )
}

export default App
