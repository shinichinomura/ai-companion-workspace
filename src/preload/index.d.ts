import { ElectronAPI } from '@electron-toolkit/preload'
import { WorkspaceApi } from '../shared/ipc'

// renderer 側で window.electron / window.api を型付きで参照できるようにする。
declare global {
  interface Window {
    electron: ElectronAPI
    api: WorkspaceApi
  }
}
