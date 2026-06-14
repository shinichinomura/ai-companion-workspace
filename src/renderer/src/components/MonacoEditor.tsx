import { useEffect, useRef } from 'react'
import { monaco, languageFromPath } from './monacoSetup'

interface MonacoEditorProps {
  // 編集対象を一意に識別する相対パス。変わったらモデルを切り替える。
  path: string
  // 表示内容。
  value: string
  // 編集時に呼ばれる。
  onChange: (value: string) => void
  // Cmd+S 押下時に呼ばれる。
  onSave: () => void
}

// Monaco Editor の薄いラッパー。エディタ本体は 1 度だけ生成し、
// path/value の変化に応じてモデルと内容を更新する。
function MonacoEditor({ path, value, onChange, onSave }: MonacoEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // 最新のコールバックを参照するための ref（エディタ再生成を避ける）。
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  // マウント時にエディタを生成し、アンマウント時に破棄する。
  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      value,
      language: languageFromPath(path),
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2
    })
    editorRef.current = editor

    editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue())
    })
    // Cmd+S（macOS）/ Ctrl+S で保存。
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current()
    })

    return () => {
      editor.dispose()
      editorRef.current = null
    }
    // 生成は 1 度きり。value/path の反映は別の effect で行う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // path が変わったら言語を更新する。
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, languageFromPath(path))
    }
  }, [path])

  // 外部由来で value が変わった場合のみ内容を反映する
  // （ユーザー入力由来の変更ではエディタの現在値と一致するため上書きしない＝カーソル維持）。
  useEffect(() => {
    const editor = editorRef.current
    if (editor && editor.getValue() !== value) {
      editor.setValue(value)
    }
  }, [value])

  return <div ref={containerRef} className="monaco-container" />
}

export default MonacoEditor
