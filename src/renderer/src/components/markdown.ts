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
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Options as SanitizeSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { visit, SKIP } from 'unist-util-visit'
import { VFile } from 'vfile'
// js-yaml 4.x は ESM ビルドが名前付き export のみ（default export を持たない）ため、
// `import yaml from 'js-yaml'` だと実行時に "no default export" で落ちる。名前付きで取り込む。
import { load as loadYaml } from 'js-yaml'
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
        data = loadYaml(node.value)
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

// ===== インライン SVG 対応のサニタイズスキーマ =====
// Markdown 内に直接書かれた <svg>（Claude Code が生成する図など）を、安全な範囲で表示する。
// 方針:
// - 描画系のタグ・属性のみホワイトリストで許可する
// - script / foreignObject / SMIL アニメーション / <style> 要素 / イベントハンドラ属性は
//   デフォルトスキーマ同様に許可しない（<style> はスコープされず文書全体に効くため不可）
// - 参照系属性（href・clip-path 等の url()）はドキュメント内フラグメント参照のみ許可する
// - style「属性」は許可する。外部 URL の混入は index.html の CSP（default-src 'self'）が
//   最終防衛線として遮断する
// 属性名は hast のプロパティ名（camelCase。例: stroke-width → strokeWidth）で指定する。

type SvgAttributeList = NonNullable<SanitizeSchema['attributes']>[string]

// url(#id) 形式のローカル参照のみ許可する値制限。
const svgLocalUrl = /^url\(['"]?#/

// ドキュメント内フラグメント（#id）参照のみ許可する href（xlink:href は旧形式 SVG 用）。
const svgLocalHref: SvgAttributeList = [
  ['href', /^#/],
  ['xLinkHref', /^#/]
]

// 描画系 SVG 要素に共通で許可する表示属性（イベントハンドラ・外部参照になり得るものは含めない）。
const svgPresentation: SvgAttributeList = [
  'style',
  'className',
  'color',
  'display',
  'visibility',
  'overflow',
  'opacity',
  'transform',
  'fill',
  'fillOpacity',
  'fillRule',
  'stroke',
  'strokeWidth',
  'strokeOpacity',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'fontVariant',
  'letterSpacing',
  'wordSpacing',
  'textAnchor',
  'dominantBaseline',
  'baselineShift',
  'textDecoration',
  'vectorEffect',
  'paintOrder',
  'shapeRendering',
  'clipRule',
  ['clipPath', 'none', svgLocalUrl],
  ['mask', 'none', svgLocalUrl],
  ['filter', 'none', svgLocalUrl],
  ['markerStart', 'none', svgLocalUrl],
  ['markerMid', 'none', svgLocalUrl],
  ['markerEnd', 'none', svgLocalUrl]
]

// フィルタプリミティブ（feGaussianBlur 等）に共通で許可する属性。
const svgFilterPrimitive: SvgAttributeList = [
  'x',
  'y',
  'in',
  'in2',
  'result',
  'mode',
  'type',
  'values',
  'stdDeviation',
  'dx',
  'dy',
  'floodColor',
  'floodOpacity',
  'operator',
  'k1',
  'k2',
  'k3',
  'k4',
  'radius',
  'tableValues',
  'slope',
  'intercept',
  'amplitude',
  'exponent',
  'offset',
  'baseFrequency',
  'numOctaves',
  'seed',
  'stitchTiles',
  'edgeMode'
]

// デフォルト（GitHub 相当）に SVG の描画系タグ・属性を加えたスキーマ。
// width / height / id / title は defaultSchema のグローバル属性（'*'）で既に許可されている。
const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  // script（デフォルト）に加えて中身ごと除去するタグ。
  // - style: スコープされず文書全体に効く。タグだけ剥がすと CSS テキストが本文に露出するため中身ごと落とす
  // - foreignObject: タグだけ剥がすと中の HTML が SVG 内に残り、再パース時に SVG が分断されるため中身ごと落とす
  strip: [...(defaultSchema.strip ?? []), 'style', 'foreignObject'],
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'svg',
    'g',
    'defs',
    'symbol',
    'use',
    'title',
    'desc',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'textPath',
    'linearGradient',
    'radialGradient',
    'stop',
    'pattern',
    'clipPath',
    'mask',
    'marker',
    'filter',
    'feBlend',
    'feColorMatrix',
    'feComponentTransfer',
    'feComposite',
    'feDropShadow',
    'feFlood',
    'feFuncA',
    'feFuncB',
    'feFuncG',
    'feFuncR',
    'feGaussianBlur',
    'feMerge',
    'feMergeNode',
    'feMorphology',
    'feOffset',
    'feTurbulence'
  ],
  attributes: {
    ...defaultSchema.attributes,
    svg: [...svgPresentation, 'viewBox', 'preserveAspectRatio', 'xmlns', 'xmlnsXLink', 'version', 'x', 'y', 'role'],
    g: [...svgPresentation],
    defs: [...svgPresentation],
    symbol: [...svgPresentation, 'viewBox', 'preserveAspectRatio', 'refX', 'refY'],
    use: [...svgPresentation, ...svgLocalHref, 'x', 'y'],
    path: [...svgPresentation, 'd', 'pathLength'],
    rect: [...svgPresentation, 'x', 'y', 'rx', 'ry', 'pathLength'],
    circle: [...svgPresentation, 'cx', 'cy', 'r', 'pathLength'],
    ellipse: [...svgPresentation, 'cx', 'cy', 'rx', 'ry', 'pathLength'],
    line: [...svgPresentation, 'x1', 'y1', 'x2', 'y2', 'pathLength'],
    polyline: [...svgPresentation, 'points', 'pathLength'],
    polygon: [...svgPresentation, 'points', 'pathLength'],
    text: [...svgPresentation, 'x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
    tspan: [...svgPresentation, 'x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
    textPath: [...svgPresentation, ...svgLocalHref, 'startOffset', 'method', 'spacing', 'side'],
    linearGradient: [...svgLocalHref, 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
    radialGradient: [
      ...svgLocalHref,
      'cx',
      'cy',
      'r',
      'fx',
      'fy',
      'fr',
      'gradientUnits',
      'gradientTransform',
      'spreadMethod'
    ],
    stop: ['offset', 'stopColor', 'stopOpacity', 'style'],
    pattern: [
      ...svgLocalHref,
      'x',
      'y',
      'viewBox',
      'preserveAspectRatio',
      'patternUnits',
      'patternContentUnits',
      'patternTransform'
    ],
    clipPath: [...svgPresentation, 'clipPathUnits'],
    mask: [...svgPresentation, 'maskUnits', 'maskContentUnits', 'x', 'y'],
    marker: [
      ...svgPresentation,
      'viewBox',
      'preserveAspectRatio',
      'refX',
      'refY',
      'markerWidth',
      'markerHeight',
      'markerUnits',
      'orient'
    ],
    filter: ['x', 'y', 'filterUnits', 'primitiveUnits'],
    feBlend: [...svgFilterPrimitive],
    feColorMatrix: [...svgFilterPrimitive],
    feComponentTransfer: [...svgFilterPrimitive],
    feComposite: [...svgFilterPrimitive],
    feDropShadow: [...svgFilterPrimitive],
    feFlood: [...svgFilterPrimitive],
    feFuncA: [...svgFilterPrimitive],
    feFuncB: [...svgFilterPrimitive],
    feFuncG: [...svgFilterPrimitive],
    feFuncR: [...svgFilterPrimitive],
    feGaussianBlur: [...svgFilterPrimitive],
    feMerge: [...svgFilterPrimitive],
    feMergeNode: [...svgFilterPrimitive],
    feMorphology: [...svgFilterPrimitive],
    feOffset: [...svgFilterPrimitive],
    feTurbulence: [...svgFilterPrimitive]
  }
}

// sanitize は DOM clobbering 対策で id を `user-content-` プレフィックス付きへ書き換えるため、
// SVG 内の url(#id)・href="#id" によるローカル参照（グラデーション・クリップ・マーカー等）が
// そのままでは参照先を見失う。sanitize の後段で SVG サブツリー内の参照を同じプレフィックスで
// 書き換えて追従させる rehype プラグイン。
const CLOBBER_PREFIX = 'user-content-'

// href でローカル参照を行う SVG 要素。<a> は対象外
// （見出しアンカーへのリンクはクリックハンドラ側が user-content- 付き id を解決する）。
const SVG_HREF_REF_TAGS = new Set(['use', 'textPath', 'linearGradient', 'radialGradient', 'pattern'])

function rehypeSvgLocalRefs() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'svg') return
      visit(node, 'element', (el) => {
        if (!el.properties) return
        for (const [key, value] of Object.entries(el.properties)) {
          // fill / clip-path / style 属性などに現れる url(#id) 参照。
          if (typeof value === 'string' && value.includes('url(')) {
            el.properties[key] = value.replace(/url\((['"]?)#/g, `url($1#${CLOBBER_PREFIX}`)
          }
        }
        if (SVG_HREF_REF_TAGS.has(el.tagName)) {
          for (const key of ['href', 'xLinkHref']) {
            const v = el.properties[key]
            if (typeof v === 'string' && v.startsWith('#')) {
              el.properties[key] = `#${CLOBBER_PREFIX}${v.slice(1)}`
            }
          }
        }
      })
      // svg 内は上の visit で処理済みなので、外側の走査では子孫へ降りない
      // （ネストした svg の二重書き換えを防ぐ）。
      return SKIP
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
  // デフォルトスキーマ（GitHub 相当）+ インライン SVG 許可のスキーマでサニタイズする。
  // raw HTML 由来の要素もここで無害化し、任意スクリプトや許可外タグ・属性を落とす。
  // 見出しの id は user-content- プレフィックス付きで保持される（DOM clobbering 対策）。
  .use(rehypeSanitize, sanitizeSchema)
  // id の user-content- 化に合わせて、SVG 内のローカル参照（url(#id) 等）を追従させる。
  .use(rehypeSvgLocalRefs)
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
