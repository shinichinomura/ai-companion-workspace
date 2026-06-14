# CLAUDE.md

このリポジトリで作業する際の指針。詳細な仕様は [claude-code-companion-workspace-spec.md](claude-code-companion-workspace-spec.md) を参照。

## プロジェクト概要

Claude Code を使ったローカルプロジェクト作業を支援する **Mac 向け Electron デスクトップアプリ**。
ファイルエクスプローラー + エディタ/ビューワー + Markdown プレビュー + 統合ターミナルの 3 ペイン構成。

**設計の核**: Claude Code を隠れた AI バックエンドとして扱わない。ユーザーが統合ターミナルで `claude` CLI を直接操作し、本アプリはファイルシステム経由でその結果を可視化するだけ。

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

- 現在は **Phase 1 (MVP Core)** に集中する。MVP 範囲外の機能（AI チャット、API 連携、Git commit、Mermaid、JSON/YAML/CSV 専用プレビューなど）は実装しない。
- spec の「7. 推奨実装順序」に沿って進める。
- MVP 受け入れ条件（spec 4.4）を満たすことをゴールとする。特に **dirty なファイルが外部変更されても内容を失わない**こと。

## コーディング規約

- ドキュメント・コードコメントは**日本語**で記述する。
- TypeScript で型安全に。IPC のメッセージ、ファイルモデル、エディタ状態は型を定義する。

## Mac 固有の注意点

- GUI アプリ起動では shell の PATH が渡らないことがある。ログインシェル（`zsh -lic`）から環境変数を復元し、`/opt/homebrew/bin`・`/usr/local/bin` 等を候補に含める。
- ファイル削除など破壊的操作は確認ダイアログを出す。

## コマンド

- `npm run dev` — electron-vite 開発サーバー（HMR）でアプリを起動
- `npm run build` — typecheck + main/preload/renderer をビルド（`out/` に出力）
- `npm run typecheck` — main(node) と renderer(web) の型チェック
- `npm run package:mac` — macOS arm64 向けにパッケージング（electron-builder）

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
