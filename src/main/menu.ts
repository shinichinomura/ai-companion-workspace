import { app, Menu, ipcMain, type MenuItemConstructorOptions } from 'electron'
import { homedir } from 'os'
import { IpcChannel, type WorkLayout } from '../shared/ipc'
import {
  getActiveTabWebContents,
  newTab,
  closeActiveTabOrWindow,
  activateTabByIndex,
  activateLastTab,
  activateRelativeTab
} from './tabs'
import { loadRecentFolders } from './settings'

// 「最近使ったフォルダ」メニューに表示する最大件数。
const RECENT_MENU_LIMIT = 5

// 直近のメニュー構築時に読み込んだ最近フォルダ一覧（新しい順）。
// メニュー構築は同期的（Menu.buildFromTemplate）なため、非同期の読み込み結果をここに保持する。
let recentFolders: string[] = []

// メニューに現在表示しているチェック状態（アクティブタブの値）。buildAppMenu の初期値にも使う。
// 実体の真値は renderer 側（localStorage、root 別）。renderer からの通知で同期される。
let currentLayout: WorkLayout = 'horizontal'

// タブ（webContents.id）ごとのレイアウト。タブ切替時のメニュー同期に使う。
// 全タブが localStorage を共有しつつ root 別に値を持つため、main 側でもタブ単位に保持する。
const layoutByWc = new Map<number, WorkLayout>()

// メニューのレイアウト用ラジオのチェックを更新する。
function applyLayoutCheck(layout: WorkLayout): void {
  currentLayout = layout
  const item = Menu.getApplicationMenu()?.getMenuItemById(
    layout === 'vertical' ? 'layout-vertical' : 'layout-horizontal'
  )
  if (item) item.checked = true
}

// アクティブタブが変わったとき、そのタブの値でメニューのチェックを同期する。tabs.ts が呼ぶ。
export function syncMenuChecks(wcId: number): void {
  applyLayoutCheck(layoutByWc.get(wcId) ?? 'horizontal')
}

// タブが閉じられたら記録を破棄する。tabs.ts が呼ぶ。
export function forgetTabMenuState(wcId: number): void {
  layoutByWc.delete(wcId)
}

// 表示メニューでレイアウトが選ばれたら、アクティブタブの renderer にのみ通知する。
// 注: 全タブは localStorage（同一 session）を共有するため、保存値はタブ共通で、
// 他の開いているタブは次回マウント時にこの値を引き継ぐ。即時の見た目変更は操作中のタブだけ。
function requestLayout(layout: WorkLayout): void {
  currentLayout = layout
  getActiveTabWebContents()?.send(IpcChannel.SetWorkLayout, layout)
}

// 「ファイル」メニューの「フォルダを開く」が選ばれたら、アクティブタブの renderer に通知する。
// 実際のフォルダ選択ダイアログは renderer（既存の openFolder フロー）が開く。
function requestOpenFolder(): void {
  getActiveTabWebContents()?.send(IpcChannel.RequestOpenFolder)
}

// 「最近使ったフォルダ」の項目が選ばれたら、そのパスをアクティブタブの renderer に通知する。
// renderer は既存の openFolderByPath フローで、アクティブタブにそのフォルダを開く。
function requestOpenFolderByPath(path: string): void {
  getActiveTabWebContents()?.send(IpcChannel.RequestOpenFolderByPath, path)
}

// メニュー表示用にパスを短縮する。ホームディレクトリ配下は ~ に置き換える。
function abbreviatePath(p: string): string {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
}

// 「最近使ったフォルダ」サブメニューの項目を構築する。
// 件数が 0 のときは無効化したプレースホルダを 1 件だけ置く。
function buildRecentSubmenu(): MenuItemConstructorOptions[] {
  const items = recentFolders.slice(0, RECENT_MENU_LIMIT)
  if (items.length === 0) {
    return [{ label: '（履歴なし）', enabled: false }]
  }
  return items.map((path) => ({
    label: abbreviatePath(path),
    click: () => requestOpenFolderByPath(path)
  }))
}

// 「設定…」が選ばれたら、アクティブタブの renderer に通知する。設定モーダルは renderer 側で開く。
function openSettings(): void {
  getActiveTabWebContents()?.send(IpcChannel.OpenSettings)
}

// 最近フォルダ一覧を読み込み直してアプリメニューを再構築する。
// フォルダを開いて一覧が変化したときに呼ぶ（tabs.ts の rootChanged から）。
export async function refreshRecentMenu(): Promise<void> {
  recentFolders = await loadRecentFolders()
  buildAppMenu()
}

// アプリケーションメニュー（ネイティブのメニューバー）を構築・適用する。
// 「表示」メニューにエディタ/ターミナルの並べ方トグルを置く。
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    // macOS のアプリメニュー（Noetelier について / 設定… / 終了 など）。
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
          label: '新しいタブ',
          accelerator: 'CmdOrCtrl+T',
          click: () => newTab()
        },
        {
          label: 'フォルダを開く',
          accelerator: 'CmdOrCtrl+O',
          click: () => requestOpenFolder()
        },
        {
          label: '最近使ったフォルダ',
          submenu: buildRecentSubmenu()
        },
        { type: 'separator' },
        {
          // 最後の 1 枚のときはウィンドウを閉じる（= アプリ終了相当）。
          label: 'タブを閉じる',
          accelerator: 'CmdOrCtrl+W',
          click: () => closeActiveTabOrWindow()
        },
        // 非 Mac ではアプリメニューが無いため、設定と終了をファイルメニューに置く。
        ...(!isMac
          ? [
              { type: 'separator' as const },
              { label: '設定…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          : [])
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
        {
          // 各タブは WebContentsView でメインウィンドウ内に置かれるため、既定の
          // toggleDevTools（ドッキング表示）だと UI に重なって見えない。
          // アクティブタブの DevTools を必ず別ウィンドウ（detach）で開閉する。
          label: 'デベロッパーツール',
          accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => {
            const wc = getActiveTabWebContents()
            if (!wc) return
            if (wc.isDevToolsOpened()) wc.closeDevTools()
            else wc.openDevTools({ mode: 'detach' })
          }
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'タブ',
      submenu: [
        {
          label: '次のタブ',
          accelerator: 'Control+Tab',
          click: () => activateRelativeTab(1)
        },
        {
          label: '前のタブ',
          accelerator: 'Control+Shift+Tab',
          click: () => activateRelativeTab(-1)
        },
        { type: 'separator' },
        // ⌘1..⌘8 で位置指定、⌘9 で最後のタブ（ブラウザ慣習）。
        ...Array.from({ length: 9 }, (_, i): MenuItemConstructorOptions => ({
          label: `タブ ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => (i === 8 ? activateLastTab() : activateTabByIndex(i))
        }))
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// レイアウト連携の IPC を登録する。app ready 後に 1 度だけ呼ぶ。
export function registerMenuHandlers(): void {
  // 各タブの現在レイアウト（起動時の localStorage 復元値・以降の変更）を記録する。
  // 報告元がアクティブタブならメニューのチェックも即時に更新する。
  ipcMain.on(IpcChannel.WorkLayoutChanged, (e, layout: WorkLayout) => {
    layoutByWc.set(e.sender.id, layout)
    if (getActiveTabWebContents()?.id === e.sender.id) applyLayoutCheck(layout)
  })
}
