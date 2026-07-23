import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useBacklogStore, type BacklogDef } from '../store/backlog'
import { parseBacklogIndex, type BacklogItem, type BacklogSection } from './backlog'

// バックログ項目のフィルタ。カテゴリ名か、いずれかのセルのテキストに部分一致（大文字小文字無視）。
function matchesQuery(section: BacklogSection, item: BacklogItem, query: string): boolean {
  if (query === '') return true
  const q = query.toLowerCase()
  if (section.category?.toLowerCase().includes(q)) return true
  return item.cells.some((c) => c.text.toLowerCase().includes(q))
}

// フィルタ適用後のセクション一覧（項目が残らないセクションは落とす）。
function filterSections(sections: BacklogSection[], query: string): BacklogSection[] {
  return sections
    .map((s) => ({ ...s, items: s.items.filter((item) => matchesQuery(s, item, query)) }))
    .filter((s) => s.items.length > 0)
}

function countItems(sections: BacklogSection[]): number {
  return sections.reduce((sum, s) => sum + s.items.length, 0)
}

// セクション群のテーブル描画。completed のとき完了スタイル（淡色）を付ける。
// sourceRelPath はこのセクション群の索引ファイル。開いている索引かどうかで行ジャンプの方法を変える。
function SectionTables({
  sections,
  completed,
  sourceRelPath,
  openRelPath
}: {
  sections: BacklogSection[]
  completed: boolean
  sourceRelPath: string
  openRelPath: string
}): JSX.Element {
  const openFileByRelPath = useWorkspaceStore((s) => s.openFileByRelPath)
  const openFileAtLocation = useWorkspaceStore((s) => s.openFileAtLocation)
  const revealActiveFileAt = useWorkspaceStore((s) => s.revealActiveFileAt)

  // 索引行そのものへジャンプする。開いている索引ならディスク再読込を避けて reveal だけ積む
  // （openFileAtLocation は読み直すため、未保存の編集があると失われる）。
  const jumpToIndexRow = (line: number): void => {
    if (sourceRelPath === openRelPath) revealActiveFileAt(line)
    else void openFileAtLocation(sourceRelPath, line, 1, 0)
  }

  return (
    <>
      {sections.map((section, si) => (
        <section key={si} className="backlog-section">
          {section.category && (
            <h3 className={`backlog-section-title${completed ? ' completed' : ''}`}>
              {section.category}
            </h3>
          )}
          <table>
            <thead>
              <tr>
                {section.columns.map((col, ci) => (
                  <th key={ci}>{col}</th>
                ))}
                {/* 索引行ジャンプボタンの列（ヘッダは空）。 */}
                <th className="backlog-jump-col" aria-label="索引行へ" />
              </tr>
            </thead>
            <tbody>
              {section.items.map((item, ri) => (
                <tr
                  key={ri}
                  className={`backlog-row${completed ? ' completed' : ''}${item.detailRelPath ? ' clickable' : ''}`}
                  onClick={() => {
                    if (item.detailRelPath) void openFileByRelPath(item.detailRelPath)
                  }}
                  title={item.detailRelPath ? `${item.detailRelPath} を開く` : undefined}
                >
                  {Array.from({ length: section.columns.length }, (_, ci) => {
                    const cell = item.cells[ci]
                    return (
                      // 長文セル（概要等）は CSS で行数をクランプするため、全文はツールチップで補う。
                      <td key={ci} title={cell && cell.text.length > 80 ? cell.text : undefined}>
                        <div className="backlog-cell">
                          {cell?.parts.map((part, pi) =>
                            part.kind === 'text' ? (
                              <span key={pi}>{part.text}</span>
                            ) : part.relPath ? (
                              <a
                                key={pi}
                                className="backlog-link"
                                onClick={(e) => {
                                  // 行クリック（詳細を開く）と分離する。
                                  e.stopPropagation()
                                  e.preventDefault()
                                  void openFileByRelPath(part.relPath!)
                                }}
                              >
                                {part.label}
                              </a>
                            ) : (
                              // 外部 URL。main 側の will-navigate ガードが既定ブラウザで開く。
                              <a
                                key={pi}
                                className="backlog-link"
                                href={part.href}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {part.label}
                              </a>
                            )
                          )}
                        </div>
                      </td>
                    )
                  })}
                  <td className="backlog-jump-col">
                    <button
                      className="backlog-jump-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        jumpToIndexRow(item.line)
                      }}
                      title="索引の該当行へ"
                      aria-label="索引の該当行へ"
                    >
                      ⌖
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  )
}

// バックログの統合ビュー。アクティブ索引と完了索引のどちらを開いていても、
// 「アクティブ項目 +（トグルで）完了項目」を 1 つのビューにまとめて表示する。
// content には開いているファイルの編集中の最新内容が渡る（Preview と同じ流儀）。
// 反対側の索引は backlog store のキャッシュから読む。
function BacklogView({
  def,
  openRelPath,
  content
}: {
  def: BacklogDef
  openRelPath: string
  content: string
}): JSX.Element {
  const indexContents = useBacklogStore((s) => s.indexContents)
  const loadIndex = useBacklogStore((s) => s.loadIndex)

  // 開いているのが完了索引側か。完了索引を開いたときは最初から完了項目を見たいはずなので
  // 「完了を表示」を既定 on にする。
  const openIsCompleted = def.completedIndex != null && openRelPath === def.completedIndex
  const [showCompleted, setShowCompleted] = useState(openIsCompleted)
  const [query, setQuery] = useState('')

  // 反対側（開いていない方）の索引 relPath。
  const otherRelPath = openIsCompleted ? def.activeIndex : def.completedIndex
  // 反対側が必要になるのは、完了索引を開いている（アクティブ側は常に表示する）か、
  // アクティブ索引を開いていて完了トグルが on のとき。
  const needOther = otherRelPath != null && (openIsCompleted || showCompleted)
  useEffect(() => {
    if (needOther && otherRelPath != null) void loadIndex(otherRelPath)
  }, [needOther, otherRelPath, loadIndex])

  // アクティブ側・完了側それぞれの内容。undefined = 読み込み中、null = 読めない。
  const activeSource: string | null | undefined = openIsCompleted
    ? indexContents[def.activeIndex]
    : content
  const completedSource: string | null | undefined = openIsCompleted
    ? content
    : def.completedIndex != null
      ? indexContents[def.completedIndex]
      : null

  const activeSections = useMemo(
    () =>
      typeof activeSource === 'string'
        ? parseBacklogIndex(activeSource, def.activeIndex, def.detailLinkLabel)
        : [],
    [activeSource, def.activeIndex, def.detailLinkLabel]
  )
  const completedSections = useMemo(
    () =>
      typeof completedSource === 'string' && def.completedIndex != null
        ? parseBacklogIndex(completedSource, def.completedIndex, def.detailLinkLabel)
        : [],
    [completedSource, def.completedIndex, def.detailLinkLabel]
  )

  const filteredActive = useMemo(
    () => filterSections(activeSections, query),
    [activeSections, query]
  )
  const filteredCompleted = useMemo(
    () => filterSections(completedSections, query),
    [completedSections, query]
  )

  const activeTotal = countItems(activeSections)
  const activeShown = countItems(filteredActive)
  const completedTotal = countItems(completedSections)
  const completedShown = countItems(filteredCompleted)

  // 完了側の注記。完了索引が設定されていて読めなかったときだけ出す。
  const completedUnavailable = def.completedIndex != null && completedSource === null

  // 件数表示。フィルタ中は「表示中 / 全体」を出す。
  const countLabel =
    query === ''
      ? `${activeTotal} 件${showCompleted ? ` + 完了 ${completedTotal} 件` : ''}`
      : `${activeShown} / ${activeTotal} 件${showCompleted ? ` + 完了 ${completedShown} / ${completedTotal} 件` : ''}`

  return (
    <div className="backlog-view">
      <div className="backlog-toolbar">
        <div className="backlog-filter-box">
          <input
            className="backlog-filter"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="絞り込み（タイトル・状態・概要…）"
            spellCheck={false}
          />
        </div>
        {def.completedIndex != null && (
          <button
            className={`backlog-completed-toggle${showCompleted ? ' active' : ''}`}
            onClick={() => setShowCompleted((v) => !v)}
            disabled={completedUnavailable && !openIsCompleted}
            title={completedUnavailable ? `${def.completedIndex} を読み込めません` : undefined}
            aria-pressed={showCompleted}
          >
            完了を表示
          </button>
        )}
        <span className="backlog-count">{countLabel}</span>
      </div>
      <div className="backlog-body">
        {activeSource === undefined ? (
          // アクティブ索引（反対側）を読み込み中。一瞬なので空のままにする。
          <div className="placeholder" />
        ) : activeSource === null ? (
          <div className="placeholder">
            アクティブ索引（{def.activeIndex}）を読み込めません
          </div>
        ) : activeSections.length === 0 ? (
          <div className="placeholder">
            バックログのテーブルが見つかりません（Edit モードで内容を確認してください）
          </div>
        ) : activeShown === 0 && (!showCompleted || completedShown === 0) ? (
          <div className="placeholder">
            {query === '' ? '項目がありません' : '絞り込みに一致する項目がありません'}
          </div>
        ) : (
          <>
            <SectionTables
              sections={filteredActive}
              completed={false}
              sourceRelPath={def.activeIndex}
              openRelPath={openRelPath}
            />
            {showCompleted && def.completedIndex != null && (
              <>
                <h2 className="backlog-group-title">完了</h2>
                {completedUnavailable ? (
                  <div className="placeholder">完了索引（{def.completedIndex}）を読み込めません</div>
                ) : completedShown === 0 ? (
                  <div className="placeholder">
                    {query === '' ? '完了した項目はありません' : '絞り込みに一致する完了項目がありません'}
                  </div>
                ) : (
                  <SectionTables
                    sections={filteredCompleted}
                    completed={true}
                    sourceRelPath={def.completedIndex}
                    openRelPath={openRelPath}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default BacklogView
