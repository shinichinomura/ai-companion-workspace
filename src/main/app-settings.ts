import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  IpcChannel,
  DEFAULT_QUICK_PROMPTS,
  DEFAULT_WATCH_IGNORED_DIRS,
  DEFAULT_PANE_ARRANGEMENT,
  type AppSettings,
  type PaneArrangement,
  type QuickPrompt
} from '../shared/ipc'

// アプリ設定（設定画面）の永続化。
// 保存先は ~/Library/Application Support/<AppName>/app-settings.json。
// 最近開いたフォルダ（recent-workspaces.json）とは別ファイルにし、関心を分離する。
// MVP では JSON ファイルで十分とする。

// 読み書きのたびにファイル I/O しないよう、プロセス内にキャッシュする。
let cache: AppSettings | null = null

// 監視除外フォルダの設定が変わったときの通知先（workspace が watcher を貼り直すために使う）。
// app-settings は workspace に依存しないよう、リスナー登録方式で疎結合にする（配線は index.ts）。
let watchIgnoredChangeCb: ((dirs: string[]) => void) | null = null
export function setWatchIgnoredChangeListener(cb: (dirs: string[]) => void): void {
  watchIgnoredChangeCb = cb
}

// 永続化ファイルの絶対パス。app 初期化後にのみ呼べる。
function settingsFile(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

// 永続化された任意の JSON を、欠損・不正キーをデフォルトで補完した正しい AppSettings に正規化する。
// 設定項目を増やしてもここでデフォルト補完すれば、旧バージョンが書いたファイルとも後方互換を保てる。
function normalize(parsed: unknown): AppSettings {
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  return {
    quickPrompts: normalizeQuickPrompts(obj.quickPrompts),
    watchIgnoredDirs: normalizeWatchIgnoredDirs(obj.watchIgnoredDirs),
    paneArrangement: normalizePaneArrangement(obj.paneArrangement)
  }
}

// ペイン配置を正規化する。不正値・欠損はデフォルト（従来の配置）に倒す。
function normalizePaneArrangement(value: unknown): PaneArrangement {
  const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    terminalFirst:
      typeof obj.terminalFirst === 'boolean'
        ? obj.terminalFirst
        : DEFAULT_PANE_ARRANGEMENT.terminalFirst
  }
}

// 監視除外フォルダ名の配列を正規化する。配列でなければデフォルトに倒す。
// 各要素は空白を除いた非空文字列のみ採用し、重複は除く（設定順は保つ）。
// パス区切りを含む値は「フォルダ名の完全一致」で照合できないため弾く。
function normalizeWatchIgnoredDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_WATCH_IGNORED_DIRS]
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name || name.includes('/') || name.includes('\\')) continue
    if (seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

// クイック操作配列を正規化する。配列でなければデフォルトに倒す。
// 配列であれば（空配列も含め）ユーザーの意図として尊重し、各行を検証する。
function normalizeQuickPrompts(value: unknown): QuickPrompt[] {
  if (!Array.isArray(value)) return DEFAULT_QUICK_PROMPTS.map((q) => ({ ...q }))
  const result: QuickPrompt[] = []
  value.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return
    const e = entry as Record<string, unknown>
    const label = typeof e.label === 'string' ? e.label : ''
    const prompt = typeof e.prompt === 'string' ? e.prompt : ''
    // ラベルもプロンプトも空の行は無効として捨てる。
    if (!label.trim() && !prompt.trim()) return
    const id = typeof e.id === 'string' && e.id ? e.id : `qp-${i}`
    result.push({ id, label, prompt })
  })
  return result
}

// アプリ設定を読み込む。失敗・破損時はデフォルトを返す。
export async function loadAppSettings(): Promise<AppSettings> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8')
    cache = normalize(JSON.parse(raw))
  } catch {
    // ファイル未作成・破損時はデフォルトとして扱う。
    cache = normalize(null)
  }
  return cache
}

// アプリ設定を保存する。正規化してから書き出し、正規化後の値を返す。
export async function saveAppSettings(settings: unknown): Promise<AppSettings> {
  const prev = cache
  const normalized = normalize(settings)
  cache = normalized
  try {
    await fs.writeFile(settingsFile(), JSON.stringify(normalized, null, 2), 'utf8')
  } catch {
    // 永続化に失敗してもプロセス内キャッシュは更新済みなので、当該セッションの動作は継続できる。
  }
  // 監視除外フォルダが変わったときだけ、開いている監視を貼り直すよう通知する。
  if (!sameStringList(prev?.watchIgnoredDirs, normalized.watchIgnoredDirs)) {
    watchIgnoredChangeCb?.(normalized.watchIgnoredDirs)
  }
  return normalized
}

// 文字列配列が（順序を含めて）等しいか。監視除外の変更検出に使う。
function sameStringList(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// 設定取得・保存の IPC を登録する。app ready 後に 1 度だけ呼ぶ。
export function registerAppSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.SettingsGet, () => loadAppSettings())
  ipcMain.handle(IpcChannel.SettingsSet, (_e, settings: unknown) => saveAppSettings(settings))
}
