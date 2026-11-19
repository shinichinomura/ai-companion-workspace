import { ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import {
  IpcChannel,
  type TerminalDataMessage,
  type TerminalDisposeRequest,
  type TerminalExit,
  type TerminalInputMessage,
  type TerminalResizeRequest,
  type TerminalStartRequest,
  type TerminalStartResult
} from '../shared/ipc'
import { getProjectRoot } from './workspace'
import {
  buildResumeCommand,
  detectCli,
  loadResumeStore,
  saveResumeStore,
  type ResumeInfo,
  type ResumeStore
} from './cli-resume'

// 統合ターミナル（spec 2.2.4）。1 タブ（webContents）内に複数のターミナルをタブで開けるよう、
// PTY を「呼び出し元の webContents（=アプリのタブ）」＋「terminalId（タブ内の各ターミナル）」の
// 組で保持する。各アプリタブは独立した renderer（WebContentsView）なので e.sender.id で一意に引け、
// その中で terminalId により複数の PTY を区別する。
// 設計上の制約: Claude Code の認証情報・OAuth token・設定ファイルは読まない／解析しない。
// 裏でプロンプトを投入しない。あくまでユーザーが見えるシェルとして起動するだけ。
interface TerminalState {
  term: pty.IPty
  // 出力／終了の送信先 renderer（その PTY を起動したアプリタブ）。
  target: WebContents
  // この PTY を起動した時点の project root（再開情報のキーに使う）。
  root: string
  // この時刻までは「CLI が見つからない」ことを理由に再開情報を消さない。
  // 再開コマンドを流した直後は CLI がまだ立ち上がっておらず、その間に終了すると記録を失うため。
  graceUntil: number
}

// 再開コマンドを流してから、CLI の起動を待つ猶予（ms）。
const RESUME_GRACE_MS = 60_000
// 端末出力が止まってから再開コマンドを流すまでの待ち（ms）。シェルのプロンプト表示完了を待つ。
const RESUME_IDLE_MS = 500
// シェルが何も出力しなくても、この時間が過ぎたら再開コマンドを流す（ms）。
const RESUME_MAX_WAIT_MS = 8000
// 動作中の CLI を走査して記録を更新する間隔（ms）。
const SCAN_INTERVAL_MS = 10_000

// `${webContents.id}:${terminalId}` → そのターミナルの PTY 状態。
const stateByKey = new Map<string, TerminalState>()
// destroyed リスナーを二重登録しないための記録（webContents.id 単位）。
const cleanupBound = new Set<number>()

// 前回終了時に記録された、各ターミナルで動いていた CLI（claude / codex）。
// 起動直後の PTY に再開コマンドを流すための元データ。起動時に 1 度だけ読み、以後は書き換えない。
let launchResume: ResumeStore = {}
// 現在の記録（launchResume を初期値に、動作中の走査結果で更新してファイルへ保存する）。
let resumeStore: ResumeStore = {}
// 既に再開コマンドを流したターミナル（root + id）。シェルの再起動で二重に再開しないための記録。
const resumed = new Set<string>()
// 終了処理に入ったか。終了時にタブ／PTY が破棄されても、再開情報を消さないために使う。
let quitting = false
let scanTimer: NodeJS.Timeout | null = null

function resumeKey(root: string, id: string): string {
  return `${root}\0${id}`
}

// 再開情報を 1 件消す（ユーザーが明示的にターミナル／タブを閉じたとき）。終了処理中は消さない。
function forgetResume(root: string, id: string): void {
  if (quitting) return
  if (resumeStore[root]?.[id]) {
    delete resumeStore[root][id]
    if (Object.keys(resumeStore[root]).length === 0) delete resumeStore[root]
    saveResumeStore(resumeStore)
  }
}

// ユーザーがアプリタブ（プロジェクト）を閉じたとき、そのタブの全ターミナルの再開情報を捨てる。
// アプリ終了で webContents が破棄される経路とは区別するため、tabs.ts の closeTab から明示的に呼ぶ。
export function forgetResumeForWc(wcId: number): void {
  const prefix = `${wcId}:`
  for (const [key, state] of stateByKey) {
    if (key.startsWith(prefix)) forgetResume(state.root, key.slice(prefix.length))
  }
}

// 動作中の全 PTY を走査し、claude / codex が動いていれば再開情報を記録する。
// 動いていなければ（ユーザーが CLI を終了した）記録を消す。
function scanResume(): void {
  const before = JSON.stringify(resumeStore)
  const now = Date.now()
  for (const [key, state] of stateByKey) {
    const id = key.slice(key.indexOf(':') + 1)
    const info = detectCli(state.term.pid)
    if (info) {
      const entry: ResumeInfo = { ...info, savedAt: now }
      const byId = (resumeStore[state.root] ??= {})
      // 内容が変わらないなら savedAt だけの更新でファイルを書き換えない。
      const prev = byId[id]
      if (
        !prev ||
        prev.kind !== entry.kind ||
        prev.sessionId !== entry.sessionId ||
        prev.cwd !== entry.cwd
      ) {
        byId[id] = entry
      }
    } else if (now > state.graceUntil && resumeStore[state.root]?.[id]) {
      delete resumeStore[state.root][id]
      if (Object.keys(resumeStore[state.root]).length === 0) delete resumeStore[state.root]
    }
  }
  if (JSON.stringify(resumeStore) !== before) saveResumeStore(resumeStore)
}

// アプリ終了の直前に呼ぶ。PTY が破棄される前に最後の走査を行い、以後の破棄で記録を消さないようにする。
export function prepareTerminalQuit(): void {
  if (quitting) return
  try {
    scanResume()
  } catch {
    // 走査の失敗で終了を妨げない。直近の定期走査の記録が残る。
  }
  quitting = true
}

// 前回記録された CLI の再開コマンドを、起動直後のシェルに流す。
// シェルのプロンプトが出る（出力が一旦止まる）のを待ってから、コマンドを実行する。
function scheduleResume(key: string, term: pty.IPty, root: string, id: string, info: ResumeInfo): void {
  const rk = resumeKey(root, id)
  if (resumed.has(rk)) return
  let done = false
  let idleTimer: NodeJS.Timeout | null = null
  const run = (): void => {
    if (done) return
    done = true
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(maxTimer)
    // この PTY が破棄・差し替え済みなら何もしない（次に張られた PTY が改めて再開する）。
    const state = stateByKey.get(key)
    if (state?.term !== term) return
    resumed.add(rk)
    state.graceUntil = Date.now() + RESUME_GRACE_MS
    term.write(buildResumeCommand(info, root) + '\r')
  }
  const maxTimer = setTimeout(run, RESUME_MAX_WAIT_MS)
  // 出力が来るたびに待ちをやり直し、出力が止まったら実行する。
  term.onData(() => {
    if (done) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(run, RESUME_IDLE_MS)
  })
  term.onExit(() => {
    done = true
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(maxTimer)
  })
}

// 状態マップのキーを作る。
function keyOf(wcId: number, id: string): string {
  return `${wcId}:${id}`
}

// 起動するシェルを決める。ユーザーのデフォルトシェル（主に zsh）を使う。
function resolveShell(): string {
  return process.env.SHELL ?? '/bin/zsh'
}

// PTY に渡す環境変数を組み立てる。
// Mac の GUI 起動では PATH が不足しがちだが、ログインシェル（-l）を起動すれば
// シェル自身が .zprofile / .zshrc を読んで PATH を再構築するため、原則これで解決する。
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  // xterm.js 向けに端末種別を明示する。
  env.TERM = 'xterm-256color'
  // CLAUDE.md の落とし穴: ELECTRON_RUN_AS_NODE が子に漏れると挙動が壊れるため除去する。
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

// 指定キーの PTY を破棄する。再起動・終了・タブ破棄時に呼ぶ。
function killTerm(key: string): void {
  const state = stateByKey.get(key)
  if (!state) return
  stateByKey.delete(key)
  try {
    state.term.kill()
  } catch {
    // 既に死んでいる場合は無視する。
  }
}

// 指定アプリタブ（webContents）に属する全ターミナルを破棄する。タブ破棄時に呼ぶ。
function killAllForWc(wcId: number): void {
  const prefix = `${wcId}:`
  for (const key of [...stateByKey.keys()]) {
    if (key.startsWith(prefix)) killTerm(key)
  }
}

// PTY を起動する。project root 未選択時はエラーを返して起動しない。
function handleStart(
  e: Electron.IpcMainInvokeEvent,
  req: TerminalStartRequest
): TerminalStartResult {
  const sender = e.sender
  const wcId = sender.id
  const root = getProjectRoot(wcId)
  if (root === null) {
    return { error: 'フォルダが開かれていません' }
  }

  const key = keyOf(wcId, req.id)
  // 既存インスタンスがあれば破棄してから張り替える（同一 id での再起動）。
  killTerm(key)

  // ログイン + インタラクティブシェルとして起動し、プロファイルを source させる。
  const term = pty.spawn(resolveShell(), ['-l', '-i'], {
    name: 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd: root,
    env: buildEnv()
  })
  // 前回終了時にこのターミナルで claude / codex が動いていたなら、会話を再開する。
  const resumeInfo = launchResume[root]?.[req.id]
  // 再開コマンドを流して CLI が立ち上がるまでは、「CLI が見つからない」で記録を消さない。
  const graceUntil =
    resumeInfo && !resumed.has(resumeKey(root, req.id))
      ? Date.now() + RESUME_MAX_WAIT_MS + RESUME_GRACE_MS
      : 0
  stateByKey.set(key, { term, target: sender, root, graceUntil })
  if (resumeInfo) scheduleResume(key, term, root, req.id, resumeInfo)

  term.onData((data) => {
    if (!sender.isDestroyed()) {
      const payload: TerminalDataMessage = { id: req.id, data }
      sender.send(IpcChannel.TerminalData, payload)
    }
  })

  term.onExit(({ exitCode }) => {
    // この PTY が今もこのキーの現役かを確認する。dispose / 再起動 / 同一 id での張り替え
    // （開発時の StrictMode 二重マウント含む）で既に別の PTY に差し替わっている場合、
    // この onExit は「破棄済みの古い PTY」のものなので、renderer には終了を通知しない。
    // 通知してしまうと、貼り替わった新しい TerminalInstance が「自分のシェルが終了した」と
    // 誤認し、生きているのに「[プロセスが終了しました]」と表示してしまう。
    if (stateByKey.get(key)?.term !== term) {
      return
    }
    // 現役だった PTY が本当に終了した場合のみ、状態を掃除して renderer に通知する。
    stateByKey.delete(key)
    const payload: TerminalExit = { id: req.id, exitCode }
    if (!sender.isDestroyed()) {
      sender.send(IpcChannel.TerminalExit, payload)
    }
  })

  // アプリタブ（webContents）が破棄されたら配下の全 PTY を後始末する。1 タブにつき 1 度だけ束ねる。
  if (!cleanupBound.has(wcId)) {
    cleanupBound.add(wcId)
    sender.once('destroyed', () => {
      cleanupBound.delete(wcId)
      killAllForWc(wcId)
    })
  }

  return {}
}

// キー入力を、指定ターミナルの PTY に書き込む。
function handleInput(e: Electron.IpcMainEvent, msg: TerminalInputMessage): void {
  stateByKey.get(keyOf(e.sender.id, msg.id))?.term.write(msg.data)
}

// 端末サイズを変更する。
function handleResize(e: Electron.IpcMainEvent, req: TerminalResizeRequest): void {
  // cols/rows は 1 以上でなければ node-pty が例外を投げるため防御する。
  const term = stateByKey.get(keyOf(e.sender.id, req.id))?.term
  if (term && req.cols > 0 && req.rows > 0) {
    term.resize(req.cols, req.rows)
  }
}

// renderer 側からの明示破棄（ターミナルタブを閉じたとき）。
function handleDispose(e: Electron.IpcMainEvent, req: TerminalDisposeRequest): void {
  const key = keyOf(e.sender.id, req.id)
  const state = stateByKey.get(key)
  if (state) forgetResume(state.root, req.id)
  killTerm(key)
}

// terminal 関連の IPC ハンドラを登録する。app 起動後に 1 度だけ呼ぶ。
export function registerTerminalHandlers(): void {
  launchResume = loadResumeStore()
  // 現在の記録は前回の内容を引き継ぐ（まだ起動していないターミナルの記録を失わないため）。
  resumeStore = JSON.parse(JSON.stringify(launchResume)) as ResumeStore
  scanTimer = setInterval(() => {
    try {
      scanResume()
    } catch {
      // 走査の失敗は次回に持ち越す。
    }
  }, SCAN_INTERVAL_MS)
  scanTimer.unref()
  ipcMain.handle(IpcChannel.TerminalStart, handleStart)
  ipcMain.on(IpcChannel.TerminalInput, handleInput)
  ipcMain.on(IpcChannel.TerminalResize, handleResize)
  ipcMain.on(IpcChannel.TerminalDispose, handleDispose)
}

// アプリ終了時に全タブ・全ターミナルの PTY を後始末する。
export function disposeTerminal(): void {
  if (scanTimer) clearInterval(scanTimer)
  for (const key of [...stateByKey.keys()]) {
    killTerm(key)
  }
}
