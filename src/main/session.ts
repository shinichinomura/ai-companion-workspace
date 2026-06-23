import { app } from 'electron'
import { readFileSync, writeFile } from 'fs'
import { join } from 'path'

// 開いていたタブ群（複数プロジェクト）の永続化。
// 保存先は ~/Library/Application Support/<AppName>/tab-session.json。
// 起動時にこの内容からタブを再生成し、前回のワークスペースを復元する。

export interface TabSession {
  // 各タブの project root（絶対パス）。フォルダ未選択のタブは null。表示順（左→右）。
  roots: (string | null)[]
  // アクティブタブの位置（roots のインデックス）。
  activeIndex: number
}

// 永続化ファイルの絶対パス。app 初期化後にのみ呼べる。
function sessionFile(): string {
  return join(app.getPath('userData'), 'tab-session.json')
}

// 前回のタブセッションを読み込む。未作成・破損時は null（＝復元なし）。
export function loadSession(): TabSession | null {
  try {
    const raw = readFileSync(sessionFile(), 'utf8')
    const parsed = JSON.parse(raw) as { roots?: unknown; activeIndex?: unknown }
    if (!Array.isArray(parsed.roots)) return null
    const roots = parsed.roots.map((r) => (typeof r === 'string' ? r : null))
    if (roots.length === 0) return null
    const activeIndex =
      typeof parsed.activeIndex === 'number' &&
      parsed.activeIndex >= 0 &&
      parsed.activeIndex < roots.length
        ? parsed.activeIndex
        : 0
    return { roots, activeIndex }
  } catch {
    // ファイル未作成・破損時は復元しない。
    return null
  }
}

// 現在のタブセッションを保存する。失敗は致命的でないため握りつぶす。
export function saveSession(session: TabSession): void {
  writeFile(sessionFile(), JSON.stringify(session, null, 2), 'utf8', () => {
    // 次回起動で復元できないだけで、アプリの動作は継続できる。
  })
}
