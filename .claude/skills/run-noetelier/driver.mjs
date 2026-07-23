// Noetelier のビルド済みアプリ（out/）を Playwright で起動・操作するためのライブラリ。
// シナリオスクリプトから import して使う（この環境には tmux が無いため、
// REPL 型ではなくワンショットのシナリオ実行を前提にしている）。
//
// 事前条件: npm run build 済みであること（out/ を起動する）。
//
// 使い方:
//   import { launchApp } from './driver.mjs'
//   const t = await launchApp({ root: '/path/to/project' })
//   try {
//     await t.openByRelPath('docs/work/work-backlog.md')
//     await t.clickButton('バックログ')
//     await t.shot('backlog')
//   } finally {
//     await t.close()
//   }
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const SKILL_DIR = path.dirname(new URL(import.meta.url).pathname)
const APP_DIR = path.resolve(SKILL_DIR, '../../..')

// アプリを起動し、操作ヘルパー一式を返す。
// - root: 開くプロジェクトの絶対パス。tab-session.json に種付けするので
//   ネイティブのフォルダ選択ダイアログを通らずに開ける。
// - userData は実行ごとに一時ディレクトリへ隔離する（実ユーザーの試用版データを汚さない）。
// - スクショの保存先は SCREENSHOT_DIR 環境変数、無ければ一時ディレクトリ。
export async function launchApp({ root }) {
  if (!fs.existsSync(path.join(APP_DIR, 'out/main/index.js'))) {
    throw new Error('out/ がありません。先に npm run build を実行してください')
  }

  // 実行ごとに独立した userData を作り、前回タブとして root を種付けする。
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'noetelier-test-'))
  fs.writeFileSync(
    path.join(userData, 'tab-session.json'),
    JSON.stringify({ roots: [root], activeIndex: 0 })
  )

  const shotDir = process.env.SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'noetelier-shots-'))
  fs.mkdirSync(shotDir, { recursive: true })

  const env = { ...process.env, NOET_TEST_USERDATA: userData }
  // これが残っていると Electron が素の Node として起動して落ちる（CLAUDE.md 既知の注意）。
  delete env.ELECTRON_RUN_AS_NODE
  // これが残っていると dev 判定になり dev サーバーへ繋ぎにいってしまう。
  delete env.ELECTRON_RENDERER_URL

  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [path.join(SKILL_DIR, 'wrapper.cjs')],
    env,
    timeout: 30_000
  })

  // タブ本体（index.html）のページを待つ。shell.html はタブバーのみで実 UI は無い。
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => w.url().includes('index.html'))
    if (!page) await new Promise((r) => setTimeout(r, 500))
  }
  if (!page) {
    const urls = app.windows().map((w) => w.url())
    await app.close().catch(() => {})
    throw new Error(`index.html のページが見つかりません。windows: ${urls.join(', ')}`)
  }
  // ファイルツリーが出るまで待つ（root の読み込み完了の合図）。
  await page.waitForSelector('.tree-row', { timeout: 15_000 })

  const t = {
    app,
    page,
    shotDir,

    // スクリーンショットを撮り、保存パスを返す（必ず目視確認すること）。
    async shot(name) {
      const f = path.join(shotDir, `${name}.png`)
      await page.screenshot({ path: f })
      console.log('screenshot:', f)
      return f
    },

    // ファイルツリーの項目名（表示テキスト一致）をクリックする。
    // WebContentsView 相手の座標クリックは不安定なため、DOM イベントで行う。
    async clickTree(name) {
      const r = await page.evaluate((n) => {
        const label = [...document.querySelectorAll('.tree-label')].find(
          (e) => e.textContent?.trim() === n
        )
        if (!label) return 'NOT_FOUND'
        label.closest('.tree-row')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return 'OK'
      }, name)
      if (r !== 'OK') throw new Error(`ツリーに見つかりません: ${name}`)
      await page.waitForTimeout(400)
    },

    // relPath をツリー展開しながら開く（例: 'docs/work/work-backlog.md'）。
    async openByRelPath(relPath) {
      for (const seg of relPath.split('/')) await t.clickTree(seg)
      await page.waitForTimeout(300)
    },

    // 表示テキスト一致でボタンをクリックする（Edit / Preview / バックログ 等のトグル類）。
    async clickButton(text) {
      const r = await page.evaluate((tx) => {
        const el = [...document.querySelectorAll('button')].find((e) => e.textContent?.trim() === tx)
        if (!el) return 'NOT_FOUND'
        el.click()
        return 'OK'
      }, text)
      if (r !== 'OK') throw new Error(`ボタンが見つかりません: ${text}`)
      await page.waitForTimeout(300)
    },

    // セレクタ一致の要素を DOM click する（行クリック等）。
    async clickSelector(sel) {
      const r = await page.evaluate((s) => {
        const el = document.querySelector(s)
        if (!el) return 'NOT_FOUND'
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return 'OK'
      }, sel)
      if (r !== 'OK') throw new Error(`要素が見つかりません: ${sel}`)
      await page.waitForTimeout(300)
    },

    // 指定セレクタの innerText を返す（状態確認用）。
    async text(sel) {
      return page.evaluate(
        (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? null,
        sel ?? null
      )
    },

    // 外部からファイルを書き換えた後の反映待ち。
    // chokidar の awaitWriteFinish + debounce(150ms) があるため余裕を持って待つ。
    async waitFsReflect() {
      await page.waitForTimeout(1500)
    },

    async close() {
      await app.close().catch(() => {})
      fs.rmSync(userData, { recursive: true, force: true })
    }
  }
  return t
}
