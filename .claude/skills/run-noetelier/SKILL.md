---
name: run-noetelier
description: Noetelier のビルド済みアプリを Playwright で起動・自動操作して UI を検証する。アプリを実際に起動して変更を確認したい・スクリーンショットを撮りたい・UI の動作をシナリオで検証したいときに使う。
---

Noetelier（Electron / macOS）を自動操作で検証するスキル。実 UI を Playwright で起動し、
DOM 操作 + スクリーンショットで確認する。userData は実行ごとに一時ディレクトリへ隔離するため、
**実ユーザーの試用版データ（`~/Library/Application Support/Noetelier`）を汚さない**。

パスはすべてリポジトリルート基準。

## 事前条件

- `npm run build` 済みであること（ドライバは `out/` を起動する。renderer を変更したら再ビルド必須）
- `playwright-core` は devDependencies に入っている（`npm install` 済みなら OK）

## スモーク（起動 + プロジェクトを開いて撮影）

```bash
node .claude/skills/run-noetelier/smoke.mjs <projectRoot> [relPath]
# 例: node .claude/skills/run-noetelier/smoke.mjs ~/repos/farming docs/work/work-backlog.md
```

`SMOKE OK` と screenshot のパスが出る。**スクショは必ず Read で目視確認する**（真っ白 = 起動失敗）。

## シナリオを書く（本命の使い方）

[driver.mjs](driver.mjs) を import したワンショットスクリプトを書き、`node` で実行する。
この環境には tmux / timeout コマンドが無いため、REPL 型ではなく
「launch → 操作列 → screenshot → close」を 1 スクリプトで完結させる。

```js
import { launchApp } from './driver.mjs'
const t = await launchApp({ root: '/path/to/project' })
try {
  await t.openByRelPath('docs/work/work-backlog.md') // ツリーを展開しながら開く
  await t.clickButton('バックログ')                   // 表示テキスト一致でボタン押下
  console.log(await t.text('.backlog-count'))        // innerText で状態確認
  await t.clickSelector('.backlog-row.clickable')    // セレクタで DOM click
  await t.shot('result')                             // スクショ（パスが標準出力に出る）
} finally {
  await t.close()
}
```

ヘルパー: `shot` / `clickTree` / `openByRelPath` / `clickButton` / `clickSelector` / `text` /
`waitFsReflect`（外部ファイル変更の反映待ち。chokidar の debounce を見込んで 1.5s）。
生の Playwright が必要なら `t.page` / `t.app` を直接使う。
スクショ保存先は `SCREENSHOT_DIR` 環境変数で指定可（既定は一時ディレクトリ）。

## 仕組みと Gotchas（ハマった実績のあるものだけ）

- **HOME 差し替えでは userData を隔離できない**。macOS の Electron は Application Support を
  システム API で解決する。→ [wrapper.cjs](wrapper.cjs) が `app.setPath('userData', ...)` を実行してから
  実 main（`out/main/index.js`）を require する。
- **フォルダ選択ダイアログは自動操作できない**。→ 隔離 userData に `tab-session.json`
  （`{ roots: [<絶対パス>], activeIndex: 0 }`）を種付けし、セッション復元で開かせる。
- **実 UI は index.html のページ**（タブごとの WebContentsView）。shell.html はタブバーのみ。
  ドライバは `url().includes('index.html')` で拾う。
- **`ELECTRON_RUN_AS_NODE` を必ず削除**して起動する。残っていると素の Node として起動し
  `app` が undefined で落ちる（CLAUDE.md 既知の注意）。ドライバが対応済み。
- **座標クリックは WebContentsView 相手に不安定**。→ すべて `page.evaluate` の DOM click。
  ツリーは `.tree-label` をテキスト一致で探して `closest('.tree-row')` に dispatch する。
- 外部からのファイル書き換えを検証するときは `waitFsReflect()` を挟む
  （chokidar の awaitWriteFinish + 150ms debounce があり即時には反映されない）。

## 人間向けの起動（参考）

```bash
npm run dev            # 開発（HMR）
npm run trial:install  # 試用版として /Applications に反映
```
