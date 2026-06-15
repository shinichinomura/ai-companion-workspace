import { useCallback, useMemo, useRef } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { renderMarkdown } from './markdown'

// プレビュー内リンクの href を project root 相対パスへ解決する。
// baseRelPath は現在表示中ファイルの relPath。先頭 '/' は root 基準、
// それ以外は現在ファイルのディレクトリ基準で解決する。
// スキーム付き（http: など）・プロトコル相対・アンカーのみ・root より上へ出る
// 場合は対象外として null を返す。
function resolveLinkPath(baseRelPath: string, href: string): string | null {
  // http:/https:/mailto: 等のスキーム付き、`//host` のプロトコル相対、`#anchor` は対象外。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
    return null
  }
  // フラグメント・クエリを除いたパス部分だけを使う。
  const pathPart = href.split('#')[0].split('?')[0]
  if (!pathPart) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    decoded = pathPart
  }

  const fromRoot = decoded.startsWith('/')
  // 解決の起点。root 基準なら空、相対なら現在ファイルのディレクトリ。
  const baseDir = fromRoot
    ? ''
    : baseRelPath.slice(0, Math.max(0, baseRelPath.lastIndexOf('/')))
  const stack = baseDir ? baseDir.split('/') : []

  for (const seg of (fromRoot ? decoded.slice(1) : decoded).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // root より上へは出さない（main 側の拒否に頼らず renderer でも防ぐ）。
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  if (stack.length === 0) return null
  return stack.join('/')
}

// Markdown のレンダリング済みプレビュー。
// content は編集中の最新内容を受け取り、サニタイズ済み HTML として表示する。
function MarkdownPreview({ content }: { content: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRelPath = useWorkspaceStore((s) => s.activeFile?.relPath ?? '')
  const openFileByRelPath = useWorkspaceStore((s) => s.openFileByRelPath)

  // 変換コストを抑えるため content が変わったときだけ再変換する。
  const html = useMemo(() => renderMarkdown(content), [content])

  // プレビュー内リンクのクリックを横取りする。
  // - `#anchor`        : 同一ドキュメント内スクロール
  // - 相対ファイルパス : 本アプリ内で該当ファイルを開く（project root 内に限定）
  // - 外部 URL 等       : 既定動作のまま（本機能の対象外）
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement).closest('a')
      if (!anchor) return

      const href = anchor.getAttribute('href')
      if (!href) return

      // 1. ドキュメント内アンカー: ウィンドウ遷移ではなくプレビュー内スクロール。
      if (href.startsWith('#')) {
        e.preventDefault()
        const container = containerRef.current
        if (!container) return

        // `#slug` → デコードしたスラッグ。空（`#` のみ）なら先頭へ。
        // スクロールするのは親の .pane-body（overflow: auto）なので、
        // コンテナ自身を scrollIntoView して先頭に戻す。
        const slug = decodeURIComponent(href.slice(1))
        if (!slug) {
          container.scrollIntoView({ behavior: 'smooth', block: 'start' })
          return
        }

        // sanitize 後の id（user-content- 付き）を優先し、念のため素の id もフォールバック。
        const target =
          container.querySelector(`#user-content-${CSS.escape(slug)}`) ??
          container.querySelector(`#${CSS.escape(slug)}`)
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }

      // 2. 相対ファイルパス: 本アプリ内で開く。
      const relPath = resolveLinkPath(activeRelPath, href)
      if (relPath) {
        e.preventDefault()
        void openFileByRelPath(relPath)
      }
      // 3. それ以外（外部 URL など）は既定動作に委ねる。
    },
    [activeRelPath, openFileByRelPath]
  )

  // renderMarkdown は rehype-sanitize を通した安全な HTML のみを返すため、
  // dangerouslySetInnerHTML で挿入してよい（生 HTML はサニタイズ済み）。
  return (
    <div
      ref={containerRef}
      className="markdown-preview"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default MarkdownPreview
