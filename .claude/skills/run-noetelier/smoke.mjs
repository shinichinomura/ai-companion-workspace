// スモークシナリオ: アプリを起動してプロジェクトを開き、スクリーンショットを撮る。
//   node .claude/skills/run-noetelier/smoke.mjs <projectRoot> [relPath]
// relPath を渡すとそのファイルをツリーから開いた状態も撮る。
import { launchApp } from './driver.mjs'

const [root, relPath] = process.argv.slice(2)
if (!root) {
  console.error('usage: node smoke.mjs <projectRoot> [relPath]')
  process.exit(1)
}

const t = await launchApp({ root })
try {
  await t.shot('01-explorer')
  if (relPath) {
    await t.openByRelPath(relPath)
    await t.shot('02-file-open')
  }
  console.log('SMOKE OK')
} catch (e) {
  console.error('SMOKE FAILED:', e.message)
  await t.shot('99-error').catch(() => {})
  process.exitCode = 1
} finally {
  await t.close()
}
