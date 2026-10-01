import { app, shell, BrowserWindow, Notification, WebContentsView, ipcMain } from 'electron'
import { basename, join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  IpcChannel,
  type TabsState,
  type TerminalActivateMessage,
  type TerminalActiveChangedMessage,
  type TerminalBellMessage,
  type TerminalUnreadMessage
} from '../shared/ipc'
import { getProjectRoot, setRootChangedListener } from './workspace'
import { syncMenuChecks, forgetTabMenuState, refreshRecentMenu } from './menu'
import { loadSession, saveSession } from './session'

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
// セッション復元中は途中状態を保存しないためのフラグ。
let restoring = false

// 現在のタブ構成（各タブの root と順序・アクティブ）を永続化する。
// 起動時にこの内容からタブを再生成する。復元中は途中状態を保存しない。
function persistSession(): void {
  if (restoring) return
  const roots = tabs.map((t) => getProjectRoot(t.id))
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === activeId)
  )
  saveSession({ roots, activeIndex })
}

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
// attention は「そのタブ内に未確認（ベルが鳴ったが未表示）のターミナルがあるか」の集約。
function notifyShell(): void {
  if (!win || win.isDestroyed()) return
  const state: TabsState = {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      attention: (unreadTerminals.get(t.id)?.size ?? 0) > 0
    })),
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
  // メニューのチェック状態をこのタブの値に合わせる。
  syncMenuChecks(id)
  // 切り替えた先で見えているターミナルが未確認だったら印を消す。
  clearUnreadIfViewing(id)
  notifyShell()
  persistSession()
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
  // window.open / target=_blank 経由の遷移を捕捉する。
  view.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // プレーンなリンククリック等による http(s) への遷移も既定ブラウザで開く。
  // Markdown プレビュー内の外部リンクをクリックすると WebContentsView 自体が
  // その URL へ遷移してアプリ本体が置き換わってしまうため、ここで遷移を止めて
  // OS の既定ブラウザに委ねる。レンダラー本体の読み込みは loadURL 経由で
  // will-navigate を発火しないため影響しない。
  view.webContents.on('will-navigate', (event, url) => {
    if (/^https?:\/\//i.test(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
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
  forgetTabMenuState(id)
  // このアプリタブに紐づくベル関連の状態を掃除する（webContents.id は再利用されうるため）。
  activeTerminalByWc.delete(id)
  unreadTerminals.delete(id)
  for (const key of [...lastBellAt.keys()]) {
    if (key.startsWith(`${id}:`)) lastBellAt.delete(key)
  }

  // 閉じた結果アクティブが変わったら、そのタブの値でメニューを同期する。
  if (activeId !== null) syncMenuChecks(activeId)
  layout()
  notifyShell()
  persistSession()
}

// ベル通知の連打を抑えるためのスロットル間隔（ms）と、ターミナルごとの最終通知時刻。
// claude CLI は操作待ちで複数回ベルを鳴らすことがあるため、短時間の重複通知を間引く。
// キーは `${アプリタブの webContents.id}:${ターミナル id}`。同一アプリタブ内でも別ターミナルなら
// それぞれ通知できるよう、ターミセル単位でスロットルする。
const BELL_THROTTLE_MS = 2000
const lastBellAt = new Map<string, number>()

// 各アプリタブ（webContents.id）で現在アクティブなターミナル（サブタブ）の id。
// renderer が切替のたびに報告する。これにより「今まさに見ているターミナルが鳴ったとき」だけ
// 通知を抑制でき、同じアプリタブ内でも非アクティブなターミナルのベルは通知できる。
const activeTerminalByWc = new Map<number, string>()

// 各アプリタブ（webContents.id）ごとの「未確認（ベルが鳴ったがまだ見ていない）ターミナル id」の集合。
// OS 通知を閉じても、そのターミナルを実際に見るまで印を残し続けるための状態。
// 見た（フォーカス済み＋アクティブアプリタブ＋アクティブサブタブ）時点で該当 id を取り除く。
const unreadTerminals = new Map<number, Set<string>>()

// 指定アプリタブの未確認ターミナル id 一覧を、そのタブの renderer に push する（サブタブの印用）。
function pushUnreadToTab(wcId: number): void {
  const tab = tabs.find((t) => t.id === wcId)
  if (!tab || tab.view.webContents.isDestroyed()) return
  const payload: TerminalUnreadMessage = { ids: [...(unreadTerminals.get(wcId) ?? [])] }
  tab.view.webContents.send(IpcChannel.TerminalUnread, payload)
}

// あるターミナルを未確認として印を立てる。スロットルや通知可否とは無関係に、
// 「見ていないターミナルが鳴った」時点で必ず立てる。既に立っていれば再送しない。
function markTerminalUnread(wcId: number, terminalId: string): void {
  let set = unreadTerminals.get(wcId)
  if (!set) {
    set = new Set()
    unreadTerminals.set(wcId, set)
  }
  if (set.has(terminalId)) return
  set.add(terminalId)
  pushUnreadToTab(wcId)
  notifyShell()
}

// 指定アプリタブを「今まさに見ている」なら、その時アクティブなターミナルの未確認印を消す。
// 見ている条件＝ウィンドウフォーカス済み かつ そのアプリタブがアクティブ。
// アプリタブ切替・サブタブ切替・ウィンドウ復帰の各契機から呼ぶ。
function clearUnreadIfViewing(wcId: number): void {
  if (!win || win.isDestroyed()) return
  if (!win.isFocused() || activeId !== wcId) return
  const termId = activeTerminalByWc.get(wcId)
  if (termId === undefined) return
  const set = unreadTerminals.get(wcId)
  if (!set || !set.delete(termId)) return
  if (set.size === 0) unreadTerminals.delete(wcId)
  pushUnreadToTab(wcId)
  notifyShell()
}

// ターミナルでベルが鳴ったときの処理。ユーザーが「今まさにそのターミナルを見ている」とき
// （ウィンドウフォーカス済み かつ アクティブアプリタブ かつ そのターミナルがアクティブなサブタブ）
// だけ通知を抑制する。それ以外（別アプリタブ／別ウィンドウ／別アプリ／同じアプリタブの非アクティブな
// 別ターミナル）は、アプリ自体がアクティブでも OS 通知を出す。クリックで発生元アプリタブ＋
// 発生元ターミナルへ復帰できるようにする。
function handleTerminalBell(wcId: number, terminalId: string, label: string): void {
  if (!win || win.isDestroyed()) return
  const tab = tabs.find((t) => t.id === wcId)
  if (!tab) return

  // 今まさに見ているターミナルが鳴ったときだけ抑制する。
  const viewingThisTerminal =
    win.isFocused() && activeId === wcId && activeTerminalByWc.get(wcId) === terminalId
  if (viewingThisTerminal) return

  // 未確認の印を立てる。OS 通知を閉じても、そのターミナルを見るまでタブ／サブタブに残す。
  // スロットルや通知可否より前に行い、通知が出なくても印は必ず立てる。
  markTerminalUnread(wcId, terminalId)

  // 連打スロットル（ターミナル単位）。ここから先は OS 通知の間引きにのみ効く。
  const key = `${wcId}:${terminalId}`
  const now = Date.now()
  const prev = lastBellAt.get(key) ?? 0
  if (now - prev < BELL_THROTTLE_MS) return
  lastBellAt.set(key, now)

  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: tab.title,
    body: `${label} が操作待ちです`,
    silent: false
  })
  // 通知クリックでウィンドウを前面に出し、該当アプリタブへ切り替え、さらにその中の
  // 発生元ターミナル（サブタブ）をアクティブにするよう renderer へ促す。
  notification.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    // 別アプリにフォーカスがある場合に Noetelier を前面化する（macOS）。
    if (process.platform === 'darwin') app.focus({ steal: true })
    activateTab(wcId)
    const target = tabs.find((t) => t.id === wcId)
    if (target && !target.view.webContents.isDestroyed()) {
      const payload: TerminalActivateMessage = { id: terminalId }
      target.view.webContents.send(IpcChannel.TerminalActivate, payload)
    }
  })
  notification.show()
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
  // ウィンドウが前面に戻ったら、今見えているターミナルが未確認だった場合は印を消す。
  // （アプリタブ・サブタブは変わらないままフォーカスだけ戻る経路をここで拾う。）
  win.on('focus', () => {
    if (activeId !== null) clearUnreadIfViewing(activeId)
  })

  // ウィンドウ本体（webContents）にクロームシェル（タブバー）を読み込む。
  loadRenderer(win, 'shell')

  // openRoot 成功時にタブのタイトルを更新し、セッション（各タブの root）を保存する。
  setRootChangedListener((wcId, root) => {
    const tab = tabs.find((t) => t.id === wcId)
    if (!tab) return
    tab.title = root ? basename(root) : '新規タブ'
    // フォルダを切り替えるとそのタブのターミナルは作り直され（id を採番し直す）、
    // 旧ターミナルの未確認状態は無意味になる。放置すると新ターミナルが同じ id を
    // 再利用して誤って印が付くため、このタブの未確認状態はリセットする。
    if (unreadTerminals.delete(wcId)) pushUnreadToTab(wcId)
    notifyShell()
    persistSession()
    // フォルダを開くと最近フォルダ一覧が変化するため、メニューを再構築する。
    if (root) void refreshRecentMenu()
  })

  // シェルの読み込み完了後に、前回のタブセッションを復元する。
  win.webContents.once('did-finish-load', () => {
    if (tabs.length === 0) restoreSession()
  })
}

// 前回のタブセッションを復元する。保存が無ければ従来どおり 1 タブで前回フォルダを復元する。
function restoreSession(): void {
  const saved = loadSession()
  // 復元中は保存しない。各タブの root は renderer が非同期にフォルダを開いて初めて確定するため、
  // ここで保存すると root 未確定（null）でセッションを上書きしてしまう。
  // 復元後は、各タブがフォルダを開いた時点で rootChangedCb が正しい root で保存する。
  restoring = true
  if (saved && saved.roots.length > 0) {
    // 保存された各タブを順に再生成する（root 付きならそのフォルダを開く）。
    for (const root of saved.roots) createTab(root ? { root } : {})
  } else {
    // 初回起動など。従来どおり 1 タブで前回フォルダを自動復元する。
    createTab({ restore: true })
  }

  // 復元後のアクティブタブを確定して表示・メニュー・シェルを同期する。
  const target = (saved && tabs[saved.activeIndex]) || tabs[tabs.length - 1]
  if (target && target.id !== activeId) activateTab(target.id)
  restoring = false
}

// クロームシェルからのタブ操作 IPC を登録する。app ready 後に 1 度だけ呼ぶ。
export function registerTabHandlers(): void {
  ipcMain.on(IpcChannel.TabsRequestState, () => notifyShell())
  ipcMain.on(IpcChannel.TabNew, () => createTab())
  ipcMain.on(IpcChannel.TabActivate, (_e, id: number) => activateTab(id))
  ipcMain.on(IpcChannel.TabClose, (_e, id: number) => closeTab(id))
  // 送信元タブ（e.sender.id）でベルが鳴った。今まさに見ているターミナル以外は OS 通知を出す。
  ipcMain.on(IpcChannel.TerminalBell, (e, msg: TerminalBellMessage) =>
    handleTerminalBell(e.sender.id, msg.id, msg.label)
  )
  // 各アプリタブが、現在アクティブなターミナル（サブタブ）の id を報告する。
  // 報告後、そのターミナルを今まさに見ているなら未確認の印を消す。
  ipcMain.on(IpcChannel.TerminalActiveChanged, (e, msg: TerminalActiveChangedMessage) => {
    activeTerminalByWc.set(e.sender.id, msg.id)
    clearUnreadIfViewing(e.sender.id)
  })
}
