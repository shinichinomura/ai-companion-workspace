// Markdown 目次（TOC）の共有ロジック。
// Edit / Preview どちらのモードでも同じ見た目・操作で目次を出すため、
// 表示用の型・両モード共通の整形規則・Edit 用のソース解析をここへ集約する。

// 目次に載せる 1 項目（表示用）。key はモードごとのジャンプ先識別子。
// - Preview: 見出し要素の id（サニタイズ後の user-content- 付き）
// - Edit:    見出しのソース行番号（1 始まり）を文字列化したもの
export type TocEntry = { key: string; level: number; text: string }

// 見出しリストに「h1 が 1 つだけなら文書タイトルとみなす」規則を適用する。
// その h1 は目次に載せず、h2 以降を 1 段繰り上げて先頭を最上位レベルにする。
// level を持つ任意の見出しリストに使える（Preview の DOM 由来・Edit のソース由来 双方）。
export function promoteSingleH1<T extends { level: number }>(items: T[]): T[] {
  const singleH1 = items.filter((h) => h.level === 1).length === 1
  if (!singleH1) return items
  return items.filter((h) => h.level !== 1).map((h) => ({ ...h, level: h.level - 1 }))
}

// Edit モード用の見出し 1 件（ソース行番号付き）。
export type SourceHeading = { line: number; level: number; text: string }

// Markdown ソースから ATX 見出し（`#`〜`###`）を行番号付きで抽出する。
// - フェンスコードブロック（``` / ~~~）の内側にある `#` は見出しにしない。
// - 対象は h1〜h3（Preview 側の抽出範囲に合わせる）。
// - 行番号は 1 始まり（Monaco の lineNumber に合わせる）。
// 描画済み DOM が無い Edit モードのための軽量パーサで、インライン装飾（**強調** 等）は
// そのまま残す（ソースを見ながらの利用なので生に近い見出し文字列で十分）。
export function parseSourceHeadings(source: string): SourceHeading[] {
  const lines = source.split('\n')
  const headings: SourceHeading[] = []
  // 開いているフェンス記号（'`' か '~'）。null ならコードブロックの外。
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    // フェンスの開始/終了を追う（開いている間は見出しを拾わない）。
    const fenceMatch = raw.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence == null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence != null) continue
    // ATX 見出し。前後の `#` と空白は落とす。
    const m = raw.match(/^\s{0,3}(#{1,3})\s+(.*?)\s*#*\s*$/)
    if (!m) continue
    const text = m[2].trim()
    if (!text) continue
    headings.push({ line: i + 1, level: m[1].length, text })
  }
  return headings
}
