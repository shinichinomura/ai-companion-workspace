import { create } from 'zustand'
import {
  DEFAULT_QUICK_PROMPTS,
  DEFAULT_WATCH_IGNORED_DIRS,
  DEFAULT_PANE_ARRANGEMENT,
  type AppSettings,
  type PaneArrangement,
  type QuickPrompt
} from '../../../shared/ipc'

// アプリ設定（設定画面）の renderer 側ストア。
// 真値は main の app-settings.json。起動時に load() で読み込み、設定画面の保存で save() する。
// TerminalPane などはここから quickPrompts を購読し、保存と同時に再描画される。
interface SettingsState {
  // ターミナルのクイック操作。
  quickPrompts: QuickPrompt[]
  // ファイル監視から除外するフォルダ名（fd 枯渇対策）。
  watchIgnoredDirs: string[]
  // ペインの配置（ターミナルの前後）。
  paneArrangement: PaneArrangement
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
  watchIgnoredDirs: DEFAULT_WATCH_IGNORED_DIRS,
  paneArrangement: DEFAULT_PANE_ARRANGEMENT,
  loaded: false,

  load: async () => {
    const settings = await window.api.getAppSettings()
    set({
      quickPrompts: settings.quickPrompts,
      watchIgnoredDirs: settings.watchIgnoredDirs,
      paneArrangement: settings.paneArrangement,
      loaded: true
    })
  },

  save: async (settings: AppSettings) => {
    const saved = await window.api.setAppSettings(settings)
    set({
      quickPrompts: saved.quickPrompts,
      watchIgnoredDirs: saved.watchIgnoredDirs,
      paneArrangement: saved.paneArrangement,
      loaded: true
    })
  }
}))
