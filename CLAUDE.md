# CLAUDE.md

このリポジトリで作業する際の指針。詳細な仕様は [claude-code-companion-workspace-spec.md](claude-code-companion-workspace-spec.md) を参照。

## プロジェクト概要

Claude Code を使ったローカルプロジェクト作業を支援する **Mac 向け Electron デスクトップアプリ**。
ファイルエクスプローラー + エディタ/ビューワー + Markdown プレビュー + 統合ターミナルの 3 ペイン構成。

アプリ名は **Noetelier**（ノエトリエ。Noēsis〈希: 思惟〉+ Atelier =「思惟の工房」）。bundle id は `com.nomura.noetelier`。

**設計の核**: Claude Code を隠れた AI バックエンドとして扱わない。ユーザーが統合ターミナルで `claude` CLI を直接操作し、本アプリはファイルシステム経由でその結果を可視化するだけ。

## 現在の状況

- **Phase 1 (MVP Core) は実装完了**。3ペイン構成・ファイル編集/保存・外部変更反映・Markdown プレビュー・統合ターミナル・最近開いたフォルダの永続化まで揃い、MVP 受け入れ条件（spec 4.4）は充足済み。
- **試用の結果、概ね想定通りの使い勝手であることを確認済み**。引き続き日常利用での問題・使い勝手の洗い出しと修正は続ける。
- **現在は Phase 2 以降（Git status、PATH チェック、署名・notarization など）の実装を進めるフェーズ**。試用を継続しつつ、新機能の実装も並行して進める。着手順は spec の「7. 推奨実装順序」を参照する。

## 技術スタック

- **App Shell**: Electron + Vite + React + TypeScript
- **Editor**: Monaco Editor
- **Terminal**: xterm.js (renderer) + node-pty (main)
- **File System**: Node fs/promises + chokidar
- **Markdown**: unified / remark-parse / remark-gfm / remark-rehype / rehype-sanitize / rehype-stringify
- **State**: Zustand
- **Packaging**: electron-builder（Developer ID 署名 + notarization、直接配布）

公開準備と Mac App Store の検証結果は [docs/distribution.md](docs/distribution.md) を参照。
GitHub Releases で無料配布する。統合ターミナルと Claude Code 連携を維持し、Developer ID 署名・Apple 公証付きの DMG を使用する。App Store には未掲載。

## アーキテクチャ原則

- **Renderer に Node.js API を直接公開しない**。すべての fs 操作・PTY 操作は main process 経由（IPC）。
- IPC API は **project root 配下の操作に限定**する。main 側で project root 外のパスを拒否する。
- Markdown プレビューの HTML は必ずサニタイズする（任意 HTML 実行は不可）。
- Claude Code の認証情報・OAuth token・設定ファイルは読まない・解析しない。
- 自動でプロンプトを投入したり、出力を AI チャットとして再包装したりしない。
- **例外（再起動時のセッション復元）**: アプリの更新・再起動後に `claude` / `codex` の会話を再開するため、動作中プロセスの PID に対応する **セッション ID と cwd だけ** を読む（claude: `~/.claude/sessions/<pid>.json`、codex: `lsof` で開いている rollout ファイル名）。認証情報・`.key`・設定ファイルは読まない。復元時に実行するのは `claude --resume <id>` / `codex resume <id>`（特定できなければ `claude --continue` / `codex resume --last`）のみで、プロンプトは投入しない。実装は [src/main/cli-resume.ts](src/main/cli-resume.ts)。

## 開発の進め方

- Phase 1 (MVP Core) は完了済み（「現在の状況」参照）。試用で使い勝手を確認できたため、**現在は Phase 2 以降の実装を進めるフェーズ**。日常利用での問題の修正・小さな使い勝手改善も並行して続ける。
- Phase 2 以降の機能（Git status、PATH チェックなど）は spec の「7. 推奨実装順序」に沿って進める。一方、MVP 範囲外で当面着手しない機能（AI チャット、API 連携、Git commit、Mermaid、JSON/YAML/CSV 専用プレビューなど）との線引きは spec を参照して判断する。
- MVP 受け入れ条件（spec 4.4）は維持する。特に **dirty なファイルが外部変更されても内容を失わない**ことを壊さない。

## コーディング規約

- ドキュメント・コードコメントは**日本語**で記述する。
- TypeScript で型安全に。IPC のメッセージ、ファイルモデル、エディタ状態は型を定義する。

## Git 運用

- **コミットのタイミングは Claude の判断に任せる**。区切りのよい単位（ステップ完了・機能単位など）で都度コミットしてよく、毎回ユーザーに確認を取る必要はない。
- コミットメッセージは日本語で、何をなぜ変えたかが分かるように書く。

## バージョニング

インストール済みアプリがどのビルドかを把握できるよう、版を運用・可視化する。

- **方針（0.x 期）**: ユーザー影響のある変更（機能追加・バグ修正・使い勝手改善）を加えたら [package.json](package.json) の **patch を +1** する（`0.0.2` → `0.0.3`）。大きな節目でのみ minor を上げる。`npm version patch`（git tag も打つ）か、他の変更とまとめてコミットするなら手で書き換える。
- **可視化**: 動作中のアプリでは以下で版が分かる。
  - タブストリップ右端に `v0.0.x` を常時表示（ツールチップに git ハッシュ + ビルド日時）。[Shell.tsx](src/renderer/src/shell/Shell.tsx)
  - macOS の「Noetelier について」（アプリメニュー）に version / git ハッシュ / ビルド日時。[src/main/index.ts](src/main/index.ts)
- **ビルド時定数**: version・git 短縮ハッシュ・ビルド日時は [electron.vite.config.ts](electron.vite.config.ts) が `define` でビルド時に焼き込む（試用版 `.app` には `.git` が無く起動後に git を引けないため）。参照は [src/shared/build-info.ts](src/shared/build-info.ts)、型宣言は [src/shared/build-globals.d.ts](src/shared/build-globals.d.ts)。
- **試用フロー**: `npm run trial:install` でビルドすればその瞬間のハッシュ・日時が埋まる。patch を上げ忘れても、ハッシュ + 日時でどのコミットの版かは一意に特定できる。

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
- **試用**: `npm run trial:install` でパッケージして `/Applications/Noetelier.app` に上書きインストールし、そこに置いた `.app` を Finder / Dock から起動して実アプリとして使う。`dist/` から直接起動しない（再ビルドで作り直されるため Dock 参照が不安定になる）。Dock には必ず `/Applications/Noetelier.app` を登録する。

両者は **永続データ（最近開いたフォルダ等）を別ディレクトリで管理**するため混ざらない（[src/main/index.ts](src/main/index.ts) 参照）。userData 名は productName（Noetelier）に由来する。

- 開発時の userData: `…/Application Support/Noetelier-dev`
- 試用版（ビルド版）の userData: `…/Application Support/Noetelier`
- 判定は electron-vite dev のみ設定する `ELECTRON_RENDERER_URL` の有無で行う。
- ペイン幅などの localStorage は origin（`http://localhost` と `file://`）が異なるため自動的に分離される。

## コマンド

- `npm run dev` — electron-vite 開発サーバー（HMR）でアプリを起動（**開発用**）
- `npm run trial:install` — パッケージして `/Applications` に上書きインストールする（**試用用**。Dock 登録した `.app` を更新するときはこれを実行）
- `npm run package:mac` — macOS arm64 向けにパッケージングのみ（`dist/` に出力。インストールはしない）
- `npm run release:check` — Developer ID 証明書と Keychain に保存した公証認証を確認
- `npm run release:mac` — 署名・公証・Gatekeeper 検証付きの arm64 DMG を生成（一般公開先へのアップロードはしない）
- `npm run probe:mas` — App Sandbox 内の PTY と外部 CLI アクセスの最小検証
- `npm run test:smoke` — 分離したテスト環境でビルド後の画面・ファイル操作・PTY を確認
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
