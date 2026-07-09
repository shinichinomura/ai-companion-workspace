import { useCallback, useMemo, useRef } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { renderMarkdown, resolveLinkPath } from './markdown'

// Markdown のレンダリング済みプレビュー。
// content は編集中の最新内容を受け取り、サニタイズ済み HTML として表示する。
// 目次（TOC）は EditorPane がペイン全体にフローティング表示するため、ここでは扱わない。
function MarkdownPreview({ content }: { content: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRelPath = useWorkspaceStore((s) => s.activeFile?.relPath ?? '')
  const openFileByRelPath = useWorkspaceStore((s) => s.openFileByRelPath)

  // 変換コストを抑えるため content / 表示中ファイルが変わったときだけ再変換する。
  // activeRelPath は相対パス画像の解決起点に使う（markdown 側で URL 化する）。
  const html = useMemo(() => renderMarkdown(content, activeRelPath), [content, activeRelPath])

  // プレビュー内リンクのクリックを横取りする。
  // - `#anchor`        : 同一ドキュメント内スクロール
  // - 相対ファイルパス : 本アプリ内で該当ファイルを開く（project root 内に限定）
  // - 外部 URL 等       : 既定動作に委ねる（main の will-navigate ガードが OS の既定ブラウザで開く）
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
      //    リンク遷移は main 側の will-navigate ガードが捕捉し OS の既定ブラウザで開く。
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
