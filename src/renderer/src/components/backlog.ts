// バックログ索引 Markdown の解析。
// 「見出し（= カテゴリ）ごとに GFM テーブルが並ぶ」形式の索引を、表示用の構造へ変換する。
// renderer 内で完結する純粋変換。カラム構成はヘッダ行から動的に取り、決め打ちしない。
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
}

// カテゴリ（直前の見出し）単位のまとまり。テーブルごとに独立したカラム定義を持つ。
export interface BacklogSection {
  category: string | null
  columns: string[]
  items: BacklogItem[]
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
function findDetailRelPath(cells: BacklogCell[], detailLinkLabel: string): string | null {
  const links = cells.flatMap((c) => c.parts.filter((p) => p.kind === 'link'))
  const internal = links.filter((l) => l.kind === 'link' && l.relPath != null)
  const labeled = internal.find((l) => l.kind === 'link' && l.label === detailLinkLabel)
  const found = labeled ?? internal[0]
  return found && found.kind === 'link' ? found.relPath : null
}

// 索引 Markdown を解析してセクション一覧を返す。
// indexRelPath は索引ファイル自身の relPath（セル内相対リンクの解決起点）。
export function parseBacklogIndex(
  source: string,
  indexRelPath: string,
  detailLinkLabel: string
): BacklogSection[] {
  const tree = parser.parse(source) as Root
  const sections: BacklogSection[] = []
  // 「現在のカテゴリ」= 直前に現れた見出し（depth 2 以上）。h1 は文書タイトルとみなし無視する。
  let category: string | null = null
  for (const node of tree.children) {
    if (node.type === 'heading') {
      if (node.depth >= 2) category = textOf(node.children) || null
    } else if (node.type === 'table') {
      const table = node as Table
      const [headerRow, ...bodyRows] = table.children
      if (!headerRow) continue
      const columns = headerRow.children.map((c) => textOf(c.children))
      const items: BacklogItem[] = bodyRows.map((row) => {
        const cells = row.children.map((c) => toCell(c, indexRelPath))
        return {
          cells,
          line: row.position?.start.line ?? table.position?.start.line ?? 1,
          detailRelPath: findDetailRelPath(cells, detailLinkLabel)
        }
      })
      sections.push({ category, columns, items })
    }
  }
  return sections
}
