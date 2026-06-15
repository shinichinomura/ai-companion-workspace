import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerWorkspaceHandlers, disposeWorkspace } from './workspace'
import { registerTerminalHandlers, disposeTerminal } from './terminal'

// 開発(HMR)と試用(ビルド版)で永続データ（recent-workspaces.json 等）が混ざらないよう、
// 開発時だけ userData ディレクトリを分ける。
// electron-vite dev のときだけ ELECTRON_RENDERER_URL が設定される（preview / パッケージ版では未設定）。
// app ready より前に設定する必要があるため、モジュール読み込み時点で実行する。
if (process.env['ELECTRON_RENDERER_URL']) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

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
  electronApp.setAppUserModelId('com.nomura.claude-code-companion')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // workspace 関連の IPC ハンドラを登録する。
  registerWorkspaceHandlers()
  // 統合ターミナル関連の IPC ハンドラを登録する。
  registerTerminalHandlers()

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
