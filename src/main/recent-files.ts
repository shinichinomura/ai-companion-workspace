import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

// 最近開いたファイルの永続化。「最近開いたフォルダ」(settings.ts) と対になる仕組み。
// 保存先は ~/Library/Application Support/<AppName>/recent-files.json。
// ファイルの relPath は project root 相対でしか意味を持たないため、
// root（絶対パス）ごとに relPath のリストを分けて保持する。

// 1 つの root あたりの保持最大件数。
const MAX_RECENT_FILES = 15

// root（絶対パス）→ relPath 配列（新しい順）のマップ。プロセス内キャッシュ。
let cache: Record<string, string[]> | null = null

// 永続化ファイルの絶対パス。app 初期化後にのみ呼べる。
function recentFile(): string {
  return join(app.getPath('userData'), 'recent-files.json')
}

// 全 root 分の最近開いたファイルを読み込む。未作成・破損時は空とみなす。
async function loadAll(): Promise<Record<string, string[]>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(recentFile(), 'utf8')
    const parsed = JSON.parse(raw) as { files?: unknown }
    const result: Record<string, string[]> = {}
    if (parsed.files && typeof parsed.files === 'object') {
      for (const [root, list] of Object.entries(parsed.files as Record<string, unknown>)) {
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

// 指定 root の最近開いたファイル一覧（新しい順）を返す。
export async function getRecentFiles(root: string): Promise<string[]> {
  const all = await loadAll()
  return all[root] ?? []
}

// 指定 root の一覧の先頭に relPath を追加する。重複は除去し、上限で切り詰める。更新後の一覧を返す。
export async function addRecentFile(root: string, relPath: string): Promise<string[]> {
  const all = await loadAll()
  const list = all[root] ?? []
  const next = [relPath, ...list.filter((p) => p !== relPath)].slice(0, MAX_RECENT_FILES)
  all[root] = next
  cache = all
  await persist(all)
  return next
}

// 指定 root の一覧から relPath を除外する（存在しないファイルのクリック時など）。更新後の一覧を返す。
export async function removeRecentFile(root: string, relPath: string): Promise<string[]> {
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
export async function setRecentFiles(root: string, relPaths: string[]): Promise<string[]> {
  const all = await loadAll()
  all[root] = relPaths.slice(0, MAX_RECENT_FILES)
  cache = all
  await persist(all)
  return all[root]
}

// マップ全体をファイルに書き出す。永続化の失敗は致命的でないため握りつぶす。
async function persist(files: Record<string, string[]>): Promise<void> {
  try {
    await fs.writeFile(recentFile(), JSON.stringify({ files }, null, 2), 'utf8')
  } catch {
    // 次回起動で一覧が空になるだけで、アプリの動作は継続できる。
  }
}
