import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'

// アプリ自身の更新（GitHub Releases の最新版を確認し、ダウンロードして再起動で適用する）。
// 配布は Developer ID 署名 + 公証済みの zip / latest-mac.yml を GitHub Releases に置く前提
// （docs/distribution.md 参照）。更新元は package.json の build.publish で指定している。
//
// 方針:
// - 自動ダウンロード・自動インストールはしない。ユーザーが「ダウンロード」「再起動して更新」を選ぶ。
// - 起動時と一定間隔のチェックは静かに行い、新版があるときだけ通知する（失敗は黙ってログのみ）。
// - メニューからの手動チェックは、最新だった場合・失敗した場合も結果を表示する。

// 起動直後はファイル/ターミナルの初期化を優先し、少し待ってからチェックする。
const STARTUP_CHECK_DELAY_MS = 10_000
// 起動しっぱなしのアプリでも新版に気づけるよう、定期的に静かにチェックする。
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

type Phase = 'idle' | 'checking' | 'downloading' | 'ready'

let phase: Phase = 'idle'
// ダウンロード済みで再起動待ちの版。
let readyVersion: string | null = null
// 「後で」を選んだ版。同じ版を静かなチェックで繰り返し通知しない（手動チェックでは再提示する）。
let dismissedVersion: string | null = null
let initialized = false

// ダイアログの親ウィンドウ。無ければ親なしで表示する。
function dialogParent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function showMessage(options: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const parent = dialogParent()
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
}

// ダウンロードの進捗を Dock アイコンの進捗バーに出す。-1 で非表示。
function setProgress(value: number): void {
  for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(value)
}

// 更新を確認できる環境か。開発(HMR)や未パッケージ実行では app-update.yml が無く確認できない。
function isUpdateSupported(): boolean {
  return app.isPackaged && process.platform === 'darwin'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ダウンロード済みの更新を適用するか確認し、承諾されたら再起動して適用する。
async function promptInstall(version: string): Promise<void> {
  const { response } = await showMessage({
    type: 'info',
    message: `バージョン ${version} をインストールする準備ができました`,
    detail:
      '再起動して更新します。未保存の編集がある場合は、先に保存してから再起動してください。' +
      '「後で」を選んでも、次に「アップデートを確認…」から再起動できます。',
    buttons: ['再起動して更新', '後で'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) autoUpdater.quitAndInstall()
}

// 新版の通知。承諾されたらダウンロードを始め、完了後に再起動の確認へ進む。
async function promptDownload(info: UpdateInfo): Promise<void> {
  const { response } = await showMessage({
    type: 'info',
    message: `新しいバージョン ${info.version} があります`,
    detail: `現在のバージョンは ${app.getVersion()} です。ダウンロードしますか？`,
    buttons: ['ダウンロード', '後で'],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) {
    dismissedVersion = info.version
    return
  }
  phase = 'downloading'
  try {
    await autoUpdater.downloadUpdate()
  } catch {
    // 失敗の通知は 'error' イベント側で行う。ここでは状態だけ戻す。
    phase = 'idle'
    setProgress(-1)
    return
  }
  // 完了処理は 'update-downloaded' イベント側で行う。
}

// 更新を確認する。interactive=true はメニューからの手動実行（結果を必ず表示する）。
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!isUpdateSupported()) {
    if (interactive) {
      await showMessage({
        type: 'info',
        message: 'この実行環境では更新を確認できません',
        detail: '開発中（npm run dev）や未パッケージのアプリでは、更新の確認は無効です。'
      })
    }
    return
  }
  if (phase === 'downloading') {
    if (interactive) {
      await showMessage({ type: 'info', message: '更新をダウンロード中です', detail: '完了までお待ちください。' })
    }
    return
  }
  if (phase === 'ready' && readyVersion) {
    // ダウンロード済み。手動なら再起動の確認を再提示する。静かなチェックでは何もしない。
    if (interactive) await promptInstall(readyVersion)
    return
  }
  if (phase === 'checking') return

  phase = 'checking'
  try {
    const result = await autoUpdater.checkForUpdates()
    phase = 'idle'
    const info = result?.updateInfo
    if (!result || !info || !result.isUpdateAvailable) {
      if (interactive) {
        await showMessage({
          type: 'info',
          message: '最新のバージョンです',
          detail: `Noetelier ${app.getVersion()} は最新です。`
        })
      }
      return
    }
    // 静かなチェックでは、すでに「後で」を選んだ版を繰り返し通知しない。
    if (!interactive && dismissedVersion === info.version) return
    await promptDownload(info)
  } catch (error) {
    phase = 'idle'
    console.error('[updater] 更新の確認に失敗しました:', error)
    if (interactive) {
      await showMessage({
        type: 'warning',
        message: '更新を確認できませんでした',
        detail: errorMessage(error)
      })
    }
  }
}

// 更新機能を初期化する。app ready 後に 1 度だけ呼ぶ。
export function initUpdater(): void {
  if (initialized) return
  initialized = true
  if (!isUpdateSupported()) return

  // ダウンロードも適用も必ずユーザー確認を経る。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false

  autoUpdater.on('download-progress', (p) => setProgress(p.percent / 100))

  autoUpdater.on('update-downloaded', (info) => {
    phase = 'ready'
    readyVersion = info.version
    setProgress(-1)
    void promptInstall(info.version)
  })

  // 署名の不一致（署名なしの試用ビルドなど）やネットワーク断はここに来る。
  autoUpdater.on('error', (error) => {
    console.error('[updater] エラー:', error)
    if (phase === 'downloading') {
      phase = 'idle'
      setProgress(-1)
      void showMessage({
        type: 'warning',
        message: '更新のダウンロードに失敗しました',
        detail: errorMessage(error)
      })
    }
  })

  setTimeout(() => void checkForUpdates(false), STARTUP_CHECK_DELAY_MS).unref()
  setInterval(() => void checkForUpdates(false), PERIODIC_CHECK_INTERVAL_MS).unref()
}
