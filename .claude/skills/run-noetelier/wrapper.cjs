// UI 自動検証用のラッパー main。
// userData を隔離ディレクトリへ差し替えてから、ビルド済みの実 main を読み込む。
// HOME 環境変数の差し替えでは userData を隔離できない（macOS の Electron は
// Application Support をシステム API で解決する）ため、この方式が必要。
// app ready より前に setPath する必要があるので、require の前に実行する。
const { app } = require('electron')
const path = require('path')

if (!process.env.NOET_TEST_USERDATA) {
  console.error('NOET_TEST_USERDATA が未設定です（driver.mjs 経由で起動してください）')
  app.exit(1)
} else {
  app.setPath('userData', process.env.NOET_TEST_USERDATA)
  // このファイルは .claude/skills/run-noetelier/ にあるため、3 つ上がリポジトリルート。
  require(path.join(__dirname, '../../../out/main/index.js'))
}
