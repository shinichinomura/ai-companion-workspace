// electron.vite.config.ts が define で注入するビルド時定数の型宣言。
// 実際の値はビルド時に文字列リテラルへ置換される（main / renderer の両方）。

declare const __APP_VERSION__: string
declare const __APP_GIT_HASH__: string
declare const __APP_BUILD_DATE__: string
