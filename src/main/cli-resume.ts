import { app } from 'electron'
import { execFileSync } from 'child_process'
import { readFileSync, writeFile } from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, join, relative } from 'path'

// 統合ターミナルで動いていた claude / codex の会話を、アプリ再起動後に再開するための記録。
//
// 設計上の注意（CLAUDE.md の原則に対する限定的な例外）:
//   - 読むのは「動作中プロセスの PID に対応するセッション ID（と cwd）」だけ。
//     認証情報・OAuth token・設定ファイルは読まない。~/.claude/sessions/ 配下の `.key` 等にも触れない。
//   - 復元時に実行するのは `claude --resume <id>` / `codex resume <id>` というセッション再開コマンドのみ。
//     会話のプロンプトを自動投入するものではない。

export type CliKind = 'claude' | 'codex'

export interface ResumeInfo {
  kind: CliKind
  // 特定できたセッション ID（UUID）。特定できなかった場合は null（cwd 単位の直近セッションを再開する）。
  sessionId: string | null
  // CLI を起動していた作業ディレクトリ（絶対パス）。project root と異なる場合のみ cd する。
  cwd: string | null
  // 記録した時刻（ms）。古い記録の掃除に使う。
  savedAt: number
}

// project root → terminalId → 再開情報。
export type ResumeStore = Record<string, Record<string, ResumeInfo>>

// 記録を捨てるまでの期間。長期間開かれなかったプロジェクトの記録が残り続けないようにする。
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function storeFile(): string {
  return join(app.getPath('userData'), 'terminal-resume.json')
}

// 保存済みの記録を読み込む。未作成・破損時は空。古い記録は捨てる。
export function loadResumeStore(): ResumeStore {
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as ResumeStore
    const now = Date.now()
    const store: ResumeStore = {}
    for (const [root, byId] of Object.entries(parsed)) {
      for (const [id, info] of Object.entries(byId ?? {})) {
        if (!isValidInfo(info) || now - info.savedAt > MAX_AGE_MS) continue
        ;(store[root] ??= {})[id] = info
      }
    }
    return store
  } catch {
    return {}
  }
}

// 失敗は致命的でない（次回起動で復元できないだけ）ため握りつぶす。
export function saveResumeStore(store: ResumeStore): void {
  writeFile(storeFile(), JSON.stringify(store, null, 2), 'utf8', () => {})
}

function isValidInfo(v: unknown): v is ResumeInfo {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    (o.kind === 'claude' || o.kind === 'codex') &&
    (o.sessionId === null || (typeof o.sessionId === 'string' && UUID_RE.test(o.sessionId))) &&
    (o.cwd === null || typeof o.cwd === 'string') &&
    typeof o.savedAt === 'number'
  )
}

interface ProcRow {
  pid: number
  ppid: number
  comm: string
}

// 全プロセスの一覧を取る。comm は実行ファイルのパス（空白を含みうるため最後の列に置く）。
function listProcesses(): ProcRow[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
    encoding: 'utf8',
    timeout: 3000
  })
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3].trim() })
  }
  return rows
}

// rootPid 配下（子孫）のプロセスを返す。
function descendants(rows: ProcRow[], rootPid: number): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>()
  for (const r of rows) {
    const list = byParent.get(r.ppid)
    if (list) list.push(r)
    else byParent.set(r.ppid, [r])
  }
  const result: ProcRow[] = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const child of byParent.get(pid) ?? []) {
      result.push(child)
      queue.push(child.pid)
    }
  }
  return result
}

// claude の PID に対応するセッション情報（sessionId と cwd のみ）を読む。
// ~/.claude/sessions/<pid>.json を、PID が一致する場合に限って読み、必要な 2 項目だけ取り出す。
function readClaudeSession(pid: number): { sessionId: string; cwd: string | null } | null {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')
    const parsed = JSON.parse(raw) as { pid?: unknown; sessionId?: unknown; cwd?: unknown }
    if (parsed.pid !== pid) return null
    if (typeof parsed.sessionId !== 'string' || !UUID_RE.test(parsed.sessionId)) return null
    return {
      sessionId: parsed.sessionId,
      cwd: typeof parsed.cwd === 'string' && isAbsolute(parsed.cwd) ? parsed.cwd : null
    }
  } catch {
    return null
  }
}

// codex プロセスが開いている rollout ファイル名からセッション ID を取り出す。
// codex は会話の記録ファイル（rollout-<日時>-<uuid>.jsonl）を動作中ずっと開いている。
function readCodexSession(pid: number): { sessionId: string | null; cwd: string | null } {
  let sessionId: string | null = null
  let cwd: string | null = null
  try {
    const out = execFileSync('lsof', ['-p', String(pid), '-Fn'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    // lsof の -F 出力は、n で始まる行がファイル名。cwd は fd 行（fcwd）の直後の n 行。
    let nextIsCwd = false
    for (const line of out.split('\n')) {
      if (line.startsWith('f')) nextIsCwd = line === 'fcwd'
      else if (line.startsWith('n')) {
        const name = line.slice(1)
        if (nextIsCwd && isAbsolute(name)) cwd = name
        nextIsCwd = false
        const m = /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
          name
        )
        if (m) sessionId = m[1]
      }
    }
  } catch {
    // lsof が使えない・権限がない場合は特定できなかったものとして扱う。
  }
  return { sessionId, cwd }
}

// シェル（shellPid）配下で動作中の claude / codex を検出する。無ければ null。
export function detectCli(shellPid: number): Omit<ResumeInfo, 'savedAt'> | null {
  let rows: ProcRow[]
  try {
    rows = listProcesses()
  } catch {
    return null
  }
  for (const p of descendants(rows, shellPid)) {
    // claude: PID 名のセッションファイルがあればそれが claude 本体。
    const claude = readClaudeSession(p.pid)
    if (claude) return { kind: 'claude', sessionId: claude.sessionId, cwd: claude.cwd }
    // PID のセッションファイルは読めないが claude と名乗るプロセス（旧版など）は直近再開に倒す。
    if (basename(p.comm) === 'claude') return { kind: 'claude', sessionId: null, cwd: null }
    if (basename(p.comm) === 'codex') {
      const codex = readCodexSession(p.pid)
      return { kind: 'codex', sessionId: codex.sessionId, cwd: codex.cwd }
    }
  }
  return null
}

// シェル用に文字列を single quote で囲む。
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// 再開用のコマンドを組み立てる。cwd が project root 配下の別ディレクトリなら先に cd する
// （claude / codex は cwd ごとにセッションを管理するため、起動時と同じ場所で再開する必要がある）。
export function buildResumeCommand(info: ResumeInfo, root: string): string {
  let cmd: string
  if (info.kind === 'claude') {
    cmd = info.sessionId ? `claude --resume ${info.sessionId}` : 'claude --continue'
  } else {
    cmd = info.sessionId ? `codex resume ${info.sessionId}` : 'codex resume --last'
  }
  if (info.cwd && info.cwd !== root) {
    const rel = relative(root, info.cwd)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
      cmd = `cd ${shQuote(info.cwd)} && ${cmd}`
    }
  }
  return cmd
}
