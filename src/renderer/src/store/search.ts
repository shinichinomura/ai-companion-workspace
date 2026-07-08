import { create } from 'zustand'
import type { SearchResult } from '../../../shared/ipc'

// 検索の進行状態。
//   idle      … 未検索（クエリ空）
//   searching … 実行中
//   done      … 完了（results に結果あり）
//   error     … 失敗（無効な正規表現・例外など）。message に理由を持つ。
export type SearchStatus = 'idle' | 'searching' | 'done' | 'error'

// 最新の検索だけを反映するための世代カウンタ。デバウンス連打・遅延応答で
// 古い結果が新しい結果を上書きしないよう、応答時に一致するかで判定する。
let searchGen = 0
// 入力デバウンス用タイマー。連続入力の間は実行を遅らせる。
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const SEARCH_DEBOUNCE_MS = 250

interface SearchState {
  // 検索ペインを表示中か（左ペインを Explorer と切り替える）。
  open: boolean
  // 入力欄へフォーカスを促すためのカウンタ。⇧⌘F や検索アイコンで増やす。
  focusNonce: number

  // 検索文字列と 3 つのオプション（VSCode のトグルと同じ）。
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean

  status: SearchStatus
  // status==='error' のときの表示メッセージ。
  message: string
  // 直近の検索結果。未検索・クエリ空のときは null。
  results: SearchResult | null

  // 検索ペインを開き、入力欄にフォーカスする。
  openSearch: () => void
  // 検索ペインを閉じる（Explorer に戻す）。
  closeSearch: () => void
  // 検索文字列を設定する（実行はしない。呼び出し側で schedule/run する）。
  setQuery: (query: string) => void
  // オプションを切り替える。切り替え後は即座に再検索する。
  toggleCaseSensitive: () => void
  toggleWholeWord: () => void
  toggleRegex: () => void
  // 入力デバウンス付きで検索を予約する（連続入力向け）。
  scheduleSearch: () => void
  // 直ちに検索を実行する（Enter・オプション変更時）。
  runSearch: () => void
  // 検索状態をクリアする（クエリ・結果を空にする）。
  clear: () => void
}

export const useSearchStore = create<SearchState>((set, get) => ({
  open: false,
  focusNonce: 0,
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  status: 'idle',
  message: '',
  results: null,

  openSearch: () => set((s) => ({ open: true, focusNonce: s.focusNonce + 1 })),
  closeSearch: () => set({ open: false }),

  setQuery: (query: string) => set({ query }),

  toggleCaseSensitive: () => {
    set((s) => ({ caseSensitive: !s.caseSensitive }))
    get().runSearch()
  },
  toggleWholeWord: () => {
    set((s) => ({ wholeWord: !s.wholeWord }))
    get().runSearch()
  },
  toggleRegex: () => {
    set((s) => ({ regex: !s.regex }))
    get().runSearch()
  },

  scheduleSearch: () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      get().runSearch()
    }, SEARCH_DEBOUNCE_MS)
  },

  runSearch: () => {
    // デバウンス待ちがあれば取り消して二重実行を防ぐ。
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    const { query, caseSensitive, wholeWord, regex } = get()
    if (query.length === 0) {
      // クエリ空は未検索状態に戻す（世代を進めて実行中の応答も破棄する）。
      searchGen++
      set({ status: 'idle', message: '', results: null })
      return
    }
    // 正規表現モードは事前に妥当性を検証し、無効ならラウンドトリップせずメッセージを出す。
    if (regex) {
      try {
        new RegExp(query)
      } catch (err) {
        searchGen++
        set({
          status: 'error',
          message: err instanceof Error ? `無効な正規表現: ${err.message}` : '無効な正規表現です',
          results: null
        })
        return
      }
    }
    const gen = ++searchGen
    set({ status: 'searching', message: '' })
    window.api
      .searchInFiles({ query, caseSensitive, wholeWord, regex })
      .then((results) => {
        // 実行中に新しい検索が始まっていたら破棄する。
        if (gen !== searchGen) return
        set({ status: 'done', results })
      })
      .catch((err) => {
        if (gen !== searchGen) return
        set({
          status: 'error',
          message: err instanceof Error ? err.message : '検索に失敗しました',
          results: null
        })
      })
  },

  clear: () => {
    searchGen++
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    set({ query: '', status: 'idle', message: '', results: null })
  }
}))
