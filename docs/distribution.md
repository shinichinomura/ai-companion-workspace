# Noetelier の配布手順

## 配布方針

Noetelier は GitHub Releases で無料配布する。統合ターミナルと、ユーザーがインストールした Claude Code CLI を直接操作する構成を維持するため、Developer ID 署名と Apple 公証を付けた DMG を使用する。Mac App Store への掲載は未実施。

公開先: [GitHub Releases](https://github.com/shinichinomura/ai-companion-workspace/releases)

対象は Apple Silicon（arm64）、macOS 13 以降。Intel 版は未検証。Claude Code は別途インストール・認証が必要で、提供元の条件に応じた契約・料金が適用される。

## 0.0.42 の検証

2026-11-15 に以下を確認した。

- Electron 45.3.2、node-pty の arm64 ネイティブビルド、型チェック、Vite ビルド。
- 通常のビルド出力、パッケージ内の app.asar、Developer ID 署名・Hardened Runtime を有効にした実際のアプリ実行ファイルでの動作テスト。
- 画面起動、preload、ファイルツリー、読み書き、検索、Markdown プレビュー、外部変更通知、PTY 起動・入出力・サイズ変更・終了。
- 作業画面の表示確認。テストの userData と作業フォルダは一時領域に分離。
- パッケージ内の main / preload / renderer / node-pty / spawn-helper の存在と、プロジェクトの .env・ソース・設計資料・開発スクリプトが含まれないこと。
- npm audit --omit=dev --audit-level=high: 既知の本番依存の脆弱性 0 件。
- アプリの厳密な署名検証、Apple 公証の Accepted、公証チケットの添付、Gatekeeper の Notarized Developer ID 判定。
- Electron / Chromium と本番依存のライセンス表示がアプリに含まれること。Noetelier の LICENSE は DMG にも同梱する。

アプリの公証申請 ID: 476669c8-4b73-4b11-bb34-6a1dbb7411ea。
最終 DMG の公証申請 ID: 468e26d2-36f3-4cba-82e9-8c625877de77。Accepted、公証チケットの添付、Gatekeeper 検証に成功した。DMG を読み取り専用でマウントし、アプリ・Applications リンク・LICENSE の存在と、内包するアプリの署名も確認済み。

0.0.42 では署名済みアプリの動作確認後に、そのアプリを公証し、prepackaged オプションで DMG を生成した。各段階を個別に実行して検証しており、release:mac 全体の一括実行はまだ行っていない。

## 署名と公証の準備

Node.js 22.12 以上、Xcode、Apple Developer Program の登録、秘密鍵付きの Developer ID Application 証明書が必要。Apple Development や Mac App Store 用証明書では代用できない。

Apple の [Developer ID 証明書の作成要件](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) に従って証明書を用意する。Xcode の作成メニューを利用できない場合は、Apple Developer の Web 画面で権限とチームを確認する。cloud-managed 証明書とローカル署名用の証明書は区別する。

公証認証情報は Keychain に保存する。パスワード・秘密鍵・証明書の秘密鍵付きエクスポートをリポジトリへ含めない。

```sh
# 対話形式で Apple Account、Team ID、アプリ用パスワードなどを入力する。
xcrun notarytool store-credentials noetelier-notary

# 設定するのは秘密情報ではないプロファイル名だけ。
export APPLE_KEYCHAIN_PROFILE=noetelier-notary
npm run release:check
```

Developer ID Application 証明書が複数ある場合は、NOETELIER_SIGNING_IDENTITY に使用する証明書の完全な名前または SHA-1 指紋を指定する。証明書一覧は security find-identity -v -p codesigning で確認できる。

release:check は証明書と公証の認証を確認する。証明書・認証の不足時はエラー終了し、ビルドやアップロードは行わない。

## 公開用 DMG の生成

```sh
npm ci
npm run release:mac
```

release:mac は、型チェックとビルド、分離したテスト環境での動作確認、Developer ID 署名、アプリの公証、署名・公証チケット・Gatekeeper 検証、署名済みアプリでの動作確認を実行する。その後、DMG を公証し、Accepted を確認してチケットを添付し、Gatekeeper 検証と SHA-256 ファイルの生成を行う。

成果物は dist/release/Noetelier-<version>-arm64.dmg と同名の .sha256。公開先へのアップロードは自動実行しない。失敗時には途中の生成物が残るため、処理全体の成功を確認するまで配布しない。

配布ファイルは out/、package.json、LICENSE、electron-builder が収集する本番依存に限定する。DMG にも LICENSE を同梱する。通常の package:mac と trial:install はローカル試用用であり、公開用の署名・公証を保証しない。

署名済みアプリを再検証する場合:

```sh
NOETELIER_SMOKE_EXECUTABLE="$PWD/dist/release/mac-arm64/Noetelier.app/Contents/MacOS/Noetelier" node scripts/smoke-electron.mjs
```

自動テストは Claude Code の認証情報を読まず、CLI の実操作も行わない。新規ユーザーの Mac での初回起動、CLI の導入・認証、実際のプロジェクトでの利用は別途確認する。

## Mac App Store の検討事項

Apple の [App Review Guidelines 2.4.5](https://developer.apple.com/app-store/review/guidelines/#hardware-compatibility) は Mac App Store アプリに App Sandbox を要求する。Electron でも [MAS 専用ビルド、署名、プロビジョニング](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide) が必要。

最小のネイティブプログラムに App Sandbox、ユーザー選択ファイルの読み書き、外向き通信の権限を付けて、通常実行と比較した。

| 対象 | 通常実行 | Sandbox 実行 |
| --- | --- | --- |
| HOME | 通常のホーム | アプリ専用コンテナ |
| 未選択のプロジェクト内 package.json | 読み取り成功 | EPERM |
| ~/.local/bin/claude の実行アクセス確認 | 成功 | EPERM |
| PTY 割り当て | 成功 | 成功 |

再現コマンドは npm run probe:mas。この検証は CLI の実行権限確認までで、Claude Code 自体や認証情報にはアクセスしない。App Review の判定や MAS 版 Electron でのアプリ全体の動作を代替するものではない。検証用の一時ファイルは削除するが、OS が作成する com.nomura.noetelier.probe.sandbox のコンテナは残ることがある。

App Store への掲載が不可能と確定したわけではない。次を解決してから再検討する。

1. ユーザーシェル、外部 CLI、設定・認証・更新・子プロセスを承認された範囲で動かせるか、専用環境で検証する。子プロセスも [親の Sandbox 制限を受ける](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html)。
2. フォルダとセッションの復元に [security-scoped bookmarks](https://www.electronjs.org/docs/latest/api/dialog#dialogshowopendialogwindow-options) を導入する。現在はパスのみを保存している。
3. 外部 git を含め、CLI 未導入の Mac で成立する機能範囲を決める。
4. 正しい Noetelier の App ID とプロファイルで MAS 開発ビルドを署名し、実機で確認する。
5. スクリーンショット、サポート URL、プライバシーポリシー URL、年齢区分、暗号化申告、審査向け手順を整える。

参考: [Apple の公証手順](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)、[Electron のコード署名](https://www.electronjs.org/docs/latest/tutorial/code-signing)。
