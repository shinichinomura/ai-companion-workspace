import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IpcChannel,
  type AppSettings,
  type FsEventBatch,
  type OpenFolderByPathRequest,
  type OpenPathRequest,
  type ReadDirRequest,
  type ReadFileRequest,
  type TerminalExit,
  type TerminalResizeRequest,
  type TerminalStartRequest,
  type WriteFileRequest,
  type WorkLayout,
  type WorkspaceApi
} from '../shared/ipc'

// renderer に公開する API。すべて main process への IPC として実装する（spec 2.3.3）。
const api: WorkspaceApi = {
  openFolder: () => ipcRenderer.invoke(IpcChannel.OpenFolder),
  openFolderByPath: (req: OpenFolderByPathRequest) =>
    ipcRenderer.invoke(IpcChannel.OpenFolderByPath, req),
  getRecentFolders: () => ipcRenderer.invoke(IpcChannel.GetRecentFolders),
  readDir: (req: ReadDirRequest) => ipcRenderer.invoke(IpcChannel.ReadDir, req),
  readFile: (req: ReadFileRequest) => ipcRenderer.invoke(IpcChannel.ReadFile, req),
  writeFile: (req: WriteFileRequest) => ipcRenderer.invoke(IpcChannel.WriteFile, req),
  openPath: (req: OpenPathRequest) => ipcRenderer.invoke(IpcChannel.OpenPath, req),
  onFsEvent: (cb: (batch: FsEventBatch) => void) => {
    const listener = (_e: unknown, batch: FsEventBatch): void => cb(batch)
    ipcRenderer.on(IpcChannel.FsEvent, listener)
    // 購読解除関数を返す。
    return () => ipcRenderer.removeListener(IpcChannel.FsEvent, listener)
  },
  getGitStatus: () => ipcRenderer.invoke(IpcChannel.GitStatus),
  onGitStatusChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IpcChannel.GitStatusChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannel.GitStatusChanged, listener)
  },

  onSetWorkLayout: (cb: (layout: WorkLayout) => void) => {
    const listener = (_e: unknown, layout: WorkLayout): void => cb(layout)
    ipcRenderer.on(IpcChannel.SetWorkLayout, listener)
    return () => ipcRenderer.removeListener(IpcChannel.SetWorkLayout, listener)
  },
  reportWorkLayout: (layout: WorkLayout) =>
    ipcRenderer.send(IpcChannel.WorkLayoutChanged, layout),
  onSetShowHidden: (cb: (show: boolean) => void) => {
    const listener = (_e: unknown, show: boolean): void => cb(show)
    ipcRenderer.on(IpcChannel.SetShowHidden, listener)
    return () => ipcRenderer.removeListener(IpcChannel.SetShowHidden, listener)
  },
  reportShowHidden: (show: boolean) => ipcRenderer.send(IpcChannel.ShowHiddenChanged, show),
  onRequestOpenFolder: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IpcChannel.RequestOpenFolder, listener)
    return () => ipcRenderer.removeListener(IpcChannel.RequestOpenFolder, listener)
  },
  onOpenSettings: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IpcChannel.OpenSettings, listener)
    return () => ipcRenderer.removeListener(IpcChannel.OpenSettings, listener)
  },
  getAppSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  setAppSettings: (settings: AppSettings) => ipcRenderer.invoke(IpcChannel.SettingsSet, settings),

  terminalStart: (req: TerminalStartRequest) => ipcRenderer.invoke(IpcChannel.TerminalStart, req),
  terminalInput: (data: string) => ipcRenderer.send(IpcChannel.TerminalInput, data),
  terminalResize: (req: TerminalResizeRequest) => ipcRenderer.send(IpcChannel.TerminalResize, req),
  terminalDispose: () => ipcRenderer.send(IpcChannel.TerminalDispose),
  onTerminalData: (cb: (data: string) => void) => {
    const listener = (_e: unknown, data: string): void => cb(data)
    ipcRenderer.on(IpcChannel.TerminalData, listener)
    return () => ipcRenderer.removeListener(IpcChannel.TerminalData, listener)
  },
  onTerminalExit: (cb: (exit: TerminalExit) => void) => {
    const listener = (_e: unknown, exit: TerminalExit): void => cb(exit)
    ipcRenderer.on(IpcChannel.TerminalExit, listener)
    return () => ipcRenderer.removeListener(IpcChannel.TerminalExit, listener)
  }
}

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
