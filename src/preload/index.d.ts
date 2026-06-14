import { ElectronAPI } from '@electron-toolkit/preload'

// renderer 側で window.electron / window.api を型付きで参照できるようにする。
declare global {
  interface Window {
    electron: ElectronAPI
    api: Record<string, never>
  }
}
