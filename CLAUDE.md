# CLAUDE.md

このリポジトリで作業する際の指針。詳細な仕様は [claude-code-companion-workspace-spec.md](claude-code-companion-workspace-spec.md) を参照。

## プロジェクト概要

Claude Code を使ったローカルプロジェクト作業を支援する **Mac 向け Electron デスクトップアプリ**。
ファイルエクスプローラー + エディタ/ビューワー + Markdown プレビュー + 統合ターミナルの 3 ペイン構成。

**設計の核**: Claude Code を隠れた AI バックエンドとして扱わない。ユーザーが統合ターミナルで `claude` CLI を直接操作し、本アプリはファイルシステム経由でその結果を可視化するだけ。

## 現在の状況

- **Phase 1 (MVP Core) は実装完了**。3ペイン構成・ファイル編集/保存・外部変更反映・Markdown プレビュー・統合ターミナル・最近開いたフォルダの永続化まで揃い、MVP 受け入れ条件（spec 4.4）は充足済み。
- 現在は **まず試しに使ってみて実用性を確認するフェーズ**。新機能を足すより、実際の利用で見つかった使い勝手の問題・不具合の洗い出しと修正を優先する。
- Phase 2 以降（Git status、PATH チェック、署名・notarization など）への着手は、実用性確認の結果を踏まえて判断する。

## 技術スタック

- **App Shell**: Electron + Vite + React + TypeScript
- **Editor**: Monaco Editor
- **Terminal**: xterm.js (renderer) + node-pty (main)
- **File System**: Node fs/promises + chokidar
- **Markdown**: unified / remark-parse / remark-gfm / remark-rehype / rehype-sanitize / rehype-stringify
- **State**: Zustand
- **Packaging**: electron-builder（Developer ID 署名 + notarization、直接配布）

## アーキテクチャ原則

- **Renderer に Node.js API を直接公開しない**。すべての fs 操作・PTY 操作は main process 経由（IPC）。
- IPC API は **project root 配下の操作に限定**する。main 側で project root 外のパスを拒否する。
- Markdown プレビューの HTML は必ずサニタイズする（任意 HTML 実行は不可）。
- Claude Code の認証情報・OAuth token・設定ファイルは読まない・解析しない。
- 自動でプロンプトを投入したり、出力を AI チャットとして再包装したりしない。

## 開発の進め方

- Phase 1 (MVP Core) は完了済み（「現在の状況」参照）。当面は **実用性確認フェーズ**として、利用で見つかった問題の修正・小さな使い勝手改善を中心に進める。
- MVP 範囲外の機能（AI チャット、API 連携、Git commit、Mermaid、JSON/YAML/CSV 専用プレビューなど）はまだ実装しない。Phase 2 以降の着手は実用性確認の結果を踏まえて判断する。
- MVP 受け入れ条件（spec 4.4）は維持する。特に **dirty なファイルが外部変更されても内容を失わない**ことを壊さない。
- Phase 2 以降に進む際は spec の「7. 推奨実装順序」を参照する。

## コーディング規約

- ドキュメント・コードコメントは**日本語**で記述する。
- TypeScript で型安全に。IPC のメッセージ、ファイルモデル、エディタ状態は型を定義する。

## Git 運用

- **コミットのタイミングは Claude の判断に任せる**。区切りのよい単位（ステップ完了・機能単位など）で都度コミットしてよく、毎回ユーザーに確認を取る必要はない。
- コミットメッセージは日本語で、何をなぜ変えたかが分かるように書く。

## セッション運用

- **新しいセッションに切り替えるタイミングは Claude が判断して提案する**。会話が長くなった・大きな区切り（ステップ完了）に達した・コンテキストが膨らんできた、といった節目で「ここで新セッションにしませんか」と提案する。
- 提案する際は、新セッションでそのまま貼り付けて作業を再開できる**引き継ぎプロンプト**を併せて用意する。引き継ぎプロンプトには最低限、次を含める:
  - これまでに完了したこと（どのステップまで終わったか）
  - 現在の状態（ブランチ・最新コミット・動作確認状況）
  - 次にやること（次のステップと具体的なタスク）
  - 参照すべきファイル（spec、CLAUDE.md など）
- **引き継ぎプロンプトは必ずコピペ可能な形（コードブロック）で表示する**。説明文と混ざらないよう、プロンプト本文全体を 1 つのコードブロックに収める。

## Mac 固有の注意点

- GUI アプリ起動では shell の PATH が渡らないことがある。ログインシェル（`zsh -lic`）から環境変数を復元し、`/opt/homebrew/bin`・`/usr/local/bin` 等を候補に含める。
- ファイル削除など破壊的操作は確認ダイアログを出す。

## 開発と試用の使い分け

開発（コードを書く）と試用（実用性を確認する）を明確に分け、両者を混ぜない。

- **開発**: `npm run dev`（HMR）で起動する。
- **試用**: `npm run package:mac` でパッケージした `dist/` 配下の `.app` を Finder / Dock から起動して、実アプリとして使う。

両者は **永続データ（最近開いたフォルダ等）を別ディレクトリで管理**するため混ざらない（[src/main/index.ts](src/main/index.ts) 参照）。

- 開発時の userData: `…/Application Support/claude-code-companion-workspace-dev`
- 試用版（ビルド版）の userData: `…/Application Support/claude-code-companion-workspace`
- 判定は electron-vite dev のみ設定する `ELECTRON_RENDERER_URL` の有無で行う。
- ペイン幅などの localStorage は origin（`http://localhost` と `file://`）が異なるため自動的に分離される。

## コマンド

- `npm run dev` — electron-vite 開発サーバー（HMR）でアプリを起動（**開発用**）
- `npm run package:mac` — macOS arm64 向けにパッケージング（electron-builder）。生成された `.app` を起動して**試用**する
- `npm run build` — typecheck + main/preload/renderer をビルド（`out/` に出力）
- `npm run typecheck` — main(node) と renderer(web) の型チェック
- `npm run start` — ビルド済み `out/` を Electron で起動（HMR なし。試用版 .app の手前の素早い確認用）

## 既知の環境上の注意

- VSCode / Claude Code の統合ターミナルでは `ELECTRON_RUN_AS_NODE=1` が設定されていることがある。これが残っていると Electron が素の Node として起動し `app` が undefined になって落ちる。npm スクリプトは `env -u ELECTRON_RUN_AS_NODE` でこれを打ち消している。

## ディレクトリ構成

```
src/
  main/      Electron メインプロセス（fs / pty / watcher / IPC ハンドラ）
  preload/   contextBridge で renderer に API を公開
  renderer/  React アプリ（3 ペイン UI）
    src/components/  FileExplorer / EditorPane / TerminalPane
```
