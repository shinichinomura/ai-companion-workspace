import { ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import {
  IpcChannel,
  type TerminalExit,
  type TerminalResizeRequest,
  type TerminalStartRequest,
  type TerminalStartResult
} from '../shared/ipc'
import { getProjectRoot } from './workspace'

// 統合ターミナル（spec 2.2.4）。タブ化に伴い、PTY を「呼び出し元の webContents（=タブ）」
// 単位で保持する。各タブは独立した renderer（WebContentsView）なので e.sender.id で一意に引ける。
// 設計上の制約: Claude Code の認証情報・OAuth token・設定ファイルは読まない／解析しない。
// 裏でプロンプトを投入しない。あくまでユーザーが見えるシェルとして起動するだけ。
interface TerminalState {
  term: pty.IPty
  // 出力／終了の送信先 renderer（その PTY を起動したタブ）。
  target: WebContents
}

// webContents.id → そのタブの PTY 状態。
const stateByWcId = new Map<number, TerminalState>()
// destroyed リスナーを二重登録しないための記録。
const cleanupBound = new Set<number>()

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

// 指定タブの PTY を破棄する。再起動・終了・タブ破棄時に呼ぶ。
function killTerm(wcId: number): void {
  const state = stateByWcId.get(wcId)
  if (!state) return
  stateByWcId.delete(wcId)
  try {
    state.term.kill()
  } catch {
    // 既に死んでいる場合は無視する。
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

  // 既存インスタンスがあれば破棄してから張り替える（root 切替時の再起動）。
  killTerm(wcId)

  // ログイン + インタラクティブシェルとして起動し、プロファイルを source させる。
  const term = pty.spawn(resolveShell(), ['-l', '-i'], {
    name: 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd: root,
    env: buildEnv()
  })
  stateByWcId.set(wcId, { term, target: sender })

  term.onData((data) => {
    if (!sender.isDestroyed()) {
      sender.send(IpcChannel.TerminalData, data)
    }
  })

  term.onExit(({ exitCode }) => {
    const payload: TerminalExit = { exitCode }
    if (!sender.isDestroyed()) {
      sender.send(IpcChannel.TerminalExit, payload)
    }
    // この PTY 用の状態だけを掃除する（別タブの PTY には触れない）。
    if (stateByWcId.get(wcId)?.term === term) {
      stateByWcId.delete(wcId)
    }
  })

  // タブ（webContents）が破棄されたら PTY も後始末する。1 タブにつき 1 度だけ束ねる。
  if (!cleanupBound.has(wcId)) {
    cleanupBound.add(wcId)
    sender.once('destroyed', () => {
      cleanupBound.delete(wcId)
      killTerm(wcId)
    })
  }

  return {}
}

// キー入力を、その送信元タブの PTY に書き込む。
function handleInput(e: Electron.IpcMainEvent, data: string): void {
  stateByWcId.get(e.sender.id)?.term.write(data)
}

// 端末サイズを変更する。
function handleResize(e: Electron.IpcMainEvent, req: TerminalResizeRequest): void {
  // cols/rows は 1 以上でなければ node-pty が例外を投げるため防御する。
  const term = stateByWcId.get(e.sender.id)?.term
  if (term && req.cols > 0 && req.rows > 0) {
    term.resize(req.cols, req.rows)
  }
}

// renderer 側からの明示破棄。
function handleDispose(e: Electron.IpcMainEvent): void {
  killTerm(e.sender.id)
}

// terminal 関連の IPC ハンドラを登録する。app 起動後に 1 度だけ呼ぶ。
export function registerTerminalHandlers(): void {
  ipcMain.handle(IpcChannel.TerminalStart, handleStart)
  ipcMain.on(IpcChannel.TerminalInput, handleInput)
  ipcMain.on(IpcChannel.TerminalResize, handleResize)
  ipcMain.on(IpcChannel.TerminalDispose, handleDispose)
}

// アプリ終了時に全タブの PTY を後始末する。
export function disposeTerminal(): void {
  for (const wcId of [...stateByWcId.keys()]) {
    killTerm(wcId)
  }
}
