import { shell, BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { basename, join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IpcChannel, type TabsState } from '../shared/ipc'
import { getProjectRoot, setRootChangedListener } from './workspace'

// タブストリップ（クロームシェル）の高さ。renderer の shell.css の .tabbar と一致させる。
const STRIP_H = 38

// 1 タブ = 1 つの WebContentsView（既存 renderer 1 個まるごと）。
interface Tab {
  // タブの安定 ID。webContents.id をそのまま使う（一意・安定）。
  id: number
  view: WebContentsView
  // 表示用ラベル（プロジェクト名。未選択時は「新規タブ」）。
  title: string
}

// メインウィンドウ（クロームシェルを描画する）。
let win: BrowserWindow | null = null
// 開いているタブ（左から右の表示順）。
let tabs: Tab[] = []
// アクティブタブの id。
let activeId: number | null = null

// preload スクリプトの絶対パス。
function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

// renderer のエントリ（index=タブ本体, shell=タブバー）を読み込む。
// dev は Vite dev server、本番はビルド済み HTML。query で初期動作（restore/root）を渡す。
function loadRenderer(
  view: WebContentsView | BrowserWindow,
  entry: 'index' | 'shell',
  query: Record<string, string> = {}
): void {
  const wc = view.webContents
  const search = new URLSearchParams(query).toString()
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    void wc.loadURL(`${base}/${entry}.html${search ? `?${search}` : ''}`)
  } else {
    void wc.loadFile(join(__dirname, `../renderer/${entry}.html`), search ? { search } : undefined)
  }
}

// 現在のタブ状態をクロームシェルに push する。
function notifyShell(): void {
  if (!win || win.isDestroyed()) return
  const state: TabsState = {
    tabs: tabs.map((t) => ({ id: t.id, title: t.title })),
    activeId
  }
  win.webContents.send(IpcChannel.TabsState, state)
}

// アクティブタブのビューを window 内に正しく配置する。非アクティブは隠す。
function layout(): void {
  if (!win || win.isDestroyed()) return
  const [w, h] = win.getContentSize()
  for (const tab of tabs) {
    const isActive = tab.id === activeId
    tab.view.setVisible(isActive)
    if (isActive) {
      // タブストリップの下に、残り領域いっぱいに配置する。
      tab.view.setBounds({ x: 0, y: STRIP_H, width: w, height: Math.max(0, h - STRIP_H) })
    }
  }
}

// 指定タブをアクティブにする。表示を切り替え、フォーカスを移し、シェルに通知する。
function activateTab(id: number): void {
  if (activeId === id) return
  if (!tabs.some((t) => t.id === id)) return
  activeId = id
  layout()
  const tab = tabs.find((t) => t.id === id)
  if (tab && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.focus()
  }
  notifyShell()
}

// 新しいタブを作成する。
// opts.restore=true なら前回フォルダを自動復元（初期タブ）。root 指定で特定フォルダを開く。
function createTab(opts: { restore?: boolean; root?: string } = {}): Tab {
  if (!win) throw new Error('メインウィンドウが未作成です')

  const view = new WebContentsView({
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 外部リンクは OS の既定ブラウザで開く（アプリ内ナビゲーションを防ぐ）。
  view.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const tab: Tab = { id: view.webContents.id, view, title: '新規タブ' }
  tabs.push(tab)
  win.contentView.addChildView(view)

  // 初期動作を query で renderer に伝える。
  const query: Record<string, string> = {}
  if (opts.root) query.root = opts.root
  else if (opts.restore) query.restore = '1'
  loadRenderer(view, 'index', query)

  activateTab(tab.id)
  notifyShell()
  return tab
}

// 指定タブを閉じる。最後の 1 枚は閉じない（常に 1 タブは残す）。
function closeTab(id: number): void {
  if (tabs.length <= 1) return
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx === -1 || !win) return
  const [tab] = tabs.splice(idx, 1)

  // 閉じたのがアクティブタブなら、隣（右優先、無ければ左）に移す。
  if (activeId === id) {
    const next = tabs[idx] ?? tabs[idx - 1]
    activeId = next ? next.id : null
  }

  win.contentView.removeChildView(tab.view)
  // webContents を破棄する。destroyed で workspace/terminal/git 側の後始末が走る。
  tab.view.webContents.close()

  layout()
  notifyShell()
}

// メディアプロトコルの解決に使う「アクティブタブの project root」。
// 媒体ハンドラは送信元を取れないため、表示中（アクティブ）のタブの root を使う。
export function getActiveTabRoot(): string | null {
  if (activeId === null) return null
  return getProjectRoot(activeId)
}

// アプリメニュー等が操作対象にする「アクティブタブの webContents」。
export function getActiveTabWebContents(): Electron.WebContents | null {
  const tab = tabs.find((t) => t.id === activeId)
  return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null
}

// 全タブの webContents（破棄済みは除く）。レイアウト等を全タブに同報するのに使う。
export function getAllTabWebContents(): Electron.WebContents[] {
  return tabs.filter((t) => !t.view.webContents.isDestroyed()).map((t) => t.view.webContents)
}

// --- アプリメニュー（キーボードショートカット）から呼ぶタブ操作 ---

// 新しいタブ（空）を作成する。⌘T。
export function newTab(): void {
  if (win) createTab()
}

// アクティブタブを閉じる。最後の 1 枚ならウィンドウを閉じる。⌘W。
export function closeActiveTabOrWindow(): void {
  if (tabs.length > 1) {
    if (activeId !== null) closeTab(activeId)
  } else {
    win?.close()
  }
}

// 0 始まりの位置でタブをアクティブにする（範囲外は無視）。⌘1..⌘8。
export function activateTabByIndex(index: number): void {
  const tab = tabs[index]
  if (tab) activateTab(tab.id)
}

// 最後のタブをアクティブにする。⌘9。
export function activateLastTab(): void {
  const tab = tabs[tabs.length - 1]
  if (tab) activateTab(tab.id)
}

// 現在位置から相対移動してタブを切り替える（末尾↔先頭は循環）。⌃Tab / ⌃⇧Tab。
export function activateRelativeTab(delta: number): void {
  if (tabs.length === 0 || activeId === null) return
  const i = tabs.findIndex((t) => t.id === activeId)
  if (i === -1) return
  const n = (((i + delta) % tabs.length) + tabs.length) % tabs.length
  activateTab(tabs[n].id)
}

// メインウィンドウとクロームシェル、初期タブを生成する。app ready 後に 1 度だけ呼ぶ。
export function createMainWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    // 信号機ボタンを、クロームシェルのタブストリップ（高さ STRIP_H）の中に収める。
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win?.show())
  // ウィンドウのリサイズに追従してアクティブビューを配置し直す。
  win.on('resize', layout)

  // ウィンドウ本体（webContents）にクロームシェル（タブバー）を読み込む。
  loadRenderer(win, 'shell')

  // openRoot 成功時にタブのタイトルを更新する（renderer 改修なしで反映）。
  setRootChangedListener((wcId, root) => {
    const tab = tabs.find((t) => t.id === wcId)
    if (!tab) return
    tab.title = root ? basename(root) : '新規タブ'
    notifyShell()
  })

  // 初期タブ。従来どおり前回フォルダを自動復元する。
  win.webContents.once('did-finish-load', () => {
    if (tabs.length === 0) createTab({ restore: true })
  })
}

// クロームシェルからのタブ操作 IPC を登録する。app ready 後に 1 度だけ呼ぶ。
export function registerTabHandlers(): void {
  ipcMain.on(IpcChannel.TabsRequestState, () => notifyShell())
  ipcMain.on(IpcChannel.TabNew, () => createTab())
  ipcMain.on(IpcChannel.TabActivate, (_e, id: number) => activateTab(id))
  ipcMain.on(IpcChannel.TabClose, (_e, id: number) => closeTab(id))
}
