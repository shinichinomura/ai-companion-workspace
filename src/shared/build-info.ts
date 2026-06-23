// ビルド時に注入される版情報（バージョン・git ハッシュ・ビルド日時）を、
// main / renderer の双方から型付きで参照するための一箇所。
// __APP_* はビルド時に文字列リテラルへ置換される（型は build-globals.d.ts、注入は electron.vite.config.ts）。

// package.json の version（例: '0.0.2'）。
export const APP_VERSION = __APP_VERSION__
// ビルド時の HEAD 短縮ハッシュ（例: 'e90e410'）。git 不在時は 'unknown'。
export const APP_GIT_HASH = __APP_GIT_HASH__
// ビルド日時（ISO 8601 文字列）。
export const APP_BUILD_DATE = __APP_BUILD_DATE__

// ビルド日時を 'YYYY-MM-DD HH:mm'（ローカル時刻）に整形する。不正値はそのまま返す。
export function formatBuildDate(iso: string = APP_BUILD_DATE): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// タブストリップ等のツールチップに出す詳細表記（例: 'abc1234 · 2026-06-23 14:30'）。
export function buildDetail(): string {
  return `${APP_GIT_HASH} · ${formatBuildDate()}`
}
