import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { monaco } from './monacoSetup'
import { parseSourceHeadings, promoteSingleH1, type TocEntry } from './toc'

// 目次フックの共通の戻り値。
// - headings: 表示用リスト（h1 繰り上げ済み）
// - activeKey: スクロール追従でハイライトする現在地
// - jump: 目次項目クリック時のジャンプ処理
export type TocState = { headings: TocEntry[]; activeKey: string; jump: (key: string) => void }

// 現在地判定の基準線（スクロールコンテナ上端から下へこのピクセルの位置）。
const SPY_OFFSET = 8

// ===== Preview モード（描画済み DOM 由来） =====
// scrollRef は overflow: auto のスクロールコンテナ（.pane-body）。その中の
// .markdown-preview から h1〜h3 を抽出し、要素の位置計測でスクロール追従する。
// contentKey が変わるたびに抽出し直す（本文 HTML の再描画に追従）。
// DOM を唯一の情報源にすることで、位置計測とジャンプ先を同じ実要素で扱える。
export function usePreviewToc(
  scrollRef: RefObject<HTMLElement>,
  contentKey: string,
  enabled: boolean
): TocState {
  // 見出しの実要素（scroll-spy・ジャンプ用）。描画のたびに作り直す。
  const elsRef = useRef<HTMLElement[]>([])
  // 表示用リストの元データ（本文からは切り離した軽量コピー）。
  const [all, setAll] = useState<{ id: string; level: number; text: string }[]>([])
  const [activeKey, setActiveKey] = useState('')

  // 現在スクロール位置にある見出しを求めてハイライトを更新する。
  // 基準線より上にある最後の見出しを「現在地」とみなす。
  const updateActive = useCallback(() => {
    const scrollEl = scrollRef.current
    const els = elsRef.current
    if (!scrollEl || els.length === 0) return
    const line = scrollEl.getBoundingClientRect().top + SPY_OFFSET
    let active = els[0].id
    for (const el of els) {
      if (el.getBoundingClientRect().top <= line) active = el.id
      else break
    }
    setActiveKey((prev) => (prev === active ? prev : active))
  }, [scrollRef])

  // 描画済み HTML から h1〜h3 を拾って目次を作る。
  // sanitize 後の id は user-content- 付き。id を持つ見出しだけを対象にする。
  useLayoutEffect(() => {
    if (!enabled) {
      elsRef.current = []
      setAll([])
      setActiveKey('')
      return
    }
    const root = scrollRef.current
    if (!root) return
    const els = Array.from(
      root.querySelectorAll<HTMLElement>(
        '.markdown-preview h1, .markdown-preview h2, .markdown-preview h3'
      )
    ).filter((el) => el.id)
    elsRef.current = els
    setAll(els.map((el) => ({ id: el.id, level: Number(el.tagName[1]), text: el.textContent ?? '' })))
    // 内容が変わると各見出しの位置も変わるため、現在地を取り直す。
    updateActive()
  }, [enabled, contentKey, scrollRef, updateActive])

  // スクロール追従。
  useEffect(() => {
    if (!enabled) return
    const scrollEl = scrollRef.current
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
    updateActive()
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [enabled, scrollRef, updateActive])

  // 表示用リスト（h1 が 1 つだけなら文書タイトルとみなして繰り上げる）。
  const headings = useMemo(
    () => promoteSingleH1(all).map((h) => ({ key: h.id, level: h.level, text: h.text })),
    [all]
  )

  // 目次項目クリック: 該当見出しへスクロール。ハイライトは即時に追従させる。
  const jump = useCallback((key: string) => {
    const el = elsRef.current.find((e) => e.id === key)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveKey(key)
  }, [])

  return { headings, activeKey, jump }
}

// ===== Edit モード（Monaco のソース由来） =====
// 描画済み DOM が無いため、ソーステキストから見出しを行番号付きで抽出し、
// Monaco の縦スクロール位置で追従・ジャンプする。
export function useEditorToc(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  content: string,
  enabled: boolean
): TocState {
  // 見出し全件（繰り上げ前）。scroll-spy はこの全件で判定する。
  const all = useMemo(() => (enabled ? parseSourceHeadings(content) : []), [enabled, content])
  const [activeKey, setActiveKey] = useState('')

  // スクロール追従。見出し行のビュー内 Y 位置を基準線と比べ、最後に上に来た見出しを現在地にする。
  useEffect(() => {
    if (!enabled || !editor || all.length === 0) {
      setActiveKey('')
      return
    }
    const update = (): void => {
      const marker = editor.getScrollTop() + 12
      let active = String(all[0].line)
      for (const h of all) {
        if (editor.getTopForLineNumber(h.line) <= marker) active = String(h.line)
        else break
      }
      setActiveKey((prev) => (prev === active ? prev : active))
    }
    update()
    const disposable = editor.onDidScrollChange(() => update())
    return () => disposable.dispose()
  }, [enabled, editor, all])

  // 表示用リスト（h1 が 1 つだけなら文書タイトルとみなして繰り上げる）。
  const headings = useMemo(
    () =>
      promoteSingleH1(all).map((h) => ({ key: String(h.line), level: h.level, text: h.text })),
    [all]
  )

  // 目次項目クリック: 見出し行がビュー上端の少し下に来るようスクロールし、カーソルも移す。
  const jump = useCallback(
    (key: string) => {
      if (!editor) return
      const line = Number(key)
      editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(line) - 8))
      editor.setPosition({ lineNumber: line, column: 1 })
      editor.focus()
      setActiveKey(key)
    },
    [editor]
  )

  return { headings, activeKey, jump }
}
