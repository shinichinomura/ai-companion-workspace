import { create } from 'zustand'

// renderer 内の別コンポーネント（ファイルエクスプローラーの右クリックメニューなど）から、
// アクティブな統合ターミナルへ `@パス` 参照を挿入するためのブリッジ。
//
// TerminalPane と FileExplorer は兄弟コンポーネントで直接は繋がらないため、
// TerminalPane がマウント時に「挿入関数」をここへ登録し、呼び出し側はそれを購読して使う。
// 挿入の実体（アクティブ端末の解決・エスケープ・改行を付けない等）は TerminalPane 側に置く。
// null のときはターミナル未初期化（フォルダ未選択など）で、呼び出し側はボタンを無効化・no-op にする。
interface TerminalBridge {
  // 指定パスを、アクティブなターミナルの入力欄に `@パス ` として挿入する。
  // isDirectory=true のフォルダは claude の慣習に合わせ末尾に `/` を付ける。
  insertMention: ((relPath: string, isDirectory: boolean) => void) | null
  setInsertMention: (fn: ((relPath: string, isDirectory: boolean) => void) | null) => void
}

export const useTerminalBridge = create<TerminalBridge>((set) => ({
  insertMention: null,
  setInsertMention: (fn) => set({ insertMention: fn })
}))
