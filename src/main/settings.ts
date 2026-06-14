import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

// 最近開いたフォルダの永続化（spec 4.2 / 5.11）。
// 保存先は ~/Library/Application Support/<AppName>/recent-workspaces.json。
// MVP では JSON ファイルで十分とする（SQLite は使わない）。

// 保持する最大件数。
const MAX_RECENT = 10

// 読み書きのたびにファイル I/O しないよう、プロセス内にキャッシュする。
let cache: string[] | null = null

// 永続化ファイルの絶対パス。app 初期化後にのみ呼べる。
function recentFile(): string {
  return join(app.getPath('userData'), 'recent-workspaces.json')
}

// 最近開いたフォルダ一覧を読み込む（新しい順）。失敗時は空配列を返す。
export async function loadRecentFolders(): Promise<string[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(recentFile(), 'utf8')
    const parsed = JSON.parse(raw) as { recent?: unknown }
    cache = Array.isArray(parsed.recent)
      ? parsed.recent.filter((p): p is string => typeof p === 'string')
      : []
  } catch {
    // ファイル未作成・破損時は空として扱う。
    cache = []
  }
  return cache
}

// フォルダを最近開いた一覧の先頭に追加する。重複は除去し、上限で切り詰める。
export async function addRecentFolder(root: string): Promise<void> {
  const list = await loadRecentFolders()
  const next = [root, ...list.filter((p) => p !== root)].slice(0, MAX_RECENT)
  cache = next
  await persist(next)
}

// 存在しなくなったフォルダなどを一覧から除外する。
export async function removeRecentFolder(root: string): Promise<void> {
  const list = await loadRecentFolders()
  if (!list.includes(root)) return
  const next = list.filter((p) => p !== root)
  cache = next
  await persist(next)
}

// 一覧をファイルに書き出す。永続化の失敗は致命的でないため握りつぶす。
async function persist(recent: string[]): Promise<void> {
  try {
    await fs.writeFile(recentFile(), JSON.stringify({ recent }, null, 2), 'utf8')
  } catch {
    // 次回起動で一覧が空になるだけで、アプリの動作は継続できる。
  }
}
