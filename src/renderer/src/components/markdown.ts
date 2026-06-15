// Markdown → サニタイズ済み HTML への変換。
// renderer 内で完結する純粋変換（外部 I/O・認証情報には一切触れない）。
// アーキテクチャ原則どおり、出力 HTML は必ず rehype-sanitize を通す（任意 HTML 実行は不可）。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSlug from 'rehype-slug'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

// パイプラインは状態を持たないので使い回す。
// GFM 相当の基本記法（表・打消し線・タスクリスト・自動リンク）に対応する。
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // allowDangerousHtml は付けない。Markdown 中の生 HTML はここで落とす。
  .use(remarkRehype)
  // 見出しに id（スラッグ）を付与し、`[目次](#section)` のようなアンカーリンクを成立させる。
  // sanitize より前に実行する（生成された id は sanitize 側で user-content- が付与される）。
  .use(rehypeSlug)
  // デフォルトスキーマ（GitHub 相当）でサニタイズする。
  // 見出しの id は user-content- プレフィックス付きで保持される（DOM clobbering 対策）。
  .use(rehypeSanitize)
  .use(rehypeStringify)

// Markdown ソースをサニタイズ済み HTML 文字列へ変換する。
export function renderMarkdown(source: string): string {
  // 全プラグインが同期処理のため processSync で同期変換できる。
  return String(processor.processSync(source))
}
