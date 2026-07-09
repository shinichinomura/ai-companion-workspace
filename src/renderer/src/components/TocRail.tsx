import type { TocEntry } from './toc'

// 目次レール本体（表示のみ）。見出しリストと現在地を受け取り、クリックでジャンプを通知する。
// 配置（フローティング等）は呼び出し側の CSS（.toc-float）が持つ。
function TocRail({
  headings,
  activeKey,
  onJump
}: {
  headings: TocEntry[]
  activeKey: string
  onJump: (key: string) => void
}): JSX.Element {
  return (
    <nav className="toc-rail" aria-label="目次">
      <ul className="toc-list">
        {headings.map((h) => (
          <li key={h.key}>
            <button
              type="button"
              className={`toc-item toc-level-${h.level}${h.key === activeKey ? ' active' : ''}`}
              title={h.text}
              onClick={() => onJump(h.key)}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default TocRail
