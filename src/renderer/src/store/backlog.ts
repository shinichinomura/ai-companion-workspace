import { create } from 'zustand'
import type { FsEventBatch } from '../../../shared/ipc'

// バックログ設定ファイルのパス（project root 相対）。
// 「索引 Markdown テーブル + 1 項目 1 詳細ファイル」型のバックログ運用を持つプロジェクトが、
// このファイルで索引の場所を宣言する。無いプロジェクトではバックログ機能は一切表に出ない。
export const BACKLOG_CONFIG_PATH = '.noetelier/backlogs.json'

// カンバンのレーンになる状態名の既定値（順序 = レーンの並び順）。
export const DEFAULT_STATUSES = ['未着手', '進行中', '完了', '保留', '取り消し']

// 1 つのバックログ定義（正規化済み）。
export interface BacklogDef {
  // 安定識別子（未指定時は activeIndex）。
  id: string
  // 表示名（未指定時は activeIndex のファイル名）。
  name: string
  // 未完了項目の索引 Markdown（root 相対）。必須。
  activeIndex: string
  // 完了項目の索引 Markdown（root 相対）。無ければ完了表示トグルを出さない。
  completedIndex: string | null
  // 行クリックで開く「詳細リンク」を探すときのリンクラベル。
  detailLinkLabel: string
  // カンバンのレーンになる状態名（配列順に並べる。状態セルはこの名前への先頭一致で振り分ける）。
  statuses: string[]
  // 索引テーブルのカラム名の対応。ヘッダ行のセル名と完全一致で引き当てる。
  titleColumn: string
  statusColumn: string
  tagColumn: string
  summaryColumn: string
}

// 設定ファイルの生 JSON を正規化する。壊れたエントリは除外し、欠損キーは既定値で補う
// （app-settings.ts の normalize と同じ方針。renderer 側で完結する）。
function normalize(raw: unknown): BacklogDef[] {
  if (raw == null || typeof raw !== 'object') return []
  const list = (raw as { backlogs?: unknown }).backlogs
  if (!Array.isArray(list)) return []
  const defs: BacklogDef[] = []
  for (const entry of list) {
    if (entry == null || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const activeIndex = normalizeRelPath(e.activeIndex)
    if (!activeIndex) continue
    const completedIndex = normalizeRelPath(e.completedIndex)
    const statuses = Array.isArray(e.statuses)
      ? e.statuses.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : []
    defs.push({
      id: typeof e.id === 'string' && e.id !== '' ? e.id : activeIndex,
      name:
        typeof e.name === 'string' && e.name !== ''
          ? e.name
          : activeIndex.slice(activeIndex.lastIndexOf('/') + 1),
      activeIndex,
      completedIndex: completedIndex || null,
      detailLinkLabel: str(e.detailLinkLabel, '詳細'),
      statuses: statuses.length > 0 ? statuses : DEFAULT_STATUSES,
      titleColumn: str(e.titleColumn, '作業'),
      statusColumn: str(e.statusColumn, '状態'),
      tagColumn: str(e.tagColumn, 'タグ'),
      summaryColumn: str(e.summaryColumn, '概要')
    })
  }
  return defs
}

// 空でない文字列ならそれを、そうでなければ既定値を返す。
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

// 設定に書かれたパスを root 相対の relPath へ整える（先頭の './' や '/' を除去）。
// 文字列でない・空になる場合は null。
function normalizeRelPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^\.\//, '').replace(/^\//, '')
  return trimmed === '' ? null : trimmed
}

// root 切替やファイル変更で読み直しが交錯したとき、古い応答が新しい状態を
// 上書きしないようにする世代カウンタ（search store と同じ手法）。
let configGen = 0

interface BacklogState {
  // 正規化済みのバックログ定義。設定ファイルが無い・壊れているときは空。
  backlogs: BacklogDef[]
  // 「開いていない側」の索引の内容キャッシュ。relPath → 内容。
  // undefined = 未読み込み、null = 読めなかった（存在しない・バイナリ等）。
  indexContents: Record<string, string | null>

  // .noetelier/backlogs.json を読み直す。root 切替時・設定ファイル変更時に呼ぶ。
  loadConfig: () => Promise<void>
  // 指定索引の内容を読み込んでキャッシュする（BacklogView が反対側索引の表示に使う）。
  loadIndex: (relPath: string) => Promise<void>
  // file watcher の変更バッチを反映する（設定・キャッシュ済み索引の再読み込み）。
  handleFsChanges: (batch: FsEventBatch) => void
  // 指定 relPath がいずれかのバックログの索引（アクティブ / 完了）なら、その定義を返す。
  findByIndexPath: (relPath: string) => BacklogDef | null
}

export const useBacklogStore = create<BacklogState>((set, get) => ({
  backlogs: [],
  indexContents: {},

  loadConfig: async () => {
    const gen = ++configGen
    let backlogs: BacklogDef[] = []
    try {
      const result = await window.api.readFile({ relPath: BACKLOG_CONFIG_PATH })
      if (!result.isBinary) backlogs = normalize(JSON.parse(result.content))
    } catch (err) {
      // ファイルが無い（機能を使わないプロジェクト）は正常系。JSON の構文エラーだけ知らせる。
      if (err instanceof SyntaxError) {
        console.warn(`${BACKLOG_CONFIG_PATH} の JSON が不正なため、バックログ設定を無視します`, err)
      }
    }
    if (gen !== configGen) return
    // 設定が変わったら索引キャッシュも作り直す（パス変更・root 切替の取り残しを防ぐ）。
    set({ backlogs, indexContents: {} })
  },

  loadIndex: async (relPath: string) => {
    const gen = configGen
    let content: string | null = null
    try {
      const result = await window.api.readFile({ relPath })
      if (!result.isBinary) content = result.content
    } catch {
      // 存在しない・読めない索引は null（BacklogView 側で注記を出す）。
    }
    if (gen !== configGen) return
    set((s) => ({ indexContents: { ...s.indexContents, [relPath]: content } }))
  },

  handleFsChanges: (batch: FsEventBatch) => {
    const { indexContents, loadConfig, loadIndex } = get()
    for (const change of batch.changes) {
      if (change.relPath === BACKLOG_CONFIG_PATH) {
        void loadConfig()
        continue
      }
      // キャッシュ済みの索引だけ追従する（開いている側は workspace store が反映する）。
      if (change.relPath in indexContents) {
        if (change.kind === 'unlink') {
          set((s) => ({ indexContents: { ...s.indexContents, [change.relPath]: null } }))
        } else if (change.kind === 'add' || change.kind === 'change') {
          void loadIndex(change.relPath)
        }
      }
    }
  },

  findByIndexPath: (relPath: string) => {
    return (
      get().backlogs.find(
        (b) => b.activeIndex === relPath || b.completedIndex === relPath
      ) ?? null
    )
  }
}))
