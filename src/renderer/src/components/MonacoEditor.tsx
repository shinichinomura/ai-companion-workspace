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
  // 指定行・列へスクロールして範囲を選択する指示（検索結果クリック等）。
  // seq が変わるたびに反映する（同じ位置の連続クリックにも追従させるため）。
  reveal?: { line: number; column: number; length: number; seq: number }
  // エディタ本体の生成/破棄を親へ通知する（目次のスクロール追従・ジャンプで使う）。
  // 生成時にインスタンス、破棄時に null を渡す。
  onEditorReady?: (editor: monaco.editor.IStandaloneCodeEditor | null) => void
}

// Monaco Editor の薄いラッパー。エディタ本体は 1 度だけ生成し、
// path/value の変化に応じてモデルと内容を更新する。
function MonacoEditor({
  path,
  value,
  onChange,
  onSave,
  reveal,
  onEditorReady
}: MonacoEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // 最新のコールバックを参照するための ref（エディタ再生成を避ける）。
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onEditorReadyRef = useRef(onEditorReady)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onEditorReadyRef.current = onEditorReady

  // マウント時にエディタを生成し、アンマウント時に破棄する。
  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      value,
      language: languageFromPath(path),
      // アプリのダークテーマに合わせる（背景 #1e1e1e / 文字 #d4d4d4）。
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      // ペインの右端で折り返す（横スクロールを出さない）。
      wordWrap: 'on',
      fontSize: 13,
      tabSize: 2
    })
    editorRef.current = editor
    onEditorReadyRef.current?.(editor)

    editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue())
    })
    // Cmd+S（macOS）/ Ctrl+S で保存。
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current()
    })

    return () => {
      onEditorReadyRef.current?.(null)
      editor.dispose()
      editorRef.current = null
    }
    // 生成は 1 度きり。value/path の反映は別の effect で行う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // path が変わったら言語を更新し、スクロール位置を先頭へ戻す。
  // エディタ本体は使い回すため（モデルの中身だけ差し替える）、別ファイルを開いても
  // 前のファイルのスクロール位置が残ってしまう。開くたびに先頭へリセットする。
  // reveal（検索結果ジャンプ等）による移動は後続の effect で行うため、そちらが優先される。
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, languageFromPath(path))
    }
    editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 })
  }, [path])

  // 外部由来で value が変わった場合のみ内容を反映する
  // （ユーザー入力由来の変更ではエディタの現在値と一致するため上書きしない＝カーソル維持）。
  // reveal 効果より前に置き、ジャンプ前に対象ファイルの内容が反映されているようにする。
  useEffect(() => {
    const editor = editorRef.current
    if (editor && editor.getValue() !== value) {
      editor.setValue(value)
    }
  }, [value])

  // 検索結果クリック等の指示に従い、指定行・列へスクロールして範囲を選択する。
  // seq をキーにして、同じ位置の連続クリックでも毎回スクロール・選択し直す。
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !reveal) return
    const { line, column, length } = reveal
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column })
    if (length > 0) {
      editor.setSelection({
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: column + length
      })
    }
    editor.focus()
    // seq の変化だけをトリガーにする（同一位置の再クリックにも反応させる）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq])

  return <div ref={containerRef} className="monaco-container" />
}

export default MonacoEditor
