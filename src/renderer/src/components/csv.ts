// CSV / TSV テキストを行・列の二次元配列へパースする。
// renderer 内で完結する純粋変換（外部 I/O・認証情報には一切触れない）。
// RFC 4180 相当の引用規則に対応する:
//   - フィールドは区切り文字（, または \t）で区切る
//   - 引用符 (") で囲んだフィールド内は区切り文字・改行を含められる
//   - 引用符内の "" はエスケープされた 1 個の " として扱う
//   - 改行は LF / CRLF の両方を行区切りとして扱う

// 拡張子から区切り文字を決める。.tsv はタブ、それ以外（.csv）はカンマ。
export function delimiterForPath(relPath: string): ',' | '\t' {
  return relPath.toLowerCase().endsWith('.tsv') ? '\t' : ','
}

// CSV/TSV ソースを string[][] へ変換する。空入力は空配列を返す。
export function parseDelimited(source: string, delimiter: ',' | '\t' = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let started = false // 1 文字でも読んだら行が存在するとみなす（末尾の空行抑制用）

  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    started = true

    if (inQuotes) {
      if (ch === '"') {
        // 連続する "" はエスケープされた引用符。それ以外は引用終了。
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      pushField()
    } else if (ch === '\n') {
      pushRow()
    } else if (ch === '\r') {
      // CRLF の \r は読み飛ばし、続く \n で行を確定する。単独 \r も行区切りとして扱う。
      if (source[i + 1] === '\n') {
        i++
      }
      pushRow()
    } else {
      field += ch
    }
  }

  // 最終フィールド/行を確定する。完全に空の入力では何も積まない。
  if (started || field !== '' || row.length > 0) {
    pushRow()
  }

  // 末尾改行による空行（1 列で中身が空）を 1 行だけ落とす。
  const last = rows[rows.length - 1]
  if (rows.length > 1 && last.length === 1 && last[0] === '') {
    rows.pop()
  }

  return rows
}
