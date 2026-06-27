// Markdown → サニタイズ済み HTML への変換。
// renderer 内で完結する純粋変換（外部 I/O・認証情報には一切触れない）。
// アーキテクチャ原則どおり、出力 HTML は必ず rehype-sanitize を通す（任意 HTML 実行は不可）。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSlug from 'rehype-slug'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { visit, SKIP } from 'unist-util-visit'
import { VFile } from 'vfile'
import yaml from 'js-yaml'
import type { Root as HastRoot } from 'hast'
import type { Root as MdastRoot, Table, TableRow } from 'mdast'
import { mediaUrl } from '../../../shared/ipc'

// プレビュー内リンク／画像の参照先を project root 相対パスへ解決する。
// baseRelPath は現在表示中ファイルの relPath。先頭 '/' は root 基準、
// それ以外は現在ファイルのディレクトリ基準で解決する。
// スキーム付き（http: など）・プロトコル相対・アンカーのみ・root より上へ出る
// 場合は対象外として null を返す。
export function resolveLinkPath(baseRelPath: string, href: string): string | null {
  // http:/https:/mailto: 等のスキーム付き、`//host` のプロトコル相対、`#anchor` は対象外。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
    return null
  }
  // フラグメント・クエリを除いたパス部分だけを使う。
  const pathPart = href.split('#')[0].split('?')[0]
  if (!pathPart) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    decoded = pathPart
  }

  const fromRoot = decoded.startsWith('/')
  // 解決の起点。root 基準なら空、相対なら現在ファイルのディレクトリ。
  const baseDir = fromRoot
    ? ''
    : baseRelPath.slice(0, Math.max(0, baseRelPath.lastIndexOf('/')))
  const stack = baseDir ? baseDir.split('/') : []

  for (const seg of (fromRoot ? decoded.slice(1) : decoded).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // root より上へは出さない（main 側の拒否に頼らず renderer でも防ぐ）。
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  if (stack.length === 0) return null
  return stack.join('/')
}

// フロントマター（先頭の `---` で挟まれた YAML ブロック）の値を、表示用の文字列へ整える。
// 文字列はそのまま、配列はカンマ区切り、その他のオブジェクトは JSON 文字列にする。
function formatFrontmatterValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((v) => formatFrontmatterValue(v)).join(', ')
  return JSON.stringify(value)
}

// remark-frontmatter が抽出した先頭の 'yaml' ノードを、キー/値の2列テーブルへ変換する remark プラグイン。
// フロントマターは Markdown 本文ではなくメタデータなので、素の Markdown として解釈させると
// `---` が水平線や setext 見出しに化けて崩れる。ここで明示的にテーブル化して可読な形で見せる。
// パースに失敗した・オブジェクトでない場合は、崩れた見た目を残さないようノードごと取り除く。
function remarkFrontmatterTable() {
  return (tree: MdastRoot): void => {
    visit(tree, 'yaml', (node, index, parent) => {
      if (!parent || typeof index !== 'number') return
      let data: unknown
      try {
        data = yaml.load(node.value)
      } catch {
        data = null
      }
      // オブジェクト（キー/値）以外は表に起こせないので取り除く。
      if (data == null || typeof data !== 'object' || Array.isArray(data)) {
        parent.children.splice(index, 1)
        return [SKIP, index]
      }
      const row = (key: string, value: string): TableRow => ({
        type: 'tableRow',
        children: [
          { type: 'tableCell', children: [{ type: 'text', value: key }] },
          { type: 'tableCell', children: [{ type: 'text', value }] }
        ]
      })
      const table: Table = {
        type: 'table',
        align: [null, null],
        children: [
          row('キー', '値'),
          ...Object.entries(data as Record<string, unknown>).map(([key, value]) =>
            row(key, formatFrontmatterValue(value))
          )
        ]
      }
      parent.children.splice(index, 1, table)
      // 差し替え後のノードを再訪しないよう、同じ位置から次へ進める。
      return [SKIP, index + 1]
    })
  }
}

// 相対パスの画像 src をカスタムスキーム（MEDIA_SCHEME）の URL へ書き換える rehype プラグイン。
// sanitize の後段で実行するため、ここで付与する非 http スキームは sanitize に落とされない
// （URL は resolveLinkPath で project root 内に解決できた相対パスからのみ生成し、
//   実ファイル配信時に main 側でも project root 内かを再検証する）。
// 表示中ファイルの relPath は VFile.data.baseRelPath から受け取る。
function rehypeResolveMedia() {
  return (tree: HastRoot, file: VFile): void => {
    const baseRelPath = typeof file.data.baseRelPath === 'string' ? file.data.baseRelPath : ''
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'img' || !node.properties) return
      const src = node.properties.src
      if (typeof src !== 'string') return
      // 相対かつ project root 内に解決できるものだけ書き換える。
      // 外部 URL（http など）や root を超える参照は resolveLinkPath が null を返すので素通し。
      const relPath = resolveLinkPath(baseRelPath, src)
      if (relPath) {
        node.properties.src = mediaUrl(relPath)
      }
    })
  }
}

// パイプラインは状態を持たないので使い回す。
// GFM 相当の基本記法（表・打消し線・タスクリスト・自動リンク）に対応する。
const processor = unified()
  .use(remarkParse)
  // 先頭の YAML フロントマターを本文と分離して 'yaml' ノードとして抽出する
  // （これが無いと `---` ブロックが素の Markdown として誤解釈され表示が崩れる）。
  .use(remarkFrontmatter, ['yaml'])
  // 抽出したフロントマターをキー/値テーブルへ変換する。
  .use(remarkFrontmatterTable)
  .use(remarkGfm)
  // 生 HTML（`<img width=...>` 等）を raw ノードとして残し、後段の rehype-raw でパースする。
  // 生成物の写真一覧（farming の index.md 等）は Markdown ではなく生 HTML の img を使うため対応する。
  .use(remarkRehype, { allowDangerousHtml: true })
  // 生 HTML を実際の HAST 要素へパースする。安全性はこの後の rehype-sanitize で担保する。
  .use(rehypeRaw)
  // 見出しに id（スラッグ）を付与し、`[目次](#section)` のようなアンカーリンクを成立させる。
  // sanitize より前に実行する（生成された id は sanitize 側で user-content- が付与される）。
  .use(rehypeSlug)
  // デフォルトスキーマ（GitHub 相当）でサニタイズする。raw HTML 由来の要素もここで無害化し、
  // 任意スクリプトや許可外タグ・属性を落とす（`<img>`/`<a>`/width 等は許可される）。
  // 見出しの id は user-content- プレフィックス付きで保持される（DOM clobbering 対策）。
  .use(rehypeSanitize)
  // sanitize 後に、相対パス画像をアプリ内配信用のカスタムスキーム URL へ書き換える。
  .use(rehypeResolveMedia)
  .use(rehypeStringify)

// Markdown ソースをサニタイズ済み HTML 文字列へ変換する。
// baseRelPath は表示中ファイルの relPath。相対パス画像の解決起点に使う（未指定なら root 基準）。
export function renderMarkdown(source: string, baseRelPath = ''): string {
  // 全プラグインが同期処理のため processSync で同期変換できる。
  const file = new VFile({ value: source, data: { baseRelPath } })
  return String(processor.processSync(file))
}
