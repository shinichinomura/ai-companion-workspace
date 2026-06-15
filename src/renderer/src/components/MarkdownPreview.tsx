import { useCallback, useMemo, useRef } from 'react'
import { renderMarkdown } from './markdown'

// Markdown のレンダリング済みプレビュー。
// content は編集中の最新内容を受け取り、サニタイズ済み HTML として表示する。
function MarkdownPreview({ content }: { content: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  // 変換コストを抑えるため content が変わったときだけ再変換する。
  const html = useMemo(() => renderMarkdown(content), [content])

  // ドキュメント内アンカー（`[目次](#section)` など）のクリックを横取りして、
  // ウィンドウ全体の遷移ではなくプレビュー内スクロールで対応する。
  // 見出しの id は sanitize により user-content- プレフィックスが付くため、
  // href の `#slug` をそのプレフィックス付き id へ読み替えて探す。
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return

    const href = anchor.getAttribute('href')
    if (!href || !href.startsWith('#')) return

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
  }, [])

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
