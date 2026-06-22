import { ipcMain, type WebContents } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { IpcChannel, type GitFileStatus, type GitStatusResult } from '../shared/ipc'

const execFileAsync = promisify(execFile)

// Git 監視はタブ（webContents）単位で持つ。各タブが別 project root を開けるため、
// .git watcher・通知先・root をすべて webContents.id でキーした Map で管理する。
interface GitState {
  // 監視中の project root（絶対パス）。非リポジトリでも root 自体は保持し、
  // computeGitStatus が非リポジトリ判定して isRepo=false を返す。
  gitRoot: string
  // GitStatusChanged の送信先 renderer。
  gitTarget: WebContents
  // .git（index/HEAD/refs）を監視する watcher。非リポジトリ時は null。
  gitWatcher: FSWatcher | null
  // .git 変化通知の debounce タイマー（commit 等で複数ファイルが連続変化するため）。
  gitDebounce: NodeJS.Timeout | null
}

// webContents.id → そのタブの Git 監視状態。
const stateByWcId = new Map<number, GitState>()
const GIT_EVENT_DEBOUNCE_MS = 300

// git コマンドを root を cwd に実行し、stdout を返す。非ゼロ終了・git 不在時は例外。
async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    // 大規模リポジトリの porcelain 出力に備えてバッファを広めに取る。
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
  return stdout
}

// porcelain の 2 文字コード（XY）を 3 状態に集約する。
// X = index 側、Y = 作業ツリー側の状態。--no-renames 前提なので R/C は来ない。
function mapStatus(code: string): GitFileStatus {
  // 追跡対象外の新規ファイル。
  if (code === '??') return 'added'
  const x = code[0]
  const y = code[1]
  // index か作業ツリーのいずれかで削除 → ディスク上に無い（ファントム行）。
  if (x === 'D' || y === 'D') return 'deleted'
  // index へ新規追加。
  if (x === 'A') return 'added'
  // それ以外（M / T など）は変更扱い。
  return 'modified'
}

// 現在の project root の Git status を計算する。
// 非 Git リポジトリ・git 不在の場合は isRepo=false を返す（例外にしない）。
export async function computeGitStatus(root: string | null): Promise<GitStatusResult> {
  if (root === null) return { isRepo: false, statuses: {} }

  // repo 内かどうかと、repo root から見た project root の prefix を得る。
  // project root が repo のサブディレクトリの場合 prefix は 'sub/dir/' のようになる。
  let prefix: string
  try {
    prefix = (await runGit(root, ['rev-parse', '--show-prefix'])).trim()
  } catch {
    // 非リポジトリ・git 不在はここで握りつぶす。
    return { isRepo: false, statuses: {} }
  }

  let out: string
  try {
    // -z: NUL 区切り（パスに空白・日本語が含まれても安全）。
    // --untracked-files=all: 新規ディレクトリを畳まず 1 ファイル単位で列挙する。
    // --no-renames: rename を D + A に分解し、3 状態モデルに素直に載せる。
    // --ignored=no: .gitignore 対象は出さない。
    out = await runGit(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--ignored=no'
    ])
  } catch {
    // rev-parse は通ったが status が失敗するのは稀（壊れた index 等）。空で返す。
    return { isRepo: true, statuses: {} }
  }

  const statuses: Record<string, GitFileStatus> = {}
  // -z 出力は "XY<space>path" を NUL で連結したもの。末尾は空要素になる。
  for (const entry of out.split('\0')) {
    // 2 文字コード + 空白 + 1 文字以上のパスで最低 4 文字。
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    // git のパスは常に repo root 相対・'/' 区切り。
    const repoRelPath = entry.slice(3)
    let relPath = repoRelPath
    if (prefix) {
      // project root 配下のものだけを採用し、prefix を取り除いて root 相対に直す。
      if (!repoRelPath.startsWith(prefix)) continue
      relPath = repoRelPath.slice(prefix.length)
    }
    if (!relPath) continue
    statuses[relPath] = mapStatus(code)
  }
  return { isRepo: true, statuses }
}

// .git の変化を 1 度だけ debounce して、該当タブの renderer に通知する。
function pingGitChanged(wcId: number): void {
  const state = stateByWcId.get(wcId)
  if (!state || state.gitDebounce !== null) return
  state.gitDebounce = setTimeout(() => {
    const s = stateByWcId.get(wcId)
    if (!s) return
    s.gitDebounce = null
    if (!s.gitTarget.isDestroyed()) {
      s.gitTarget.send(IpcChannel.GitStatusChanged)
    }
  }, GIT_EVENT_DEBOUNCE_MS)
}

// project root の .git を監視し、commit / add / checkout 等での status 変化を拾う。
// 通常の file watcher は .git を無視しているため、ここで別途監視する。
export async function startGitWatching(root: string, target: WebContents): Promise<void> {
  const wcId = target.id
  await stopGitWatching(wcId)

  const state: GitState = { gitRoot: root, gitTarget: target, gitWatcher: null, gitDebounce: null }
  stateByWcId.set(wcId, state)

  // .git ディレクトリの実体を解決する（worktree / GIT_DIR 分離にも追従）。
  let gitDir: string
  try {
    gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).trim()
  } catch {
    // 非リポジトリなら監視しない（gitRoot は保持。GitStatus は isRepo=false を返す）。
    return
  }
  if (!gitDir) return

  // 監視開始までの間に stop/張り替えが起きていたら破棄する。
  if (stateByWcId.get(wcId) !== state) return

  // index / HEAD / refs の変化（add・commit・checkout）だけを監視する。
  // objects/ や logs/ はノイズが多く status に直接効かないため対象外。
  state.gitWatcher = chokidar.watch(
    [join(gitDir, 'index'), join(gitDir, 'HEAD'), join(gitDir, 'refs')],
    { ignoreInitial: true }
  )
  state.gitWatcher.on('all', () => pingGitChanged(wcId))
}

// 指定タブの Git 監視を停止し、保留中の通知も破棄する。
export async function stopGitWatching(wcId: number): Promise<void> {
  const state = stateByWcId.get(wcId)
  if (!state) return
  stateByWcId.delete(wcId)
  if (state.gitDebounce !== null) {
    clearTimeout(state.gitDebounce)
    state.gitDebounce = null
  }
  if (state.gitWatcher) {
    const w = state.gitWatcher
    state.gitWatcher = null
    await w.close()
  }
}

// Git 関連の IPC ハンドラを登録する。app 起動後に 1 度だけ呼ぶ。
export function registerGitHandlers(): void {
  // 送信元タブの project root に対して status を計算する。
  ipcMain.handle(IpcChannel.GitStatus, (e) =>
    computeGitStatus(stateByWcId.get(e.sender.id)?.gitRoot ?? null)
  )
}
