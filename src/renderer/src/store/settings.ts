import { create } from 'zustand'
import { DEFAULT_QUICK_PROMPTS, type AppSettings, type QuickPrompt } from '../../../shared/ipc'

// アプリ設定（設定画面）の renderer 側ストア。
// 真値は main の app-settings.json。起動時に load() で読み込み、設定画面の保存で save() する。
// TerminalPane などはここから quickPrompts を購読し、保存と同時に再描画される。
interface SettingsState {
  // ターミナルのクイック操作。
  quickPrompts: QuickPrompt[]
  // main からの読み込みが完了したか。
  loaded: boolean
  // main から設定を読み込んでストアに反映する。起動時に 1 度呼ぶ。
  load: () => Promise<void>
  // 設定を保存する。main で正規化された結果をストアに反映する。
  save: (settings: AppSettings) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  // 読み込み前はデフォルトを暫定表示する（load 完了後に main の値で上書きされる）。
  quickPrompts: DEFAULT_QUICK_PROMPTS,
  loaded: false,

  load: async () => {
    const settings = await window.api.getAppSettings()
    set({ quickPrompts: settings.quickPrompts, loaded: true })
  },

  save: async (settings: AppSettings) => {
    const saved = await window.api.setAppSettings(settings)
    set({ quickPrompts: saved.quickPrompts, loaded: true })
  }
}))
