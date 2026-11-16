import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--check')) {
  throw new Error('使い方: npm run release:check または npm run release:mac')
}

function run(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    // 公証の認証情報や Keychain の内容を例外へ埋め込まない。
    throw new Error(`${command} が失敗しました (exit ${result.status ?? result.signal})。`)
  }
  return result.stdout ?? ''
}

// ステープル後の DMG の sha512 / size を latest-mac.yml に反映する。
async function refreshUpdateManifest(dmgPath, dmgFileName) {
  const manifestPath = join(root, 'dist/release/latest-mac.yml')
  const manifest = yaml.load(readFileSync(manifestPath, 'utf8'))
  const sha512 = createHash('sha512')
  for await (const chunk of createReadStream(dmgPath)) sha512.update(chunk)
  const digest = sha512.digest('base64')
  const size = statSync(dmgPath).size
  for (const file of manifest.files ?? []) {
    if (file.url === dmgFileName) Object.assign(file, { sha512: digest, size })
  }
  if (manifest.path === dmgFileName) manifest.sha512 = digest
  writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }))
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('公開用ビルドは macOS 上で実行してください。')
  if (process.arch !== 'arm64') throw new Error('この配布設定の検証対象は Apple Silicon Mac です。')

  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true })
  const certificates = [...identities.matchAll(/([A-Fa-f0-9]{40}) "(Developer ID Application: [^"]+)"/g)]
    .map((m) => ({ hash: m[1], name: m[2] }))
  const requested = process.env.NOETELIER_SIGNING_IDENTITY
  const identity = requested
    ? certificates.find((certificate) => certificate.name === requested || certificate.hash === requested)
    : certificates.length === 1 ? certificates[0] : undefined
  const profile = process.env.APPLE_KEYCHAIN_PROFILE
  const missing = []
  if (!identity) missing.push('秘密鍵付きの有効な Developer ID Application 証明書が必要です。複数ある場合は NOETELIER_SIGNING_IDENTITY に証明書名を指定してください。')
  if (!profile) missing.push('APPLE_KEYCHAIN_PROFILE に notarytool の Keychain プロファイル名を指定してください。')
  if (missing.length) throw new Error(missing.join('\n'))

  // electron-builder が別の認証方式を優先しないよう、公証は Keychain に統一する。
  // electron-builder は証明書の種類を含む名前を受け付けないため、検証済みの指紋で指定する。
  const env = { ...process.env, NOETELIER_RELEASE_IDENTITY: identity.hash }
  for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME']) {
    delete env[key]
  }
  const notaryAuth = ['--keychain-profile', profile]
  if (env.APPLE_KEYCHAIN) notaryAuth.push('--keychain', env.APPLE_KEYCHAIN)
  run('/usr/bin/xcrun', ['notarytool', 'history', ...notaryAuth, '--output-format', 'json'], { capture: true, env })
  console.log('Developer ID 署名と公証の認証を確認しました。')
  if (args.includes('--check')) return

  run('npm', ['run', 'build'], { env })
  run(process.execPath, ['scripts/smoke-electron.mjs'], { env })
  run(join(root, 'node_modules/.bin/electron-builder'), ['--config', 'electron-builder.release.cjs', '--mac', '--arm64', '--publish', 'never'], { env })

  const app = join(root, 'dist/release/mac-arm64', `${pkg.productName}.app`)
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  run('/usr/bin/xcrun', ['stapler', 'validate', app])
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  run(process.execPath, ['scripts/smoke-electron.mjs'], {
    env: { ...env, NOETELIER_SMOKE_EXECUTABLE: join(app, 'Contents/MacOS', pkg.productName) }
  })

  // 配布物そのものも公証・ステープルする。未承認なら成功扱いにしない。
  const dmgName = `${pkg.productName}-${pkg.version}-arm64.dmg`
  const dmg = join(root, 'dist/release', dmgName)
  console.log('DMG を Apple の公証サービスへ送信しています。')
  const submission = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'submit', dmg, ...notaryAuth, '--wait', '--output-format', 'json'], { capture: true, env }))
  if (submission.status !== 'Accepted') {
    throw new Error(`DMG の公証は承認されていません: ${submission.status} (id: ${submission.id})`)
  }
  run('/usr/bin/xcrun', ['stapler', 'staple', dmg])
  run('/usr/bin/xcrun', ['stapler', 'validate', dmg])
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg])

  const hash = createHash('sha256')
  for await (const chunk of createReadStream(dmg)) hash.update(chunk)
  writeFileSync(`${dmg}.sha256`, `${hash.digest('hex')}  ${dmgName}\n`)

  // ステープルで DMG の中身が変わったため、自動更新用の latest-mac.yml の DMG エントリを実物に合わせる。
  // （更新本体は zip を使うが、ずれた記述を公開しないようにする。）
  await refreshUpdateManifest(dmg, dmgName)

  const releaseDir = join(root, 'dist/release')
  const assets = [dmgName, `${dmgName}.sha256`, `${pkg.productName}-${pkg.version}-arm64.zip`, `${pkg.productName}-${pkg.version}-arm64.zip.blockmap`, 'latest-mac.yml']
  console.log(`署名・公証済みの配布物（${releaseDir}）:\n${assets.map((a) => `  ${a}`).join('\n')}`)
  console.log('自動更新には zip・blockmap・latest-mac.yml も同じリリースに添付する必要があります。\n公開先へのアップロードはまだ行っていません。')
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
