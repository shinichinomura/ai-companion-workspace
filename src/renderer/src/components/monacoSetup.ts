// Monaco Editor の Web Worker 設定。
// CDN を使わずローカル同梱の worker を Vite の ?worker インポートで読み込む（オフライン動作）。
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// 言語ごとに対応する worker を返す。未対応言語は汎用の editor worker を使う。
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

// Monaco はエディタを破棄するとき、保留中の非同期処理を name/message とも 'Canceled' の例外で reject する。
// 通常の VS Code では内部で握りつぶされるが、スタンドアロン版では未処理 rejection として表面化する。
// エディタペインの分割・クローズや Edit/Preview の切替でエディタを何度も破棄するため、
// これは正常なキャンセルとして無視する（他のエラーはそのまま報告される）。
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { name?: string; message?: string } | null
  if (reason?.name === 'Canceled' && reason.message === 'Canceled') event.preventDefault()
})

// 拡張子から Monaco の language ID を判定する。不明な場合は plaintext。
export function languageFromPath(relPath: string): string {
  const name = relPath.toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  switch (ext) {
    case 'ts':
      return 'typescript'
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'cjs':
    case 'mjs':
      return 'javascript'
    case 'json':
      return 'json'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'less':
      return 'less'
    case 'html':
    case 'htm':
      return 'html'
    case 'py':
      return 'python'
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'xml':
      return 'xml'
    case 'toml':
      return 'ini'
    default:
      return 'plaintext'
  }
}

export { monaco }
