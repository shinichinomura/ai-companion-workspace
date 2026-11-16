# Claude Code Companion Workspace 仕様メモ

## 1. アプリケーションの目的

本アプリケーションは、**Claude Code を使ったローカルプロジェクト作業を支援する Mac 向けデスクトップアプリ**である。

主目的は、Claude Code 自体を置き換えることではなく、Claude Code が作成・編集するプロジェクトファイルを、ユーザーが見やすく、編集しやすく、管理しやすくすることである。

位置づけとしては、以下に近い。

```text
Claude Code companion workspace
= ファイルエクスプローラー
+ テキストエディタ / ビューワー
+ Markdown プレビュー
+ Claude Code を実行できる統合ターミナル
```

本アプリは、AIチャット機能を独自に内蔵するのではなく、**ユーザーが自身の環境にセットアップ済みの Claude Code CLI を、アプリ内の統合ターミナルから明示的に利用する**形を取る。

これにより、以下の責任分界を明確にする。

```text
本アプリ:
- ローカルフォルダを開く
- ファイルツリーを表示する
- ファイルを閲覧・編集する
- Markdown をプレビューする
- 統合ターミナルを提供する
- ファイルシステムの変更を監視して UI に反映する

Claude Code:
- ユーザーがターミナル上で直接起動・操作する
- Claude の認証、利用枠、AI 実行を担う
- 必要に応じてプロジェクト内のファイルを作成・編集する
```

重要な設計方針は、**Claude Code を本アプリの隠れた AI バックエンドとして扱わない**ことである。ユーザーはターミナル上で Claude Code を直接操作し、本アプリはファイルシステムを通じてその結果を可視化する。

想定ユーザーは、Claude Code を利用しながら、Markdown、設定ファイル、仕様書、タスク管理ファイル、コード断片などを頻繁に確認・編集する開発者である。

---

## 2. 要件

### 2.1 基本コンセプト

アプリは 3 ペイン構成を基本とする。

```text
┌──────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ File Explorer         │ Editor / Viewer               │ Terminal                     │
│                      │                              │                              │
│ - project tree        │ - text editor                 │ - shell                      │
│ - changed files       │ - markdown preview            │ - claude command             │
│ - file status         │ - diff viewer later           │ - git/npm/test/etc.          │
└──────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### 2.2 機能要件

#### 2.2.1 ファイルエクスプローラー

プロジェクトルート配下のファイルとディレクトリを表示する。

必要機能:

- ローカルフォルダをプロジェクトとして開く
- ディレクトリツリーを表示する
- ファイルをクリックして中央ペインで開く
- ファイルの作成、リネーム、削除を行う
- `.git`, `node_modules`, `dist`, `build` などの除外設定を持つ
- ファイルシステムの外部変更を検知してツリーを更新する
- Claude Code が作成・編集したファイルをリアルタイムに近い形で反映する

将来的に追加したい機能:

- Git status 表示
- 変更ファイル一覧
- ファイル検索
- プロジェクト内全文検索
- 最近開いたファイル
- ブックマーク / ピン留め

#### 2.2.2 テキストエディタ / ビューワー

中央ペインでは、ファイルの内容を閲覧・編集する。

必要機能:

- テキストファイルを開く
- テキストファイルを編集する
- 保存する
- 未保存状態、いわゆる dirty state を管理する
- 外部変更を検知する
- dirty でないファイルは外部変更時に自動リロードする
- dirty なファイルが外部変更された場合は、ユーザーに衝突を通知する

外部変更時の基本挙動:

```text
ケース A: エディタが dirty でない
→ 外部変更を自動で読み込み直す

ケース B: エディタが dirty
→ 自動では上書きしない
→ 「外部で変更されました」と通知する
→ ユーザーに以下の選択肢を出す
   - 自分の変更を保持する
   - 外部変更を読み込む
   - 差分を見る
   - 手動でマージする
```

**エディタのタブ**

基本は 1 枚で使う（タブバーは出ない）。必要なときだけ、ファイルを新しいタブで開いて 2 枚以上を切り替えられる（発展的な使い方）。

- エクスプローラーで ⌥ を押しながらクリック、または右クリックの「新しいタブで開く」で、新しいタブに開く
- 通常のクリックは、今のタブのファイルを置き換える（従来どおり）。ただしそのファイルを既に別のタブで開いていれば、そのタブに切り替える（同じファイルのタブは重複させない）
- 2 枚以上のときだけタブバーが現れる。タブのクリックで切り替え、× または中クリックで閉じる。1 枚に戻るとタブバーは消える
- 各タブは独立したファイル履歴（戻る/進む）、Edit/Preview の表示モード、目次の状態を持ち、切り替えてもスクロール位置・カーソル・未保存の編集が保たれる
- 未保存の変更があるタブを閉じるときは、破棄してよいか確認する。外部変更の衝突通知は全タブ共通で、内容を失わない
- タブの状態は永続化しない（フォルダを開き直すと 1 枚に戻る）

#### 2.2.3 Markdown プレビュー

Markdown ファイルは、ソース編集とレンダリング済みプレビューを切り替えて閲覧できるようにする。

必要機能:

- `.md` ファイルを Markdown として認識する
- Markdown ソースを編集できる
- レンダリング済みプレビューを表示できる
- Edit / Preview の切り替えを行える
- GitHub Flavored Markdown 相当の基本記法に対応する
- HTML 出力はサニタイズする

後続フェーズで追加したい機能:

- Split view: 左にソース、右にプレビュー
- Mermaid プレビュー
- コードブロックのシンタックスハイライト
- 目次表示
- Backlink / Wiki link 的な Markdown ナビゲーション

#### 2.2.4 統合ターミナル

右ペインには統合ターミナルを表示する。

必要機能:

- プロジェクトルートを working directory としてシェルを起動する
- ユーザーのデフォルトシェル、主に zsh を利用する
- Claude Code CLI をユーザーがターミナル上で直接起動できる
- 通常の開発用ターミナルとしても使える
- ANSI escape sequence、リサイズ、対話入力に対応する
- 複数ターミナルタブは後続フェーズで検討する

基本フロー:

```text
ユーザーがプロジェクトを開く
  ↓
統合ターミナルが project root を cwd として起動する
  ↓
ユーザーが `claude` を実行する
  ↓
Claude Code がファイルを作成・編集する
  ↓
本アプリの file watcher が変更を検知する
  ↓
File Explorer / Editor / Preview に反映する
```

重要な制約:

- 本アプリは Claude Code の認証情報を読まない
- 本アプリは Claude Code の OAuth token や設定ファイルを解析しない
- 本アプリはユーザーの代わりに Claude Code へ裏でプロンプトを投入しない
- 本アプリは Claude Code の出力を AI チャットのように再包装しない
- あくまで「ユーザーが見えているターミナルで Claude Code を利用できる」構成にする

#### 2.2.5 ファイル変更のリアルタイム反映

Claude Code や外部エディタによるファイル変更を検知し、UI に反映する。

必要機能:

- プロジェクトルート配下を監視する
- 変更イベントは debounce して処理する
- 作成、更新、削除、リネームを検知する
- 開いているファイルが変更された場合はエディタに反映する
- dirty file との衝突を検知する

「リアルタイム」は厳密な即時反映ではなく、**near real-time** として扱う。

理由:

- 保存処理中に一時ファイルや rename が発生することがある
- Claude Code や他ツールが短時間に複数回ファイルを書き換えることがある
- 即時反映しすぎると途中状態を読んだり、プレビューがちらついたりする

推奨挙動:

```text
file watcher event
  ↓
100〜500ms debounce
  ↓
ignore pattern / file size / file type を確認
  ↓
Explorer state 更新
  ↓
開いているファイルなら editor / preview 更新
```

#### 2.2.6 Git 変更の可視化

MVP では必須ではないが、Claude Code との併用では重要度が高い。

理由は、Claude Code が複数ファイルをまとめて変更するため、ユーザーが「何が変わったか」をすぐ確認できる必要があるためである。

後続フェーズで追加したい機能:

- Changed files 一覧
- modified / added / deleted の表示
- ファイルごとの差分表示
- Git diff viewer
- 変更を確認してから commit する導線

#### 2.2.7 JSON / YAML / CSV プレビュー

MVP では Markdown を優先し、JSON / YAML / CSV は後続フェーズで実装する。

想定機能:

- JSON tree viewer
- YAML tree viewer
- CSV table viewer
- 大きな CSV の lazy loading
- フォーマットエラー表示

### 2.3 非機能要件

#### 2.3.1 対象環境

- macOS アプリとして動作する
- 初期リリースでは Mac 専用でよい
- Apple Silicon を主対象とする
- Intel Mac 対応はビルド設定で検討する

#### 2.3.2 ローカルファースト

- プロジェクトファイルはローカルに存在する
- 本アプリ自体はクラウド同期を前提にしない
- AI 機能の実行は Claude Code 側に任せる
- 本アプリは Claude API key や Claude subscription を直接扱わない

#### 2.3.3 セキュリティ

- Renderer process に Node.js API を直接公開しない
- File system 操作は main process 経由に制限する
- IPC API は project root 配下の操作に限定する
- Markdown preview の HTML はサニタイズする
- ユーザーの shell 環境、認証情報、Claude 設定を不必要に読まない
- 任意コマンド実行はターミナル内のユーザー操作として扱う

#### 2.3.4 配布

- 初期配布は Mac App Store ではなく、Developer ID 署名 + notarization による直接配布を想定する
- 理由は、任意フォルダアクセス、統合ターミナル、外部 CLI 実行を扱うため
- App Store 配布は、sandbox 制約との相性を検討した上で将来的に判断する

---

## 3. フェーズ分け

### Phase 1: MVP Core

目的は、3ペイン構成の基本体験を成立させること。

含める機能:

- Electron アプリの基本構成
- Mac アプリとして起動
- Open Folder
- File Explorer
- Text Editor
- ファイル保存
- dirty state 管理
- File watcher
- 外部変更の自動反映
- Markdown preview
- 統合ターミナル
- ターミナルの cwd を project root に設定
- ユーザーがターミナル上で `claude` を実行できる

このフェーズでは、Claude Code との連携は **統合ターミナル + ファイルシステム監視**に限定する。

### Phase 2: Claude Code Companion UX

目的は、Claude Code が変更した内容をユーザーが安心して確認できるようにすること。

含める機能:

- Changed files 表示
- Git status 表示
- Diff viewer
- 外部変更時の衝突解決 UI
- Claude CLI の存在チェック
- PATH 問題の検出と案内
- 「Start Claude Code」ボタン
- Terminal restart
- 最近開いたプロジェクト

### Phase 3: Preview / Viewer 強化

目的は、プロジェクト管理・仕様管理ファイルを読みやすくすること。

含める機能:

- Markdown Split view
- Mermaid preview
- JSON preview
- YAML preview
- CSV preview
- コードブロックのシンタックスハイライト
- Markdown outline
- ファイル検索
- プロジェクト内全文検索

### Phase 4: Distribution Ready

目的は、配布可能な品質にすること。

含める機能:

- 設定画面
- エラーレポート導線
- 自動アップデート検討
- 署名
- notarization
- アプリ内ヘルプ
- 初回起動時の Claude Code セットアップ確認
- セキュリティレビュー
- 大きなプロジェクトでのパフォーマンス改善

---

## 4. MVP 仕様

### 4.1 MVP のゴール

MVP のゴールは、以下の体験を成立させることである。

```text
ユーザーが Mac アプリでプロジェクトフォルダを開く
  ↓
左ペインでファイルを選ぶ
  ↓
中央ペインで編集または Markdown preview を見る
  ↓
右ペインのターミナルで Claude Code を起動する
  ↓
Claude Code がファイルを作成・編集する
  ↓
変更が File Explorer / Editor / Preview に反映される
```

### 4.2 MVP に含める機能

#### アプリ全体

- Mac デスクトップアプリとして起動する
- 3ペインレイアウトを持つ
- ペイン幅を調整できる
- プロジェクトフォルダを開ける
- 最近開いたフォルダは最低限保存する

#### File Explorer

- プロジェクト配下のファイルツリーを表示する
- ディレクトリを展開・折りたたみできる
- ファイルクリックでエディタに開く
- `.git`, `node_modules`, `dist`, `build` などを初期 ignore に含める
- 外部変更時にツリーを更新する

#### Editor / Viewer

- テキストファイルを開ける
- テキストを編集できる
- 保存できる
- 未保存状態を表示する
- 外部変更を検知する
- dirty でないファイルは自動リロードする
- dirty なファイルが外部変更された場合は警告する

#### Markdown Preview

- `.md` ファイルをプレビューできる
- Edit / Preview を切り替えられる
- Markdown preview はサニタイズされた HTML として表示する
- MVP では Split view は任意

#### Terminal

- 統合ターミナルを表示する
- project root を cwd として起動する
- ユーザーの shell を起動する
- `claude` コマンドをユーザーが直接実行できる
- Claude Code 専用の特殊連携は行わない

#### File Watcher

- プロジェクト配下のファイル変更を監視する
- 変更イベントを debounce する
- Explorer に反映する
- 開いているファイルに反映する
- dirty file の衝突を検知する

### 4.3 MVP に含めないもの

MVP では以下は対象外とする。

- アプリ内 AI チャット
- Anthropic API 連携
- Claude の OAuth / token 取得
- Claude Code の出力解析
- Claude Code への自動プロンプト投入
- MCP server 機能
- Git commit 機能
- 高度な diff / merge
- JSON / YAML / CSV の専用プレビュー
- Mermaid preview
- プラグイン機構
- チーム共有機能
- クラウド同期
- Mac App Store 配布

### 4.4 MVP の受け入れ条件

MVP は、以下を満たせば成立とする。

- 任意のローカルフォルダを開ける
- 左ペインでファイル構造を確認できる
- 中央ペインでテキストファイルを編集・保存できる
- Markdown ファイルをレンダリング済みプレビューで見られる
- 右ペインのターミナルで `claude` を実行できる
- Claude Code が作成・編集したファイルが、アプリ側に反映される
- エディタで未保存のファイルがある場合、外部変更で内容が失われない

---

## 5. 技術スタックとその選定理由

### 5.1 推奨スタック全体

```text
App Shell:
- Electron
- Vite
- React
- TypeScript

Editor / Viewer:
- Monaco Editor
- Markdown renderer

Terminal:
- xterm.js
- node-pty

File System:
- Node fs/promises
- chokidar
- fast-glob
- ignore

State Management:
- Zustand または Jotai

Git / Diff:
- simple-git
- diff / diff2html

Markdown:
- unified / remark / rehype
- remark-gfm
- rehype-sanitize

Packaging:
- electron-builder
- Developer ID signing
- notarization

Persistence:
- 初期は JSON file
- 必要になれば SQLite
```

### 5.2 Electron

Electron を採用する。

選定理由:

- ファイルエクスプローラー、エディタ、ターミナルを 1 つのデスクトップアプリにまとめやすい
- React / TypeScript / Web UI の資産を活用できる
- Node.js によるローカルファイル操作と相性が良い
- xterm.js + node-pty の構成を取りやすい
- Monaco Editor を組み込みやすい
- Mac 専用 MVP を素早く作る上で実装リスクが低い

Tauri や Swift ネイティブも候補ではあるが、今回の MVP では Electron を優先する。

理由:

- Tauri は軽量だが、PTY 統合まわりで Rust 側の実装コストが上がる
- Swift ネイティブは Mac らしい UI を作れるが、高品質なコードエディタと統合ターミナルを作るコストが高い
- 今回はネイティブ UI の完成度より、VSCode 風のエディタ・ターミナル・ファイル監視を早く安定させることが重要

### 5.3 React + TypeScript + Vite

UI 実装には React + TypeScript + Vite を使う。

選定理由:

- Electron との相性が良い
- 3ペインレイアウトを作りやすい
- Monaco Editor や xterm.js の React 統合事例が多い
- TypeScript により IPC、ファイルモデル、エディタ状態を型安全に扱える
- Vite により開発時の起動と HMR が速い

### 5.4 Monaco Editor

エディタには Monaco Editor を採用する。

選定理由:

- VSCode に近い編集体験を作りやすい
- テキスト編集、シンタックスハイライト、キーバインド、ミニマップなどの基礎機能が揃っている
- Markdown、JSON、YAML、コードファイルなどの表示に向いている
- 将来的に diff editor としても使える

MVP では、Monaco の高度な language server 連携は対象外とする。

### 5.5 xterm.js + node-pty

統合ターミナルには xterm.js + node-pty を採用する。

構成:

```text
Renderer process:
- xterm.js でターミナルを描画する

Main process:
- node-pty で疑似端末を起動する
- ユーザーの shell を起動する
- cwd を project root にする

IPC:
- xterm.js の入力を main process に送る
- node-pty の出力を renderer に返す
```

選定理由:

- Claude Code は対話型 CLI として使うため、通常の child_process ではなく PTY が必要
- xterm.js は Web UI 上でターミナルを描画する用途に適している
- node-pty は Electron / Node.js 環境で PTY を扱う定番の選択肢
- ANSI escape sequence、画面リサイズ、対話入力を扱える

### 5.6 chokidar + Node fs/promises

ファイル監視には chokidar を使い、ファイル読み書きには Node の fs/promises を使う。

選定理由:

- macOS のファイル変更を扱いやすい
- cross-platform だが、Mac 専用でも実装しやすい
- ignore pattern を組み込みやすい
- debounce と組み合わせやすい

注意点:

- 大きなプロジェクトでは watch 対象を制限する
- `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage` などは初期 ignore に含める
- バイナリファイルや巨大ファイルはエディタで開かない

### 5.7 Markdown renderer

Markdown には unified / remark / rehype 系、または markdown-it を使う。

推奨は以下。

```text
- unified
- remark-parse
- remark-gfm
- remark-rehype
- rehype-sanitize
- rehype-stringify
```

選定理由:

- GitHub Flavored Markdown に対応しやすい
- AST ベースで後から拡張しやすい
- HTML のサニタイズを組み込みやすい
- 将来的に outline、リンク解析、独自記法に拡張しやすい

MVP では安全性を優先し、任意 HTML の実行は許可しない。

### 5.8 Zustand または Jotai

状態管理には Zustand または Jotai を使う。

管理対象:

- 現在の project root
- file tree state
- opened files
- active file
- dirty state
- terminal sessions
- preview mode
- settings

選定理由:

- Redux ほど重くない
- React コンポーネントから扱いやすい
- MVP の規模に合っている

### 5.9 simple-git / diff / diff2html

Git 変更の可視化には、後続フェーズで simple-git と diff 系ライブラリを検討する。

選定理由:

- Claude Code が変更した内容をユーザーが確認しやすくなる
- changed files 表示は Claude Code companion として重要
- Monaco Editor の diff 機能と組み合わせることもできる

MVP では Git 機能は必須にしないが、早期に追加する価値が高い。

### 5.10 electron-builder

配布には electron-builder を使う。

選定理由:

- macOS 向けパッケージングに対応している
- Developer ID 署名、notarization の流れに乗せやすい
- auto update を将来的に検討しやすい

初期配布方針:

```text
- Mac App Store ではなく直接配布
- Developer ID 署名
- notarization
- DMG または ZIP で配布
```

### 5.11 設定・永続化

MVP では SQLite を使わず、JSON ファイルで十分とする。

保存先例:

```text
~/Library/Application Support/<AppName>/settings.json
~/Library/Application Support/<AppName>/recent-workspaces.json
```

保存対象:

- 最近開いたプロジェクト
- ignore patterns
- ペイン幅
- エディタ設定
- Markdown preview 設定
- Claude Code binary path の手動指定が必要になった場合の設定

将来的に以下が必要になれば SQLite を検討する。

- プロジェクトごとのインデックス
- 検索キャッシュ
- 大量のメタデータ
- タスク管理データ
- 履歴管理

---

## 6. Mac 固有の注意点

### 6.1 GUI アプリ起動時の PATH 問題

macOS では、Finder、Dock、Spotlight から GUI アプリを起動した場合、通常のターミナル起動時と同じ shell 環境変数が渡らないことがある。

そのため、ユーザーのターミナルでは `claude` が見つかるのに、本アプリの統合ターミナルでは `command not found: claude` になる可能性がある。

対策:

- 起動時にユーザーのログインシェルから環境変数を取得する
- `zsh -lic 'printenv -0'` のような形で PATH を復元する
- `/opt/homebrew/bin`, `/usr/local/bin` を候補に含める
- Claude Code binary path を手動設定できるようにする
- 初回起動時に `claude` の存在チェックを行う

### 6.2 Apple Silicon / Homebrew

Apple Silicon Mac では Homebrew の標準パスが `/opt/homebrew/bin` になることが多い。

探索候補:

```text
/opt/homebrew/bin/claude
/usr/local/bin/claude
~/.npm-global/bin/claude
~/.local/bin/claude
```

ただし、最終的にはユーザーの shell 環境から PATH を取得することを優先する。

### 6.3 権限とフォルダアクセス

ユーザーが明示的に選択した project root のみを操作対象とする。

実装上の方針:

- Open Folder dialog でプロジェクトルートを選ばせる
- IPC 側で project root 外のパスを拒否する
- symlink の扱いは慎重にする
- 削除操作には確認ダイアログを出す

---

## 7. 推奨実装順序

```text
Step 1:
- Electron + React + TypeScript + Vite の雛形作成
- 3ペインレイアウト作成

Step 2:
- Open Folder
- File Explorer
- ファイル読み込み

Step 3:
- Monaco Editor 組み込み
- 保存
- dirty state 管理

Step 4:
- chokidar による file watcher
- 外部変更の反映
- dirty file conflict warning

Step 5:
- Markdown preview
- Edit / Preview 切り替え

Step 6:
- xterm.js + node-pty 統合
- project root cwd で shell 起動
- claude command の実行確認

Step 7:
- PATH 問題対策
- Claude Code setup check
- Start Claude Code ボタン

Step 8:
- Changed files / Git status
- Diff viewer

Step 9:
- packaging
- signing
- notarization
```

---

## 8. プロダクト上の表現方針

配布時の説明では、本アプリを「Claude のサブスクで動く AI チャット内蔵アプリ」と表現しない。

望ましい表現:

```text
このアプリは、ローカルプロジェクト用のエディタ兼ワークスペースです。
統合ターミナルから、ユーザー自身がインストール済みの Claude Code CLI を使用できます。
Claude Code が作成・編集したファイルは、ファイルエクスプローラーとエディタに反映されます。
```

避けたい表現:

```text
Claude Pro で使える AI チャット内蔵エディタです。
Claude Code を内部エンジンとして利用します。
Claude のサブスク枠で本アプリの AI 機能を使えます。
```

理由:

- 本アプリは Claude Code の認証や AI 実行を管理しない
- ユーザーが公式 Claude Code CLI をターミナル上で直接利用する設計である
- 責任分界を明確にするため

---

## 9. 現時点の結論

Electron を採用し、以下の構成で MVP を作る。

```text
Electron
React
TypeScript
Vite
Monaco Editor
xterm.js
node-pty
chokidar
unified / remark / rehype
Zustand or Jotai
electron-builder
```

アプリの中核価値は、**Claude Code を使うための AI 機能そのものではなく、Claude Code と並行してローカルプロジェクトを確認・編集・管理しやすくすること**である。

MVP では以下に集中する。

```text
1. ファイルエクスプローラー
2. テキストエディタ / ビューワー
3. Markdown プレビュー
4. 統合ターミナル
5. Claude Code による外部ファイル変更のリアルタイム反映
6. dirty file の衝突管理
```

この方針により、Claude Code の認証や利用枠に踏み込まず、ユーザーが自身の環境で Claude Code を使える Mac アプリとして、実装リスクと配布リスクを抑えた形で開発を進められる。
