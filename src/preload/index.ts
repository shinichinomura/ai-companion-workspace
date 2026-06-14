import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// renderer に公開する API。Step 1 では雛形のみ。
// 以降のステップで Open Folder / fs / watcher / pty 等の IPC をここに追加する。
const api = {}

// contextIsolation が有効なため、contextBridge 経由でのみ公開する。
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (contextIsolation を無効化した場合のフォールバック)
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
