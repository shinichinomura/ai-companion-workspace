import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { renderMarkdown, resolveLinkPath } from './markdown'

// 目次に載せる見出し 1 件分。el はスクロール追従・ジャンプ用の実 DOM 参照。
type Heading = { el: HTMLHeadingElement; id: string; level: number; text: string }

// ペイン幅がこの値未満のときは、本文を潰さないよう目次をオーバーレイ表示に切り替える。
const NARROW_BREAKPOINT = 600
// 現在地判定の基準線（スクロールコンテナ上端から下へこのピクセルの位置）。
const SPY_OFFSET = 8

// Markdown のレンダリング済みプレビュー。
// content は編集中の最新内容を受け取り、サニタイズ済み HTML として表示する。
// showToc が true のとき、右側に見出しの目次レールを追従表示する。
function MarkdownPreview({
  content,
  showToc
}: {
  content: string
  showToc: boolean
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const activeRelPath = useWorkspaceStore((s) => s.activeFile?.relPath ?? '')
  const openFileByRelPath = useWorkspaceStore((s) => s.openFileByRelPath)

  // 変換コストを抑えるため content / 表示中ファイルが変わったときだけ再変換する。
  // activeRelPath は相対パス画像の解決起点に使う（markdown 側で URL 化する）。
  const html = useMemo(() => renderMarkdown(content, activeRelPath), [content, activeRelPath])

  // 目次の表示用リスト（本文からは切り離した軽量コピー）。
  const [headings, setHeadings] = useState<{ id: string; level: number; text: string }[]>([])
  // スクロール追従でハイライトする現在地の見出し id。
  const [activeId, setActiveId] = useState('')
  // ペインが狭くオーバーレイ表示にすべきか。
  const [narrow, setNarrow] = useState(false)

  // 見出しの実 DOM 参照（scroll-spy・ジャンプで使う）。描画のたびに作り直す。
  const headingsRef = useRef<Heading[]>([])
  // スクロールコンテナ（親の .pane-body）。マウント後に一度だけ解決する。
  const scrollElRef = useRef<HTMLElement | null>(null)

  // 現在スクロール位置にある見出しを求めてハイライトを更新する。
  // 基準線より上にある最後の見出しを「現在地」とみなす。
  const updateActive = useCallback(() => {
    const scrollEl = scrollElRef.current
    const hs = headingsRef.current
    if (!scrollEl || hs.length === 0) return
    const line = scrollEl.getBoundingClientRect().top + SPY_OFFSET
    let active = hs[0].id
    for (const h of hs) {
      if (h.el.getBoundingClientRect().top <= line) active = h.id
      else break
    }
    setActiveId((prev) => (prev === active ? prev : active))
  }, [])

  // ペイン幅からオーバーレイ要否を判定し、レールの最大高さ（コンテナの見える高さ）を反映する。
  const updateSize = useCallback(() => {
    const scrollEl = scrollElRef.current
    const layout = layoutRef.current
    if (!scrollEl || !layout) return
    // 長い目次はレール内部でスクロールできるよう、見えている高さに収める。
    layout.style.setProperty('--toc-max-h', `${Math.max(120, scrollEl.clientHeight - 24)}px`)
    setNarrow(scrollEl.clientWidth < NARROW_BREAKPOINT)
  }, [])

  // 描画された HTML から h1〜h3 を拾って目次を作る。DOM を唯一の情報源にすることで、
  // スクロール追従（要素の位置計測）とジャンプ先を同じ参照で扱える。
  // sanitize 後の id は user-content- 付き。id を持つ見出しだけを対象にする。
  useLayoutEffect(() => {
    const root = containerRef.current
    if (!root) return
    const els = Array.from(root.querySelectorAll<HTMLHeadingElement>('h1, h2, h3'))
    const hs: Heading[] = els
      .filter((el) => el.id)
      .map((el) => ({ el, id: el.id, level: Number(el.tagName[1]), text: el.textContent ?? '' }))
    // 位置計測・ジャンプは全見出しの実参照を使う。
    headingsRef.current = hs
    // 表示用リスト: h1 が 1 つだけなら文書タイトルとみなして目次には載せず、
    // h2 以降を 1 段繰り上げて表示する（先頭の見出しを最上位レベルにする）。
    const singleH1 = hs.filter((h) => h.level === 1).length === 1
    const shown = singleH1 ? hs.filter((h) => h.level !== 1) : hs
    setHeadings(
      shown.map((h) => ({ id: h.id, level: singleH1 ? h.level - 1 : h.level, text: h.text }))
    )
    // 内容が変わると各見出しの位置も変わるため、現在地を取り直す。
    updateActive()
  }, [html, updateActive])

  // スクロール追従とサイズ監視を仕掛ける。スクロールコンテナは content 切替をまたいで
  // 変わらないため、購読はマウント時に一度だけ張る。
  useEffect(() => {
    const scrollEl = containerRef.current?.closest('.pane-body') as HTMLElement | null
    scrollElRef.current = scrollEl
    if (!scrollEl) return

    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        updateActive()
      })
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => updateSize())
    ro.observe(scrollEl)

    updateSize()
    updateActive()

    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [updateActive, updateSize])

  // 目次項目クリック: 該当見出しへスクロール。ハイライトは即時に追従させる。
  const handleTocClick = useCallback((id: string) => {
    const target = headingsRef.current.find((h) => h.id === id)
    if (!target) return
    target.el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveId(id)
  }, [])

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
    <div ref={layoutRef} className={`md-layout${narrow ? ' md-layout--narrow' : ''}`}>
      <div
        ref={containerRef}
        className="markdown-preview"
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {showToc && headings.length > 0 && (
        <div className="toc-slot">
          <nav className="toc-rail" aria-label="目次">
            <ul className="toc-list">
              {headings.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    className={`toc-item toc-level-${h.level}${h.id === activeId ? ' active' : ''}`}
                    title={h.text}
                    onClick={() => handleTocClick(h.id)}
                  >
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      )}
    </div>
  )
}

export default MarkdownPreview
