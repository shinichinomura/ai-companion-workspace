import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useBacklogStore, type BacklogDef } from '../store/backlog'
import { parseBacklogIndex, type BacklogItem } from './backlog'

// カンバン上の 1 項目。どちらの索引（アクティブ / 完了アーカイブ）由来かを持つ。
type KanbanItem = BacklogItem & { sourceRelPath: string; fromArchive: boolean }

// その他レーンの表示名（設定された状態名のどれにも先頭一致しなかった項目の受け皿）。
const OTHER_LANE = 'その他'

// テキストフィルタ。いずれかのセル本文かタグに部分一致（大文字小文字無視）。
function matchesQuery(item: KanbanItem, query: string): boolean {
  if (query === '') return true
  const q = query.toLowerCase()
  return (
    item.cells.some((c) => c.text.toLowerCase().includes(q)) ||
    item.tags.some((t) => t.toLowerCase().includes(q))
  )
}

// カンバンのカード 1 枚。タイトル・状態補足・概要・タグ・関連リンクを縦に積む。
function KanbanCard({
  item,
  detailLinkLabel,
  openRelPath
}: {
  item: KanbanItem
  detailLinkLabel: string
  openRelPath: string
}): JSX.Element {
  const openFileByRelPath = useWorkspaceStore((s) => s.openFileByRelPath)
  const openFileAtLocation = useWorkspaceStore((s) => s.openFileAtLocation)
  const revealActiveFileAt = useWorkspaceStore((s) => s.revealActiveFileAt)

  // 索引行そのものへジャンプする。開いている索引ならディスク再読込を避けて reveal だけ積む
  // （openFileAtLocation は読み直すため、未保存の編集があると失われる）。
  const jumpToIndexRow = (): void => {
    if (item.sourceRelPath === openRelPath) revealActiveFileAt(item.line)
    else void openFileAtLocation(item.sourceRelPath, item.line, 1, 0)
  }

  // フッタに出す関連リンク。カードクリックと重複する「詳細」リンク自身は除く。
  const footerLinks = item.links.filter(
    (l) => !(l.label === detailLinkLabel && l.relPath === item.detailRelPath)
  )

  return (
    <div
      className={`kanban-card${item.fromArchive ? ' archived' : ''}${item.detailRelPath ? ' clickable' : ''}`}
      onClick={() => {
        if (item.detailRelPath) void openFileByRelPath(item.detailRelPath)
      }}
      title={item.summary || undefined}
    >
      <div className="kanban-card-head">
        <span className="kanban-card-title">{item.title}</span>
        <button
          className="backlog-jump-btn"
          onClick={(e) => {
            e.stopPropagation()
            jumpToIndexRow()
          }}
          title="索引の該当行へ"
          aria-label="索引の該当行へ"
        >
          ⌖
        </button>
      </div>
      {item.statusNote !== '' && <div className="kanban-card-note">{item.statusNote}</div>}
      {item.summary !== '' && <div className="kanban-card-summary">{item.summary}</div>}
      {item.tags.length > 0 && (
        <div className="kanban-card-tags">
          {item.tags.map((tag) => (
            <span key={tag} className="kanban-card-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
      {footerLinks.length > 0 && (
        <div className="kanban-card-links">
          {footerLinks.map((link, i) =>
            link.relPath ? (
              <a
                key={i}
                className="backlog-link"
                onClick={(e) => {
                  // カードクリック（詳細を開く）と分離する。
                  e.stopPropagation()
                  e.preventDefault()
                  void openFileByRelPath(link.relPath!)
                }}
              >
                {link.label}
              </a>
            ) : (
              // 外部 URL。main 側の will-navigate ガードが既定ブラウザで開く。
              <a key={i} className="backlog-link" href={link.href} onClick={(e) => e.stopPropagation()}>
                {link.label}
              </a>
            )
          )}
        </div>
      )}
    </div>
  )
}

// バックログのカンバンビュー。アクティブ索引と完了アーカイブ索引のどちらを開いていても、
// 両索引の項目を状態レーン（設定の statuses 順）へ振り分けて表示する。
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

  // 開いているのが完了アーカイブ側か。その場合は最初からアーカイブ分を見たいはずなので
  // 「完了を表示」を既定 on にする。
  const openIsCompleted = def.completedIndex != null && openRelPath === def.completedIndex
  const [showCompleted, setShowCompleted] = useState(openIsCompleted)
  const [query, setQuery] = useState('')
  // タグ絞り込み（複数選択 = OR）。空なら全表示。
  const [selectedTags, setSelectedTags] = useState<string[]>([])

  // 反対側（開いていない方）の索引 relPath と、その読み込み。
  const otherRelPath = openIsCompleted ? def.activeIndex : def.completedIndex
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

  const parseOptions = useMemo(
    () => ({
      detailLinkLabel: def.detailLinkLabel,
      statuses: def.statuses,
      titleColumn: def.titleColumn,
      statusColumn: def.statusColumn,
      tagColumn: def.tagColumn,
      summaryColumn: def.summaryColumn
    }),
    [def]
  )

  const activeItems = useMemo<KanbanItem[]>(
    () =>
      typeof activeSource === 'string'
        ? parseBacklogIndex(activeSource, def.activeIndex, parseOptions).map((it) => ({
            ...it,
            sourceRelPath: def.activeIndex,
            fromArchive: false
          }))
        : [],
    [activeSource, def.activeIndex, parseOptions]
  )
  const completedItems = useMemo<KanbanItem[]>(
    () =>
      typeof completedSource === 'string' && def.completedIndex != null
        ? parseBacklogIndex(completedSource, def.completedIndex, parseOptions).map((it) => ({
            ...it,
            sourceRelPath: def.completedIndex!,
            fromArchive: true
          }))
        : [],
    [completedSource, def.completedIndex, parseOptions]
  )

  const items = useMemo(
    () => (showCompleted ? [...activeItems, ...completedItems] : activeItems),
    [showCompleted, activeItems, completedItems]
  )

  // タグ絞り込みチップ（出現順・重複なし）。
  const allTags = useMemo(() => {
    const seen: string[] = []
    for (const it of items) for (const t of it.tags) if (!seen.includes(t)) seen.push(t)
    return seen
  }, [items])

  const shown = useMemo(
    () =>
      items.filter(
        (it) =>
          matchesQuery(it, query) &&
          (selectedTags.length === 0 || it.tags.some((t) => selectedTags.includes(t)))
      ),
    [items, query, selectedTags]
  )

  // レーン振り分け。設定の statuses 順 + 一致しなかった項目の「その他」。空レーンは出さない
  // （3 ペイン内の横幅が限られるため。その他レーンは移行漏れの可視化を兼ねる）。
  const lanes = useMemo(() => {
    const byStatus = new Map<string, KanbanItem[]>()
    for (const s of def.statuses) byStatus.set(s, [])
    const others: KanbanItem[] = []
    for (const it of shown) {
      if (it.status != null) byStatus.get(it.status)?.push(it)
      else others.push(it)
    }
    const result = def.statuses
      .map((s) => ({ name: s, items: byStatus.get(s) ?? [] }))
      .filter((lane) => lane.items.length > 0)
    if (others.length > 0) result.push({ name: OTHER_LANE, items: others })
    return result
  }, [shown, def.statuses])

  const toggleTag = (tag: string): void => {
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  // 完了アーカイブ側の注記。設定されていて読めなかったときだけ出す。
  const completedUnavailable = def.completedIndex != null && completedSource === null

  const countLabel =
    query === '' && selectedTags.length === 0
      ? `${items.length} 件`
      : `${shown.length} / ${items.length} 件`

  return (
    <div className="backlog-view">
      <div className="backlog-toolbar">
        <div className="backlog-toolbar-row">
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
        {allTags.length > 0 && (
          <div className="backlog-tagbar">
            {allTags.map((tag) => (
              <button
                key={tag}
                className={`backlog-tag-chip${selectedTags.includes(tag) ? ' active' : ''}`}
                onClick={() => toggleTag(tag)}
                aria-pressed={selectedTags.includes(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="backlog-body">
        {activeSource === undefined ? (
          // アクティブ索引（反対側）を読み込み中。一瞬なので空のままにする。
          <div className="placeholder" />
        ) : activeSource === null ? (
          <div className="placeholder">アクティブ索引（{def.activeIndex}）を読み込めません</div>
        ) : items.length === 0 ? (
          <div className="placeholder">
            バックログの項目がありません（索引のテーブルが見つからないか空です。Edit
            モードで内容を確認してください）
          </div>
        ) : shown.length === 0 ? (
          <div className="placeholder">絞り込みに一致する項目がありません</div>
        ) : (
          <>
            {showCompleted && completedUnavailable && (
              <div className="backlog-notice">完了索引（{def.completedIndex}）を読み込めません</div>
            )}
            <div className="backlog-kanban">
              {lanes.map((lane) => (
                <section key={lane.name} className="kanban-lane">
                  <header className="kanban-lane-header">
                    {lane.name}
                    <span className="kanban-lane-count">{lane.items.length}</span>
                  </header>
                  <div className="kanban-cards">
                    {lane.items.map((item, i) => (
                      <KanbanCard
                        key={`${item.sourceRelPath}:${item.line}:${i}`}
                        item={item}
                        detailLinkLabel={def.detailLinkLabel}
                        openRelPath={openRelPath}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default BacklogView
