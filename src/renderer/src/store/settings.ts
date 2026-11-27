import { create } from 'zustand'
import {
  DEFAULT_WATCH_IGNORED_DIRS,
  DEFAULT_PANE_ARRANGEMENT,
  DEFAULT_FONT_SIZES,
  type AppSettings,
  type FontSizes,
  type PaneArrangement
} from '../../../shared/ipc'

// アプリ設定（設定画面）の renderer 側ストア。
// 真値は main の app-settings.json。起動時に load() で読み込み、設定画面の保存で save() する。
// 各コンポーネントはここから設定を購読し、保存と同時に再描画される。
interface SettingsState {
  // ファイル監視から除外するフォルダ名（fd 枯渇対策）。
  watchIgnoredDirs: string[]
  // ペインの配置（ターミナルの前後）。
  paneArrangement: PaneArrangement
  // ペインごとのフォントサイズ（px）。
  fontSizes: FontSizes
  // main からの読み込みが完了したか。
  loaded: boolean
  // main から設定を読み込んでストアに反映する。起動時に 1 度呼ぶ。
  load: () => Promise<void>
  // 設定を保存する。main で正規化された結果をストアに反映する。
  save: (settings: AppSettings) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  // 読み込み前はデフォルトを暫定表示する（load 完了後に main の値で上書きされる）。
  watchIgnoredDirs: DEFAULT_WATCH_IGNORED_DIRS,
  paneArrangement: DEFAULT_PANE_ARRANGEMENT,
  fontSizes: DEFAULT_FONT_SIZES,
  loaded: false,

  load: async () => {
    const settings = await window.api.getAppSettings()
    set({
      watchIgnoredDirs: settings.watchIgnoredDirs,
      paneArrangement: settings.paneArrangement,
      fontSizes: settings.fontSizes,
      loaded: true
    })
  },

  save: async (settings: AppSettings) => {
    const saved = await window.api.setAppSettings(settings)
    set({
      watchIgnoredDirs: saved.watchIgnoredDirs,
      paneArrangement: saved.paneArrangement,
      fontSizes: saved.fontSizes,
      loaded: true
    })
  }
}))
