// バックログ索引 Markdown の解析。
// 「GFM テーブルの各行 = 1 項目」の索引を、カンバン表示用の項目リストへ変換する。
// renderer 内で完結する純粋変換。カラムはヘッダ行の名前で引き当て、位置は決め打ちしない。
// remark の AST を使うことで、セル内の複数リンクや `\|` エスケープ、インラインコード中の
// `|` を正しく扱う（自前の行分割パーサでは壊れやすい部分）。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, Table, TableCell, PhrasingContent } from 'mdast'
import { resolveLinkPath } from './markdown'

// セル内のインライン要素。テキストとリンクを出現順に保持し、そのままの並びで描画できるようにする。
export type BacklogInline =
  | { kind: 'text'; text: string }
  | { kind: 'link'; label: string; href: string; relPath: string | null }

// テーブルの 1 セル。text は全インラインを連結した素のテキスト（フィルタ用）。
export interface BacklogCell {
  text: string
  parts: BacklogInline[]
}

// バックログの 1 項目（索引テーブルの 1 データ行）。
export interface BacklogItem {
  cells: BacklogCell[]
  // 索引ファイル内での行番号（1 始まり）。索引行へのジャンプに使う。
  line: number
  // 行クリックで開く詳細ファイル（root 相対）。見つからない行は null。
  detailRelPath: string | null
  // カードの表題（titleColumn のセル。無ければ先頭セル）。
  title: string
  // 一致した状態名（statuses のいずれか）。どれにも先頭一致しなければ null（= その他レーン）。
  status: string | null
  // 状態セルの全文と、状態名を除いた補足（外側の括弧は剥がす）。
  statusText: string
  statusNote: string
  // タグ（tagColumn をカンマ区切りで分割。カラムが無ければ直前の見出しを 1 タグとして使う）。
  tags: string[]
  // 概要（summaryColumn のセル。無ければ空）。カードのツールチップで見せる。
  summary: string
}

// 解析オプション。既定値は store/backlog.ts の normalize が埋める。
export interface BacklogParseOptions {
  detailLinkLabel: string
  statuses: string[]
  titleColumn: string
  statusColumn: string
  tagColumn: string
  summaryColumn: string
}

// パースだけに使うので変換系プラグインは付けない（markdown.ts の HTML 生成用 processor とは別物）。
const parser = unified().use(remarkParse).use(remarkGfm)

// インライン（phrasing）ノード群から素のテキストを再帰的に集める。
function textOf(nodes: PhrasingContent[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if (node.type === 'inlineCode') out += node.value
    else if (node.type === 'break') out += ' '
    else if ('children' in node) out += textOf(node.children as PhrasingContent[])
  }
  return out
}

// セルのインライン列を text / link の並びへ平坦化する。連続するテキストは 1 つにまとめる。
function flattenCell(nodes: PhrasingContent[], indexRelPath: string): BacklogInline[] {
  const parts: BacklogInline[] = []
  const pushText = (text: string): void => {
    if (text === '') return
    const last = parts[parts.length - 1]
    if (last && last.kind === 'text') last.text += text
    else parts.push({ kind: 'text', text })
  }
  for (const node of nodes) {
    if (node.type === 'link') {
      parts.push({
        kind: 'link',
        label: textOf(node.children as PhrasingContent[]),
        href: node.url,
        relPath: resolveLinkPath(indexRelPath, node.url)
      })
    } else if (node.type === 'text' || node.type === 'inlineCode') {
      pushText(node.value)
    } else if (node.type === 'break') {
      pushText(' ')
    } else if ('children' in node) {
      // 強調・打消し等は装飾を落としてインラインを続けて処理する。
      for (const part of flattenCell(node.children as PhrasingContent[], indexRelPath)) {
        if (part.kind === 'text') pushText(part.text)
        else parts.push(part)
      }
    }
  }
  return parts
}

function toCell(cell: TableCell, indexRelPath: string): BacklogCell {
  const parts = flattenCell(cell.children, indexRelPath)
  return { text: textOf(cell.children), parts }
}

// 行内のリンクから「詳細ファイル」を決める。
// detailLinkLabel と一致するラベルの内部リンクを優先し、無ければ最初の内部リンク。
function findDetailRelPath(
  links: Extract<BacklogInline, { kind: 'link' }>[],
  detailLinkLabel: string
): string | null {
  const internal = links.filter((l) => l.relPath != null)
  const labeled = internal.find((l) => l.label === detailLinkLabel)
  return (labeled ?? internal[0])?.relPath ?? null
}

// 状態セルのテキストを 5 値（など設定された状態名）へ先頭一致で振り分ける。
// 「進行中（2026-07-10 に方針決定）」→ status='進行中', note='2026-07-10 に方針決定'。
// 状態名同士が前方一致で重なる設定に備え、長い名前から順に試す。
function matchStatus(text: string, statuses: string[]): { status: string | null; note: string } {
  const t = text.trim()
  for (const s of [...statuses].sort((a, b) => b.length - a.length)) {
    if (s !== '' && t.startsWith(s)) {
      let note = t.slice(s.length).trim()
      // 補足全体が括弧で包まれていれば外側だけ剥がして読みやすくする。
      const m = /^[（(]([\s\S]*)[）)]$/.exec(note)
      if (m) note = m[1].trim()
      return { status: s, note }
    }
  }
  return { status: null, note: '' }
}

// タグセルをカンマ（, / 、）区切りで分割する。
function splitTags(text: string): string[] {
  return text
    .split(/[,、]/)
    .map((t) => t.trim())
    .filter((t) => t !== '')
}

// 索引 Markdown を解析して項目リストを返す。
// indexRelPath は索引ファイル自身の relPath（セル内相対リンクの解決起点）。
export function parseBacklogIndex(
  source: string,
  indexRelPath: string,
  options: BacklogParseOptions
): BacklogItem[] {
  const tree = parser.parse(source) as Root
  const items: BacklogItem[] = []
  // 直前の見出し（depth 2 以上）。タグカラムが無い索引でのタグ代わりに使う。
  // h1 は文書タイトルとみなし無視する。
  let heading: string | null = null
  for (const node of tree.children) {
    if (node.type === 'heading') {
      if (node.depth >= 2) heading = textOf(node.children) || null
    } else if (node.type === 'table') {
      const table = node as Table
      const [headerRow, ...bodyRows] = table.children
      if (!headerRow) continue
      const columns = headerRow.children.map((c) => textOf(c.children).trim())
      const titleIdx = columns.indexOf(options.titleColumn)
      const statusIdx = columns.indexOf(options.statusColumn)
      const tagIdx = columns.indexOf(options.tagColumn)
      const summaryIdx = columns.indexOf(options.summaryColumn)
      for (const row of bodyRows) {
        const cells = row.children.map((c) => toCell(c, indexRelPath))
        const links = cells.flatMap((c) =>
          c.parts.filter((p): p is Extract<BacklogInline, { kind: 'link' }> => p.kind === 'link')
        )
        const statusText = statusIdx >= 0 ? (cells[statusIdx]?.text.trim() ?? '') : ''
        const { status, note } = matchStatus(statusText, options.statuses)
        items.push({
          cells,
          line: row.position?.start.line ?? table.position?.start.line ?? 1,
          detailRelPath: findDetailRelPath(links, options.detailLinkLabel),
          title: (titleIdx >= 0 ? cells[titleIdx]?.text : cells[0]?.text)?.trim() ?? '',
          status,
          statusText,
          statusNote: note,
          tags:
            tagIdx >= 0
              ? splitTags(cells[tagIdx]?.text ?? '')
              : heading != null
                ? [heading]
                : [],
          summary: summaryIdx >= 0 ? (cells[summaryIdx]?.text.trim() ?? '') : ''
        })
      }
    }
  }
  return items
}
