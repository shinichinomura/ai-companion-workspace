# Noetelier（ノエトリエ）

Claude Code を使うローカルプロジェクト作業のための、無料の Mac アプリです。
ファイルエクスプローラー、エディタ／Markdown プレビュー、統合ターミナルをひとつの画面で使えます。

## ダウンロード

**[最新の Noetelier をダウンロード](https://github.com/shinichinomura/ai-companion-workspace/releases/latest)**

リリースの Assets から `.dmg` ファイルを選んでください。Developer ID で署名し、Apple の公証を受けています。

## 動作環境とインストール

- Apple Silicon（M1 以降）を搭載した Mac、macOS 13 以降。
- DMG を開き、Noetelier を Applications フォルダへドラッグして起動してください。
- 作業したいフォルダを選び、統合ターミナルでシェルや Claude Code を操作します。
- Claude Code の利用には、CLI の別途インストールと認証、提供元の利用条件に応じた契約が必要です。Noetelier の無料配布に、Claude Code の利用料金は含まれません。

## 主な機能

- ファイルの閲覧・編集・保存とフォルダ内検索
- Markdown プレビューと外部変更の反映
- 統合ターミナルと複数タブでの作業

## データについて

選択したフォルダを Mac 上で扱うローカルアプリです。Markdown に外部画像がある場合はその配信元へアクセスします。統合ターミナルで起動した CLI の通信やデータ処理には、それぞれの提供元の条件が適用されます。

第三者ソフトウェアのライセンス表示は、アプリに同梱しています。

## 不具合の報告

[Issues](https://github.com/shinichinomura/ai-companion-workspace/issues) に、アプリのバージョン、macOS のバージョン、再現手順をお知らせください。報告にパスワードやプロジェクトの機密情報を含めないでください。

## 開発

Node.js 22.12 以降と、ネイティブモジュールのビルドに必要な Xcode 環境を用意してください。

```sh
npm ci
npm run dev
```

`npm run build` で型チェックとビルド、`npm run test:smoke` で分離したテスト環境での動作確認を実行できます。署名・公証付き DMG の生成は [配布手順](docs/distribution.md)、開発上の指針は [CLAUDE.md](CLAUDE.md) を参照してください。

## ライセンス

[MIT](LICENSE)。
