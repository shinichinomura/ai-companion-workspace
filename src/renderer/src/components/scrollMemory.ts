import { useLayoutEffect, useRef } from 'react'

// ファイルごとの最後のスクロール位置（scrollTop）を覚えておく、アプリ起動中だけの記憶。
// キーは「relPath + 表示種別」。同じファイルでも Edit（Monaco）と Preview では
// コンテンツの高さが違うため、別々に記憶する。
const positions = new Map<string, number>()

// 記憶のキーを作る。kind は表示種別（'edit' | 'preview' | 'backlog' など）。
export function scrollKey(relPath: string, kind: string): string {
  return `${kind}\0${relPath}`
}

export function saveScrollTop(key: string, scrollTop: number): void {
  positions.set(key, scrollTop)
}

// 記憶がなければ先頭（0）。
export function loadScrollTop(key: string): number {
  return positions.get(key) ?? 0
}

// スクロールコンテナ（.pane-body など）のスクロール位置をキーごとに記憶・復元するフック。
// key が変わるたびに（別ファイル・別モードを表示したとき）そのキーの記憶位置へ戻し、
// 記憶がなければ先頭へリセットする。key が null（Monaco 等、コンテナ自身はスクロールしない
// 表示）のときは何もせず先頭に戻しておく。
export function useScrollMemory(
  ref: React.RefObject<HTMLElement>,
  key: string | null
): void {
  // scroll イベントの保存先。key の切り替え直後に旧キーへ書かないよう ref で最新を参照する。
  const keyRef = useRef<string | null>(key)

  // スクロールのたびに現在のキーへ保存する。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      // 非表示タブ（display: none）では scrollTop が 0 に潰れるため、その値は記憶しない。
      if (keyRef.current && el.clientHeight > 0) saveScrollTop(keyRef.current, el.scrollTop)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])

  // key が変わったら、新しいキーの位置へ復元する（子の描画は同じコミットで済んでいる）。
  useLayoutEffect(() => {
    keyRef.current = key
    const el = ref.current
    if (!el) return
    el.scrollTop = key ? loadScrollTop(key) : 0
  }, [ref, key])
}
