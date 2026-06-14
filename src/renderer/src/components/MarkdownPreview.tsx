import { useMemo } from 'react'
import { renderMarkdown } from './markdown'

// Markdown のレンダリング済みプレビュー。
// content は編集中の最新内容を受け取り、サニタイズ済み HTML として表示する。
function MarkdownPreview({ content }: { content: string }): JSX.Element {
  // 変換コストを抑えるため content が変わったときだけ再変換する。
  const html = useMemo(() => renderMarkdown(content), [content])

  // renderMarkdown は rehype-sanitize を通した安全な HTML のみを返すため、
  // dangerouslySetInnerHTML で挿入してよい（生 HTML はサニタイズ済み）。
  return (
    <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />
  )
}

export default MarkdownPreview
