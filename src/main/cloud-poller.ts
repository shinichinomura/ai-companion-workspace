import { promises as fs, realpathSync } from 'fs'
import { join, relative, sep } from 'path'
import type { FsChangeKind } from '../shared/ipc'

// Dropbox（File Provider 方式）・iCloud Drive・OneDrive などのクラウド同期フォルダでは、
// 同期エンジン経由で届いた変更（他端末からの更新・オンライン専用ファイルの実体化など）が
// FSEvents / fs.watch に載らないことがある。chokidar だけに頼ると「ファイルを作った・編集したのに
// アプリで見えない」状態になるため、これらのフォルダでは定期スキャンで差分を拾う安全網を併用する。

// クラウド同期フォルダとみなすパス要素。
const CLOUD_SEGMENT_PATTERNS: RegExp[] = [
  /^CloudStorage$/, // ~/Library/CloudStorage/（Dropbox / OneDrive / Google Drive / Box の File Provider）
  /^Mobile Documents$/, // ~/Library/Mobile Documents/（iCloud Drive）
  /^Dropbox( \(.+\))?$/i,
  /^OneDrive(-.+| - .+)?$/i,
  /^Google ?Drive.*$/i,
  /^Box( Sync)?$/i
]

// root（実体パスも含めて）がクラウド同期フォルダ配下かを判定する。
export function isCloudSyncedPath(root: string): boolean {
  const candidates = [root]
  try {
    candidates.push(realpathSync(root))
  } catch {
    // 解決できない場合は元のパスだけで判定する。
  }
  return candidates.some((p) =>
    p.split(sep).some((seg) => CLOUD_SEGMENT_PATTERNS.some((re) => re.test(seg)))
  )
}

const BASE_INTERVAL_MS = 3000
// 1 回のスキャンで調べる上限（ファイル + フォルダ）。超えたら今回のスキャンは破棄する。
const MAX_SCAN_ENTRIES = 30000
const STAT_BATCH = 64

interface Entry {
  isDir: boolean
  mtimeMs: number
  size: number
}

export interface CloudPoller {
  stop: () => void
}

// root の定期スキャンを開始する。差分は emit(kind, 絶対パス) で通知する。
// isIgnoredName は watcher と同じフォルダ名除外。最初のスキャンは基準線の取得のみで通知しない。
export function startCloudPolling(
  root: string,
  isIgnoredName: (name: string) => boolean,
  emit: (kind: FsChangeKind, absPath: string) => void
): CloudPoller {
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let snapshot: Map<string, Entry> | null = null

  // root 配下を走査してスナップショットを作る。読めないフォルダは前回の内容を引き継ぐ
  // （一時的な失敗を「全削除」と誤検知しないため）。打ち切り時は null。
  async function scan(prev: Map<string, Entry> | null): Promise<Map<string, Entry> | null> {
    const next = new Map<string, Entry>()
    const stack: string[] = [root]
    while (stack.length > 0) {
      if (stopped) return null
      const dir = stack.pop()!
      let dirents
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        if (dir === root) return null
        if (prev) {
          const prefix = dir + sep
          for (const [p, e] of prev) if (p.startsWith(prefix)) next.set(p, e)
        }
        continue
      }
      const files: string[] = []
      for (const d of dirents) {
        // Dropbox の内部ファイル（.dropbox.attrs / .dropbox.cache 等）は通知しない。
        if (d.name.startsWith('.dropbox')) continue
        const abs = join(dir, d.name)
        if (d.isDirectory()) {
          if (isIgnoredName(d.name)) continue
          next.set(abs, { isDir: true, mtimeMs: 0, size: 0 })
          stack.push(abs)
        } else if (d.isFile() || d.isSymbolicLink()) {
          files.push(abs)
        }
        if (next.size + files.length > MAX_SCAN_ENTRIES) return null
      }
      for (let i = 0; i < files.length; i += STAT_BATCH) {
        const batch = files.slice(i, i + STAT_BATCH)
        const stats = await Promise.all(batch.map((f) => fs.stat(f).catch(() => null)))
        batch.forEach((f, idx) => {
          const st = stats[idx]
          if (st && st.isFile()) {
            next.set(f, { isDir: false, mtimeMs: st.mtimeMs, size: st.size })
          } else if (!st && prev?.has(f)) {
            // stat 失敗は前回値を維持する（同期中の一時的な欠落を削除と誤認しない）。
            next.set(f, prev.get(f)!)
          }
        })
      }
      if (next.size > MAX_SCAN_ENTRIES) return null
    }
    return next
  }

  function diff(prev: Map<string, Entry>, next: Map<string, Entry>): void {
    // 親フォルダより先に通知されるよう、パスの浅い順に処理する。
    const added = [...next.keys()].filter((p) => !prev.has(p))
    added.sort((a, b) => depth(a) - depth(b))
    for (const p of added) emit(next.get(p)!.isDir ? 'addDir' : 'add', p)

    for (const [p, e] of next) {
      const old = prev.get(p)
      if (!old || e.isDir || old.isDir) continue
      if (old.mtimeMs !== e.mtimeMs || old.size !== e.size) emit('change', p)
    }

    const removed = [...prev.keys()].filter((p) => !next.has(p))
    removed.sort((a, b) => depth(b) - depth(a))
    for (const p of removed) emit(prev.get(p)!.isDir ? 'unlinkDir' : 'unlink', p)
  }

  function depth(p: string): number {
    return relative(root, p).split(sep).length
  }

  async function tick(): Promise<void> {
    if (stopped) return
    const startedAt = Date.now()
    try {
      const next = await scan(snapshot)
      if (next && !stopped) {
        // 初回は基準線の取得のみ。以降は前回との差分を通知する。
        if (snapshot) diff(snapshot, next)
        snapshot = next
      }
    } catch {
      // スキャン失敗は次回に持ち越す。
    }
    if (stopped) return
    // スキャンが重いフォルダでは間隔を伸ばし、常時 CPU / ディスクを食わないようにする。
    const elapsed = Date.now() - startedAt
    timer = setTimeout(() => void tick(), Math.max(BASE_INTERVAL_MS, elapsed * 5))
  }

  void tick()

  return {
    stop: () => {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
