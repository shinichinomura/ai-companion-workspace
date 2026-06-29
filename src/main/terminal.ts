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
}

// `${webContents.id}:${terminalId}` → そのターミナルの PTY 状態。
const stateByKey = new Map<string, TerminalState>()
// destroyed リスナーを二重登録しないための記録（webContents.id 単位）。
const cleanupBound = new Set<number>()

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
  stateByKey.set(key, { term, target: sender })

  term.onData((data) => {
    if (!sender.isDestroyed()) {
      const payload: TerminalDataMessage = { id: req.id, data }
      sender.send(IpcChannel.TerminalData, payload)
    }
  })

  term.onExit(({ exitCode }) => {
    const payload: TerminalExit = { id: req.id, exitCode }
    if (!sender.isDestroyed()) {
      sender.send(IpcChannel.TerminalExit, payload)
    }
    // このターミナル用の状態だけを掃除する（別ターミナルの PTY には触れない）。
    if (stateByKey.get(key)?.term === term) {
      stateByKey.delete(key)
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
  killTerm(keyOf(e.sender.id, req.id))
}

// terminal 関連の IPC ハンドラを登録する。app 起動後に 1 度だけ呼ぶ。
export function registerTerminalHandlers(): void {
  ipcMain.handle(IpcChannel.TerminalStart, handleStart)
  ipcMain.on(IpcChannel.TerminalInput, handleInput)
  ipcMain.on(IpcChannel.TerminalResize, handleResize)
  ipcMain.on(IpcChannel.TerminalDispose, handleDispose)
}

// アプリ終了時に全タブ・全ターミナルの PTY を後始末する。
export function disposeTerminal(): void {
  for (const key of [...stateByKey.keys()]) {
    killTerm(key)
  }
}
