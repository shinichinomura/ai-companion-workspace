import { app, BrowserWindow, protocol } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  registerWorkspaceHandlers,
  registerMediaProtocol,
  setActiveRootResolver,
  disposeWorkspace
} from './workspace'
import { registerTerminalHandlers, disposeTerminal } from './terminal'
import { registerGitHandlers } from './git'
import { registerAppSettingsHandlers } from './app-settings'
import { buildAppMenu, refreshRecentMenu, registerMenuHandlers } from './menu'
import { createMainWindow, registerTabHandlers, getActiveTabRoot } from './tabs'
import { MEDIA_SCHEME } from '../shared/ipc'
import { APP_GIT_HASH, buildDetail } from '../shared/build-info'

// 開発(HMR)と試用(ビルド版)で永続データ（recent-workspaces.json 等）が混ざらないよう、
// 開発時だけ userData ディレクトリを分ける。
// electron-vite dev のときだけ ELECTRON_RENDERER_URL が設定される（preview / パッケージ版では未設定）。
// app ready より前に設定する必要があるため、モジュール読み込み時点で実行する。
if (process.env['ELECTRON_RENDERER_URL']) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

// Markdown プレビューの画像表示に使うカスタムスキームを特権スキームとして登録する。
// img の src として読み込めるよう standard/secure 扱いにする。
// この登録は app ready より前に行う必要があるため、モジュール読み込み時点で実行する。
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
])

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.nomura.noetelier')

  // macOS 標準の About パネル（アプリメニュー「Noetelier について」）に版情報を出す。
  // applicationVersion は package.json の version（app.getVersion）、
  // version 行に git ハッシュ + ビルド日時を入れ、どのビルドかを一意に特定できるようにする。
  app.setAboutPanelOptions({
    applicationName: 'Noetelier',
    applicationVersion: app.getVersion(),
    version: buildDetail(),
    copyright: `git ${APP_GIT_HASH}`
  })

  // 開発(HMR)では electron-vite が Electron を直接起動するため、パッケージ版の
  // build/icon.icns が Dock に反映されず素の Electron アイコンが出てしまう。
  // 試用版と同じ見た目にするため、dev のときだけ加工済みマスター PNG を Dock にセットする。
  // 判定は他の dev 分岐と同様に ELECTRON_RENDERER_URL の有無で行う。
  if (process.env['ELECTRON_RENDERER_URL'] && process.platform === 'darwin' && app.dock) {
    const devIconPath = join(app.getAppPath(), 'design/app-icon/master-1024.png')
    if (existsSync(devIconPath)) {
      app.dock.setIcon(devIconPath)
    }
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // workspace 関連の IPC ハンドラを登録する。
  registerWorkspaceHandlers()
  // Markdown プレビューの画像表示用カスタムスキームのハンドラを登録する。
  // 全タブビューは同一 session を共有するため、デフォルト session に 1 度だけ登録すればよい。
  // 解決に使う root は「アクティブタブの root」を tabs.ts から取得する。
  setActiveRootResolver(getActiveTabRoot)
  registerMediaProtocol()
  // 統合ターミナル関連の IPC ハンドラを登録する。
  registerTerminalHandlers()
  // Git status 取得の IPC ハンドラを登録する。
  registerGitHandlers()
  // アプリ設定（設定画面）の取得・保存 IPC を登録する。
  registerAppSettingsHandlers()
  // タブ（クロームシェル）操作の IPC を登録する。
  registerTabHandlers()
  // 表示メニューのレイアウト連携 IPC を登録し、アプリメニューを構築する。
  registerMenuHandlers()
  // まず最近フォルダを読み込まずに即時構築し（メニューバーを早く出す）、
  // 続けて最近フォルダを読み込んで「最近使ったフォルダ」付きで再構築する。
  buildAppMenu()
  void refreshRecentMenu()

  // メインウィンドウ（クロームシェル + 初期タブ）を生成する。
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// macOS 以外では全ウィンドウを閉じたら終了する。Mac 専用 MVP だが定石として残す。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 終了前に file watcher と PTY を後始末する。
app.on('will-quit', () => {
  void disposeWorkspace()
  disposeTerminal()
})
