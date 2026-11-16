const { build } = require('./package.json')

// 公開用は scripts/release-mac.mjs 経由で署名・公証の前提を確認する。
// 通常の package:mac / trial:install は従来どおりローカル試用に使う。
if (!process.env.NOETELIER_RELEASE_IDENTITY || !process.env.APPLE_KEYCHAIN_PROFILE) {
  throw new Error('公開用ビルドは npm run release:mac から実行してください。')
}

module.exports = {
  ...build,
  directories: { output: 'dist/release' },
  forceCodeSigning: true,
  artifactName: '${productName}-${version}-${arch}.${ext}',
  mac: {
    ...build.mac,
    // dmg は初回インストール用、zip は自動更新（electron-updater / Squirrel.Mac）用。
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] }
    ],
    identity: process.env.NOETELIER_RELEASE_IDENTITY,
    hardenedRuntime: true,
    entitlements: 'build/entitlements.release.plist',
    entitlementsInherit: 'build/entitlements.release.plist',
    notarize: true
  },
  dmg: {
    sign: true,
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
      { x: 270, y: 330, type: 'file', path: 'LICENSE' }
    ]
  }
}
