import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'

// Electron 更新時の回帰確認。設定・ファイル・シェル設定は専用の一時領域を使う。
const root = dirname(dirname(fileURLToPath(import.meta.url)))
// 署名済みアプリは実際の実行ファイルを使い、Chromium の user-data-dir で設定を分離する。
const packagedExecutable = process.env.NOETELIER_SMOKE_EXECUTABLE
// パッケージの検証時は app.asar 内の main / preload / renderer と本番依存を使う。
const mainEntry = process.env.NOETELIER_SMOKE_BUNDLE
  ? join(process.env.NOETELIER_SMOKE_BUNDLE, 'out/main/index.js')
  : join(root, 'out/main/index.js')
const temporary = await mkdtemp(join(tmpdir(), 'noetelier-smoke-'))
const project = join(temporary, 'project')
const userData = join(temporary, 'user-data')
await mkdir(project)
await mkdir(userData)
await writeFile(join(project, 'README.md'), '# Noetelier smoke test\n\nOriginal content.\n')
await writeFile(join(project, 'data.csv'), 'name,value\nexample,42\n')
const bootstrap = join(temporary, 'main.cjs')
await writeFile(bootstrap, `
const { app } = require('electron');
app.setName('Noetelier Smoke Test');
app.setPath('userData', ${JSON.stringify(userData)});
require(${JSON.stringify(mainEntry)});
`)

const env = { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: temporary }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let application
const pageErrors = []
try {
  application = await electron.launch({
    executablePath: packagedExecutable || electronPath,
    args: packagedExecutable ? [`--user-data-dir=${userData}`] : [bootstrap],
    env,
    timeout: 30_000
  })
  assert.equal(await realpath(await application.evaluate(({ app }) => app.getPath('userData'))), await realpath(userData))
  application.context().on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)))
  await application.firstWindow()

  async function waitFor(check, description) {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const result = await check()
      if (result) return result
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`確認できませんでした: ${description}`)
  }

  const rendererId = await waitFor(() => application.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find((contents) => contents.getURL().includes('/index.html'))?.id
  ), 'ワークスペース画面')

  const evaluate = (expression) => application.evaluate(({ webContents }, { id, expression }) =>
    webContents.fromId(id).executeJavaScript(expression), { id: rendererId, expression })
  const api = (method, argument) => evaluate(`window.api[${JSON.stringify(method)}](${JSON.stringify(argument) ?? ''})`)
  await waitFor(() => evaluate('document.readyState === "complete" && Boolean(window.api)'), 'preload と画面の初期化')
  await application.evaluate(({ webContents }, { id, project }) => {
    webContents.fromId(id).send('view:request-open-folder-by-path', project)
  }, { id: rendererId, project })
  await waitFor(() => evaluate('document.body.innerText.includes("README.md")'), 'ファイルツリー')

  assert.equal((await api('readFile', { relPath: 'README.md' })).content, '# Noetelier smoke test\n\nOriginal content.\n')
  await api('writeFile', { relPath: 'saved.txt', content: 'Saved by IPC.\n' })
  assert.equal(await readFile(join(project, 'saved.txt'), 'utf8'), 'Saved by IPC.\n')
  const search = await api('searchInFiles', { query: 'Original content', caseSensitive: true, wholeWord: false, regex: false })
  assert.equal(search.totalMatches, 1)

  // 実際の renderer でファイルを選択し、Markdown プレビューまで通す。
  const renderer = await waitFor(() => application.context().pages().find((page) => page.url().includes('/index.html')), 'renderer のブラウザ接続')
  await renderer.getByText('README.md', { exact: true }).first().click()
  await renderer.getByRole('heading', { name: 'Noetelier smoke test', exact: true }).waitFor()

  // エディタのタブ: 基本は 1 枚（タブバーなし）。⌥クリックで別ファイルを新しいタブに開き、
  // 切り替えても編集内容・表示モードが保たれること、重複タブを作らないことを確認する。
  const tabs = renderer.locator('.editor-tabs .editor-tab')
  const visibleBody = renderer.locator('.editor-tab-body.active')
  assert.equal(await renderer.locator('.editor-tabs').count(), 0)
  // README を Edit にして編集する（未保存の変更を作る）。
  await renderer.locator('.pane-header').getByRole('button', { name: 'Edit', exact: true }).click()
  await renderer.locator('.monaco-container').click()
  await renderer.keyboard.press('ControlOrMeta+a')
  await renderer.keyboard.type('# Edited in tab\n')
  assert.equal(await renderer.locator('.dirty-indicator').count(), 1)
  // ⌥クリックで data.csv を新しいタブで開く。
  await renderer.getByText('data.csv', { exact: true }).first().click({ modifiers: ['Alt'] })
  await waitFor(async () => (await tabs.count()) === 2, '新しいタブで開く')
  await visibleBody.locator('.pane-header').getByText('data.csv').waitFor()
  // README のタブへ戻ると、未保存の編集と Edit 表示がそのまま残っている。
  await tabs.nth(0).click()
  await visibleBody.locator('.pane-header').getByText('README.md').waitFor()
  await visibleBody.getByText('# Edited in tab').waitFor()
  assert.equal(await tabs.nth(0).locator('.dirty-indicator').count(), 1)
  // 既に開いているファイルを通常クリックしたら、重複タブを作らずそのタブへ切り替える。
  await tabs.nth(1).click()
  await renderer.getByText('README.md', { exact: true }).first().click()
  await visibleBody.locator('.pane-header').getByText('README.md').waitFor()
  assert.equal(await tabs.count(), 2)
  // data.csv のタブを閉じるとタブバーが消えて 1 枚に戻り、README の編集は残る。
  await tabs.nth(1).getByRole('button', { name: 'タブを閉じる' }).click()
  await waitFor(async () => (await renderer.locator('.editor-tabs').count()) === 0, 'タブを閉じる')
  await visibleBody.getByText('# Edited in tab').waitFor()

  await evaluate('window.__smokeChanges = []; window.api.onFsEvent(batch => window.__smokeChanges.push(...batch.changes)); void 0;')
  await writeFile(join(project, 'external.txt'), 'External update.\n')
  await waitFor(() => evaluate('window.__smokeChanges.some(change => change.relPath === "external.txt")'), '外部変更通知')

  // 制御したシェルで PTY の起動・入出力・終了を確認。Claude Code や認証情報には触れない。
  await evaluate('window.__smokeOutput = ""; window.__smokeExit = null; window.api.onTerminalData(msg => { if (msg.id === "smoke") window.__smokeOutput += msg.data }); window.api.onTerminalExit(msg => { if (msg.id === "smoke") window.__smokeExit = msg.exitCode }); void 0;')
  const started = await api('terminalStart', { id: 'smoke', cols: 80, rows: 24 })
  assert.equal(started.error, undefined)
  await api('terminalInput', { id: 'smoke', data: "printf 'NOETELIER_%s\\n' PTY_OK\n" })
  await waitFor(() => evaluate('window.__smokeOutput.includes("NOETELIER_PTY_OK")'), 'PTY 入出力')
  await api('terminalResize', { id: 'smoke', cols: 100, rows: 30 })
  await api('terminalInput', { id: 'smoke', data: 'exit 0\n' })
  await waitFor(() => evaluate('window.__smokeExit === 0'), 'PTY 終了通知')
  assert.deepEqual(pageErrors, [])
  if (process.env.NOETELIER_SMOKE_SCREENSHOT) {
    // BrowserWindow の capturePage はタブバーだけになるため、作業用 WebContentsView を取得する。
    const encoded = await application.evaluate(async ({ webContents }, id) =>
      (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), rendererId)
    await writeFile(process.env.NOETELIER_SMOKE_SCREENSHOT, Buffer.from(encoded, 'base64'))
  }
  console.log('OK: 画面起動 / preload / フォルダ表示 / 読み書き / 検索 / Markdown / 外部変更 / PTY 起動・入出力・終了')
} finally {
  if (application) await application.close()
  await rm(temporary, { recursive: true, force: true })
}
