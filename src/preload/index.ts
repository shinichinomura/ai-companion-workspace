import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IpcChannel,
  type AddBookmarkRequest,
  type AddRecentFileRequest,
  type AppSettings,
  type FsEventBatch,
  type OpenFolderByPathRequest,
  type RemoveBookmarkRequest,
  type RemoveRecentFileRequest,
  type OpenPathRequest,
  type RenamePathRequest,
  type DeletePathRequest,
  type RevealPathRequest,
  type CopyPathRequest,
  type ReadDirRequest,
  type ReadFileRequest,
  type TabsState,
  type TerminalActivateMessage,
  type TerminalActiveChangedMessage,
  type TerminalBellMessage,
  type TerminalDataMessage,
  type TerminalDisposeRequest,
  type TerminalExit,
  type TerminalInputMessage,
  type TerminalResizeRequest,
  type TerminalUnreadMessage,
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
  getRecentFiles: () => ipcRenderer.invoke(IpcChannel.GetRecentFiles),
  addRecentFile: (req: AddRecentFileRequest) => ipcRenderer.invoke(IpcChannel.AddRecentFile, req),
  removeRecentFile: (req: RemoveRecentFileRequest) =>
    ipcRenderer.invoke(IpcChannel.RemoveRecentFile, req),
  getBookmarks: () => ipcRenderer.invoke(IpcChannel.GetBookmarks),
  addBookmark: (req: AddBookmarkRequest) => ipcRenderer.invoke(IpcChannel.AddBookmark, req),
  removeBookmark: (req: RemoveBookmarkRequest) =>
    ipcRenderer.invoke(IpcChannel.RemoveBookmark, req),
  readDir: (req: ReadDirRequest) => ipcRenderer.invoke(IpcChannel.ReadDir, req),
  readFile: (req: ReadFileRequest) => ipcRenderer.invoke(IpcChannel.ReadFile, req),
  writeFile: (req: WriteFileRequest) => ipcRenderer.invoke(IpcChannel.WriteFile, req),
  openPath: (req: OpenPathRequest) => ipcRenderer.invoke(IpcChannel.OpenPath, req),
  renamePath: (req: RenamePathRequest) => ipcRenderer.invoke(IpcChannel.RenamePath, req),
  deletePath: (req: DeletePathRequest) => ipcRenderer.invoke(IpcChannel.DeletePath, req),
  revealPath: (req: RevealPathRequest) => ipcRenderer.invoke(IpcChannel.RevealPath, req),
  copyPath: (req: CopyPathRequest) => ipcRenderer.invoke(IpcChannel.CopyPath, req),
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
  onRequestOpenFolder: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IpcChannel.RequestOpenFolder, listener)
    return () => ipcRenderer.removeListener(IpcChannel.RequestOpenFolder, listener)
  },
  onRequestOpenFolderByPath: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on(IpcChannel.RequestOpenFolderByPath, listener)
    return () => ipcRenderer.removeListener(IpcChannel.RequestOpenFolderByPath, listener)
  },
  onOpenSettings: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IpcChannel.OpenSettings, listener)
    return () => ipcRenderer.removeListener(IpcChannel.OpenSettings, listener)
  },
  getAppSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  setAppSettings: (settings: AppSettings) => ipcRenderer.invoke(IpcChannel.SettingsSet, settings),

  terminalStart: (req: TerminalStartRequest) => ipcRenderer.invoke(IpcChannel.TerminalStart, req),
  terminalInput: (msg: TerminalInputMessage) => ipcRenderer.send(IpcChannel.TerminalInput, msg),
  terminalResize: (req: TerminalResizeRequest) => ipcRenderer.send(IpcChannel.TerminalResize, req),
  terminalDispose: (req: TerminalDisposeRequest) =>
    ipcRenderer.send(IpcChannel.TerminalDispose, req),
  onTerminalData: (cb: (msg: TerminalDataMessage) => void) => {
    const listener = (_e: unknown, msg: TerminalDataMessage): void => cb(msg)
    ipcRenderer.on(IpcChannel.TerminalData, listener)
    return () => ipcRenderer.removeListener(IpcChannel.TerminalData, listener)
  },
  onTerminalExit: (cb: (exit: TerminalExit) => void) => {
    const listener = (_e: unknown, exit: TerminalExit): void => cb(exit)
    ipcRenderer.on(IpcChannel.TerminalExit, listener)
    return () => ipcRenderer.removeListener(IpcChannel.TerminalExit, listener)
  },
  notifyTerminalBell: (msg: TerminalBellMessage) => ipcRenderer.send(IpcChannel.TerminalBell, msg),
  onActivateTerminal: (cb: (id: string) => void) => {
    const listener = (_e: unknown, msg: TerminalActivateMessage): void => cb(msg.id)
    ipcRenderer.on(IpcChannel.TerminalActivate, listener)
    return () => ipcRenderer.removeListener(IpcChannel.TerminalActivate, listener)
  },
  reportActiveTerminal: (id: string) => {
    const msg: TerminalActiveChangedMessage = { id }
    ipcRenderer.send(IpcChannel.TerminalActiveChanged, msg)
  },
  onTerminalUnread: (cb: (ids: string[]) => void) => {
    const listener = (_e: unknown, msg: TerminalUnreadMessage): void => cb(msg.ids)
    ipcRenderer.on(IpcChannel.TerminalUnread, listener)
    return () => ipcRenderer.removeListener(IpcChannel.TerminalUnread, listener)
  },
  // drag & drop された File から OS 上の絶対パスを得る。
  // Electron 32+ では File.path が廃止されたため webUtils を使う（renderer から直接は触れない）。
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // --- タブバー（クロームシェル）専用 ---
  onTabsState: (cb: (state: TabsState) => void) => {
    const listener = (_e: unknown, state: TabsState): void => cb(state)
    ipcRenderer.on(IpcChannel.TabsState, listener)
    return () => ipcRenderer.removeListener(IpcChannel.TabsState, listener)
  },
  requestTabsState: () => ipcRenderer.send(IpcChannel.TabsRequestState),
  newTab: () => ipcRenderer.send(IpcChannel.TabNew),
  activateTab: (id: number) => ipcRenderer.send(IpcChannel.TabActivate, id),
  closeTab: (id: number) => ipcRenderer.send(IpcChannel.TabClose, id)
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
