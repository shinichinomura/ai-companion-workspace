import { useMemo } from 'react'
import { parseDelimited, delimiterForPath } from './csv'
import { useSettingsStore } from '../store/settings'

// CSV / TSV のテーブルプレビュー。
// content は編集中の最新内容を受け取り、Markdown のテーブルと同様の見た目で表示する。
// データは React の要素として描画するため、任意 HTML の混入はなく安全（サニタイズ不要）。
function CsvPreview({ content, relPath }: { content: string; relPath: string }): JSX.Element {
  // 設定画面で指定したプレビューのフォントサイズ（px）。
  const fontSize = useSettingsStore((s) => s.fontSizes.preview)
  // content / 区切り文字が変わったときだけ再パースする。
  const rows = useMemo(
    () => parseDelimited(content, delimiterForPath(relPath)),
    [content, relPath]
  )

  if (rows.length === 0) {
    return <div className="placeholder">空のファイルです</div>
  }

  // 1 行目をヘッダ、以降をデータ行として扱う。
  const [header, ...body] = rows
  // 行ごとに列数が揃わないことがあるため、最大列数に合わせてセルを補う。
  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0)

  return (
    <div className="csv-preview" style={{ fontSize }}>
      <table>
        <thead>
          <tr>
            {Array.from({ length: columnCount }, (_, c) => (
              <th key={c}>{header[c] ?? ''}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {Array.from({ length: columnCount }, (_, c) => (
                <td key={c}>{r[c] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default CsvPreview
