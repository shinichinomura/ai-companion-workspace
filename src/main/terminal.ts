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

// 統合ターミナル（spec 2.2.4）。MVP は単一インスタンスのため、PTY を 1 個だけ保持する。
// 設計上の制約: Claude Code の認証情報・OAuth token・設定ファイルは読まない／解析しない。
// 裏でプロンプトを投入しない。あくまでユーザーが見えるシェルとして起動するだけ。
let term: pty.IPty | null = null
// 出力／終了の送信先 renderer。
let target: WebContents | null = null

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

// 既存の PTY を破棄する。再起動・終了時に呼ぶ。
function killTerm(): void {
  if (term) {
    const t = term
    term = null
    try {
      t.kill()
    } catch {
      // 既に死んでいる場合は無視する。
    }
  }
  target = null
}

// PTY を起動する。project root 未選択時はエラーを返して起動しない。
function handleStart(
  e: Electron.IpcMainInvokeEvent,
  req: TerminalStartRequest
): TerminalStartResult {
  const root = getProjectRoot()
  if (root === null) {
    return { error: 'フォルダが開かれていません' }
  }

  // 既存インスタンスがあれば破棄してから張り替える（root 切替時の再起動）。
  killTerm()
  target = e.sender

  // ログイン + インタラクティブシェルとして起動し、プロファイルを source させる。
  term = pty.spawn(resolveShell(), ['-l', '-i'], {
    name: 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd: root,
    env: buildEnv()
  })

  term.onData((data) => {
    if (target && !target.isDestroyed()) {
      target.send(IpcChannel.TerminalData, data)
    }
  })

  term.onExit(({ exitCode }) => {
    const payload: TerminalExit = { exitCode }
    if (target && !target.isDestroyed()) {
      target.send(IpcChannel.TerminalExit, payload)
    }
    term = null
    target = null
  })

  return {}
}

// キー入力を PTY に書き込む。
function handleInput(_e: unknown, data: string): void {
  term?.write(data)
}

// 端末サイズを変更する。
function handleResize(_e: unknown, req: TerminalResizeRequest): void {
  // cols/rows は 1 以上でなければ node-pty が例外を投げるため防御する。
  if (term && req.cols > 0 && req.rows > 0) {
    term.resize(req.cols, req.rows)
  }
}

// renderer 側からの明示破棄。
function handleDispose(): void {
  killTerm()
}

// terminal 関連の IPC ハンドラを登録する。app 起動後に 1 度だけ呼ぶ。
export function registerTerminalHandlers(): void {
  ipcMain.handle(IpcChannel.TerminalStart, handleStart)
  ipcMain.on(IpcChannel.TerminalInput, handleInput)
  ipcMain.on(IpcChannel.TerminalResize, handleResize)
  ipcMain.on(IpcChannel.TerminalDispose, handleDispose)
}

// アプリ終了時に PTY を後始末する。
export function disposeTerminal(): void {
  killTerm()
}
