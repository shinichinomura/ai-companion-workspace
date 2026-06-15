import { Menu, BrowserWindow, ipcMain, type MenuItemConstructorOptions } from 'electron'
import { IpcChannel, type WorkLayout } from '../shared/ipc'

// メニューに保持する現在のレイアウト（チェック状態の初期値）。
// 実体の真値は renderer 側（localStorage）。起動時に renderer から通知されて同期される。
let currentLayout: WorkLayout = 'horizontal'

// 表示メニューでレイアウトが選ばれたら renderer に通知する。
function requestLayout(layout: WorkLayout): void {
  currentLayout = layout
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IpcChannel.SetWorkLayout, layout)
}

// 「ファイル」メニューの「フォルダを開く」が選ばれたら renderer に通知する。
// 実際のフォルダ選択ダイアログは renderer（既存の openFolder フロー）が開く。
function requestOpenFolder(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IpcChannel.RequestOpenFolder)
}

// アプリケーションメニュー（ネイティブのメニューバー）を構築・適用する。
// 「表示」メニューにエディタ/ターミナルの並べ方トグルを置く。
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    // macOS のアプリメニュー（Atelier について / 終了 など）。
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'フォルダを開く',
          accelerator: 'CmdOrCtrl+O',
          click: () => requestOpenFolder()
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: '表示',
      submenu: [
        {
          id: 'layout-horizontal',
          label: 'エディタとターミナルを左右に並べる',
          type: 'radio',
          checked: currentLayout === 'horizontal',
          click: () => requestLayout('horizontal')
        },
        {
          id: 'layout-vertical',
          label: 'エディタとターミナルを上下に並べる',
          type: 'radio',
          checked: currentLayout === 'vertical',
          click: () => requestLayout('vertical')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// レイアウト連携の IPC を登録する。app ready 後に 1 度だけ呼ぶ。
export function registerMenuHandlers(): void {
  // renderer の現在レイアウト（起動時の localStorage 復元値・以降の変更）を受けて
  // メニューのチェック状態を同期する。
  ipcMain.on(IpcChannel.WorkLayoutChanged, (_e, layout: WorkLayout) => {
    currentLayout = layout
    const menu = Menu.getApplicationMenu()
    const item = menu?.getMenuItemById(
      layout === 'vertical' ? 'layout-vertical' : 'layout-horizontal'
    )
    if (item) item.checked = true
  })
}
