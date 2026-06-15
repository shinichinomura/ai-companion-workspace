import { app, shell, BrowserWindow, protocol } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  registerWorkspaceHandlers,
  registerMediaProtocol,
  disposeWorkspace
} from './workspace'
import { registerTerminalHandlers, disposeTerminal } from './terminal'
import { buildAppMenu, registerMenuHandlers } from './menu'
import { MEDIA_SCHEME } from '../shared/ipc'

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

// メインウィンドウを生成する。
// セキュリティ方針（spec 2.3.3）に従い、renderer に Node.js API を直接公開しない。
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    // 信号機ボタンを、renderer 側で用意する高さ 38px のトップバーの中央に配置する。
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 外部リンクは OS のデフォルトブラウザで開く（アプリ内ナビゲーションを防ぐ）。
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 開発時は Vite dev server を、本番ではビルド済み HTML を読み込む。
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.nomura.atelier')

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
  registerMediaProtocol()
  // 統合ターミナル関連の IPC ハンドラを登録する。
  registerTerminalHandlers()
  // 表示メニューのレイアウト連携 IPC を登録し、アプリメニューを構築する。
  registerMenuHandlers()
  buildAppMenu()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
