import { useEffect, useRef, useState } from 'react'
import { DEFAULT_FONT_SIZES, type SearchFileResult, type SearchMatch } from '../../../shared/ipc'
import { useSearchStore } from '../store/search'
import { useWorkspaceStore } from '../store/workspace'
import { useSettingsStore } from '../store/settings'

// relPath の末尾セグメント（表示名）。
function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? relPath : relPath.slice(idx + 1)
}

// relPath の親ディレクトリ（トップレベルは ''）。
function parentDir(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

// マッチ行のプレビューを before / match / after に分解する。
// 行頭の空白は（マッチがそこに掛からない限り）落として読みやすくする。
function splitPreview(m: SearchMatch): { before: string; match: string; after: string } {
  let preview = m.preview
  let col = m.previewColumn
  const trimmed = preview.length - preview.trimStart().length
  // マッチが行頭空白より後ろにあるときだけ、先頭の空白を詰める。
  if (trimmed > 0 && col >= trimmed) {
    preview = preview.slice(trimmed)
    col -= trimmed
  }
  return {
    before: preview.slice(0, col),
    match: preview.slice(col, col + m.length),
    after: preview.slice(col + m.length)
  }
}

// 検索結果 1 マッチの行。行番号 + ハイライト付きプレビュー。
function MatchRow({ file, match }: { file: SearchFileResult; match: SearchMatch }): JSX.Element {
  const openFileAtLocation = useWorkspaceStore((s) => s.openFileAtLocation)
  const { before, match: hit, after } = splitPreview(match)
  return (
    <div
      className="search-match-row"
      title={`${file.relPath}:${match.line}`}
      onClick={() =>
        void openFileAtLocation(file.relPath, match.line, match.column, match.length)
      }
    >
      <span className="search-match-line">{match.line}</span>
      <span className="search-match-preview">
        {before}
        <span className="search-match-hl">{hit}</span>
        {after}
      </span>
    </div>
  )
}

// 1 ファイル分の結果（ヘッダー + マッチ行）。ヘッダークリックで折りたたむ。
function FileGroup({ file }: { file: SearchFileResult }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const name = baseName(file.relPath)
  const dir = parentDir(file.relPath)
  return (
    <div className="search-file">
      <div className="search-file-header" onClick={() => setCollapsed((c) => !c)}>
        <span className="tree-twisty">{collapsed ? '▸' : '▾'}</span>
        <span className="tree-icon">📄</span>
        <span className="search-file-name">{name}</span>
        {dir && <span className="search-file-dir">{dir}</span>}
        <span className="search-file-count">{file.matches.length}</span>
      </div>
      {!collapsed &&
        file.matches.map((m, i) => (
          <MatchRow key={`${m.line}:${m.column}:${i}`} file={file} match={m} />
        ))}
    </div>
  )
}

// 検索オプションのトグルボタン（大文字小文字・単語単位・正規表現）。
function OptionToggle({
  label,
  title,
  on,
  onClick
}: {
  label: string
  title: string
  on: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`search-opt-btn${on ? ' on' : ''}`}
      title={title}
      aria-pressed={on}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

// 左ペイン: ファイル横断検索（VSCode の Ctrl+Shift+F 相当）。
function SearchPane(): JSX.Element {
  const query = useSearchStore((s) => s.query)
  const caseSensitive = useSearchStore((s) => s.caseSensitive)
  const wholeWord = useSearchStore((s) => s.wholeWord)
  const regex = useSearchStore((s) => s.regex)
  const status = useSearchStore((s) => s.status)
  const message = useSearchStore((s) => s.message)
  const results = useSearchStore((s) => s.results)
  // ファイルツリーと同じフォントサイズ（設定画面の「ファイルツリー・検索」）。
  const explorerFontSize = useSettingsStore((s) => s.fontSizes.explorer)
  const focusNonce = useSearchStore((s) => s.focusNonce)
  const setQuery = useSearchStore((s) => s.setQuery)
  const scheduleSearch = useSearchStore((s) => s.scheduleSearch)
  const runSearch = useSearchStore((s) => s.runSearch)
  const toggleCaseSensitive = useSearchStore((s) => s.toggleCaseSensitive)
  const toggleWholeWord = useSearchStore((s) => s.toggleWholeWord)
  const toggleRegex = useSearchStore((s) => s.toggleRegex)

  const root = useWorkspaceStore((s) => s.root)

  const inputRef = useRef<HTMLInputElement>(null)

  // ⇧⌘F や検索アイコンで開かれたとき（focusNonce の変化）に入力欄へフォーカスし全選択する。
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [focusNonce])

  const totalMatches = results?.totalMatches ?? 0
  const fileCount = results?.files.length ?? 0

  // 結果サマリの文言を状態に応じて組み立てる。
  let summary: string | null = null
  if (root === null) {
    summary = 'フォルダが開かれていません'
  } else if (status === 'searching') {
    summary = '検索中…'
  } else if (status === 'error') {
    summary = message || '検索に失敗しました'
  } else if (status === 'done') {
    summary =
      totalMatches === 0
        ? '結果が見つかりませんでした'
        : `${totalMatches} 件（${fileCount} ファイル）${results?.truncated ? '（上限で打ち切り）' : ''}`
  }

  return (
    <div className="pane-inner">
      <div className="pane-header">検索</div>
      <div className="search-controls">
        <div className="search-input-row">
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="検索"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              scheduleSearch()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                runSearch()
              }
            }}
          />
          <div className="search-opts">
            <OptionToggle
              label="Aa"
              title="大文字小文字を区別"
              on={caseSensitive}
              onClick={toggleCaseSensitive}
            />
            <OptionToggle
              label="\b"
              title="単語単位で検索"
              on={wholeWord}
              onClick={toggleWholeWord}
            />
            <OptionToggle
              label=".*"
              title="正規表現を使用"
              on={regex}
              onClick={toggleRegex}
            />
          </div>
        </div>
        {summary && <div className="search-summary">{summary}</div>}
      </div>
      <div
        className="pane-body search-results"
        style={{ zoom: explorerFontSize / DEFAULT_FONT_SIZES.explorer }}
      >
        {results?.files.map((file) => <FileGroup key={file.relPath} file={file} />)}
      </div>
    </div>
  )
}

export default SearchPane
