import { app, Menu, BrowserWindow, ipcMain, type MenuItemConstructorOptions } from 'electron'
import { IpcChannel, type WorkLayout } from '../shared/ipc'

// メニューに保持する現在のレイアウト（チェック状態の初期値）。
// 実体の真値は renderer 側（localStorage）。起動時に renderer から通知されて同期される。
let currentLayout: WorkLayout = 'horizontal'

// 隠しファイル（. で始まるファイル）を表示するか。
// 実体の真値は renderer 側（localStorage）。起動時に renderer から通知されて同期される。
let currentShowHidden = false

// 表示メニューでレイアウトが選ばれたら renderer に通知する。
function requestLayout(layout: WorkLayout): void {
  currentLayout = layout
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IpcChannel.SetWorkLayout, layout)
}

// 表示メニューで隠しファイルの表示が切り替えられたら renderer に通知する。
function requestShowHidden(show: boolean): void {
  currentShowHidden = show
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IpcChannel.SetShowHidden, show)
}

// 「ファイル」メニューの「フォルダを開く」が選ばれたら renderer に通知する。
// 実際のフォルダ選択ダイアログは renderer（既存の openFolder フロー）が開く。
function requestOpenFolder(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IpcChannel.RequestOpenFolder)
}

// 「設定…」が選ばれたら renderer に通知する。設定モーダルは renderer 側で開く。
function openSettings(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IpcChannel.OpenSettings)
}

// アプリケーションメニュー（ネイティブのメニューバー）を構築・適用する。
// 「表示」メニューにエディタ/ターミナルの並べ方トグルを置く。
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    // macOS のアプリメニュー（Atelier について / 設定… / 終了 など）。
    // 「設定…」（⌘,）を挟むため role:'appMenu' を使わず手組みする。
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: '設定…',
                accelerator: 'CmdOrCtrl+,',
                click: () => openSettings()
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'フォルダを開く',
          accelerator: 'CmdOrCtrl+O',
          click: () => requestOpenFolder()
        },
        { type: 'separator' },
        // 非 Mac ではアプリメニューが無いため、設定をファイルメニューに置く。
        ...(!isMac
          ? [
              { label: '設定…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
              { type: 'separator' as const }
            ]
          : []),
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
        {
          id: 'show-hidden',
          label: '. で始まるファイルを表示',
          type: 'checkbox',
          checked: currentShowHidden,
          click: (menuItem) => requestShowHidden(menuItem.checked)
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

  // renderer の現在の隠しファイル表示状態を受けて、メニューのチェック状態を同期する。
  ipcMain.on(IpcChannel.ShowHiddenChanged, (_e, show: boolean) => {
    currentShowHidden = show
    const item = Menu.getApplicationMenu()?.getMenuItemById('show-hidden')
    if (item) item.checked = show
  })
}
