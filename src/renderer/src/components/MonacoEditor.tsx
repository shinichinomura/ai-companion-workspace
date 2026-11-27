import { useEffect, useRef } from 'react'
import { monaco, languageFromPath } from './monacoSetup'
import { scrollKey, saveScrollTop, loadScrollTop } from './scrollMemory'
import { useSettingsStore } from '../store/settings'

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

// エディタの現在のスクロール位置を path の記憶として保存する。
// 非表示タブ（高さ 0）では位置が丸められている可能性があるため記憶しない。
function saveEditorScroll(editor: monaco.editor.IStandaloneCodeEditor, path: string): void {
  if (editor.getLayoutInfo().height === 0) return
  saveScrollTop(scrollKey(path, 'edit'), editor.getScrollTop())
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
  // 設定画面で指定したエディタのフォントサイズ（px）。
  const fontSize = useSettingsStore((s) => s.fontSizes.editor)
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // 最新のコールバックを参照するための ref（エディタ再生成を避ける）。
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onEditorReadyRef = useRef(onEditorReady)
  // スクロール位置を保存するときの「今表示しているファイル」。
  const pathRef = useRef(path)
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
      fontSize: fontSizeRef.current,
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
      // Edit → Preview 切り替え等でアンマウントされる前に、スクロール位置を記憶する。
      saveEditorScroll(editor, pathRef.current)
      onEditorReadyRef.current?.(null)
      editor.dispose()
      editorRef.current = null
    }
    // 生成は 1 度きり。value/path の反映は別の effect で行う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // フォントサイズの設定変更を、生成済みのエディタへ反映する。
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize })
  }, [fontSize])

  // path が変わったら（マウント直後を含む）、旧ファイルのスクロール位置を記憶したうえで
  // 言語・内容を新ファイルに切り替え、新ファイルの記憶位置（なければ先頭）へ復元する。
  // エディタ本体は使い回すため（モデルの中身だけ差し替える）、何もしないと前のファイルの
  // スクロール位置が残ってしまう。
  // 旧位置の保存は内容を差し替える前でないと、短い内容への置換で位置が丸められてしまうため、
  // 内容の反映（setValue）もここで行ってから復元する。
  // reveal（検索結果ジャンプ等）による移動は後続の effect で行うため、そちらが優先される。
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (pathRef.current !== path) {
      saveEditorScroll(editor, pathRef.current)
      pathRef.current = path
    }
    const model = editor.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, languageFromPath(path))
    }
    if (editor.getValue() !== value) {
      editor.setValue(value)
    }
    editor.setScrollPosition({
      scrollTop: loadScrollTop(scrollKey(path, 'edit')),
      scrollLeft: 0
    })
    // path の変化だけをトリガーにする。value の追従は次の effect が担う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
