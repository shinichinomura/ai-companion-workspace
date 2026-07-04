import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

// ブックマーク（よく開くファイルの固定リスト）の永続化。「最近開いたファイル」(recent-files.ts) と
// 対になる仕組みで、こちらはユーザーが明示的に選んだファイルを保持する。
// 保存先は ~/Library/Application Support/<AppName>/bookmarks.json。
// relPath は project root 相対でしか意味を持たないため、root（絶対パス）ごとに分けて保持する。
//
// 最近開いたファイルと違い、件数の上限（自動切り詰め）は設けない。ユーザーが意図して
// 登録したものを勝手に落とさないため。並び順は登録順（新しいものを末尾に足す）で安定させる。

// root（絶対パス）→ relPath 配列（登録順）のマップ。プロセス内キャッシュ。
let cache: Record<string, string[]> | null = null

// 永続化ファイルの絶対パス。app 初期化後にのみ呼べる。
function bookmarksFile(): string {
  return join(app.getPath('userData'), 'bookmarks.json')
}

// 全 root 分のブックマークを読み込む。未作成・破損時は空とみなす。
async function loadAll(): Promise<Record<string, string[]>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(bookmarksFile(), 'utf8')
    const parsed = JSON.parse(raw) as { bookmarks?: unknown }
    const result: Record<string, string[]> = {}
    if (parsed.bookmarks && typeof parsed.bookmarks === 'object') {
      for (const [root, list] of Object.entries(parsed.bookmarks as Record<string, unknown>)) {
        if (Array.isArray(list)) {
          result[root] = list.filter((p): p is string => typeof p === 'string')
        }
      }
    }
    cache = result
  } catch {
    cache = {}
  }
  return cache
}

// 指定 root のブックマーク一覧（登録順）を返す。
export async function getBookmarks(root: string): Promise<string[]> {
  const all = await loadAll()
  return all[root] ?? []
}

// 指定 root のブックマークに relPath を追加する（末尾）。既に登録済みなら何もしない。更新後の一覧を返す。
export async function addBookmark(root: string, relPath: string): Promise<string[]> {
  const all = await loadAll()
  const list = all[root] ?? []
  if (list.includes(relPath)) return list
  const next = [...list, relPath]
  all[root] = next
  cache = all
  await persist(all)
  return next
}

// 指定 root のブックマークから relPath を除外する。更新後の一覧を返す。
export async function removeBookmark(root: string, relPath: string): Promise<string[]> {
  const all = await loadAll()
  const list = all[root] ?? []
  if (!list.includes(relPath)) return list
  const next = list.filter((p) => p !== relPath)
  all[root] = next
  cache = all
  await persist(all)
  return next
}

// 指定 root の一覧を丸ごと置き換える（存在しないファイルの一括掃除に使う）。更新後の一覧を返す。
export async function setBookmarks(root: string, relPaths: string[]): Promise<string[]> {
  const all = await loadAll()
  all[root] = relPaths
  cache = all
  await persist(all)
  return all[root]
}

// マップ全体をファイルに書き出す。永続化の失敗は致命的でないため握りつぶす。
async function persist(bookmarks: Record<string, string[]>): Promise<void> {
  try {
    await fs.writeFile(bookmarksFile(), JSON.stringify({ bookmarks }, null, 2), 'utf8')
  } catch {
    // 次回起動で一覧が空になるだけで、アプリの動作は継続できる。
  }
}
