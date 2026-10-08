import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { CtrlApi } from "../shared/types"

const on =
  <T extends unknown[]>(channel: string) =>
  (cb: (...args: T) => void) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
    ipcRenderer.on(channel, listener)
    return () => void ipcRenderer.removeListener(channel, listener)
  }

const api: CtrlApi = {
  getState: () => ipcRenderer.invoke("state"),
  dismissError: () => ipcRenderer.invoke("error:dismiss"),
  onState: on("state"),
  onRenameSpace: on("space:rename"),
  onRenameSession: on("session:rename"),
  onShortcut: on("shortcut"),
  onToast: on("toast"),
  onToastDismiss: on("toast:dismiss"),
  undo: (toastID) => ipcRenderer.invoke("toast:undo", toastID),
  recordShortcut: (on) => ipcRenderer.invoke("shortcut:record", on),
  onRecordedKey: on("shortcut:recorded"),
  newSessionHere: () => ipcRenderer.invoke("session:new-here"),
  archiveCurrent: () => ipcRenderer.invoke("session:archive-current"),
  createSpace: (name) => ipcRenderer.invoke("space:create", name),
  renameSpace: (id, name) => ipcRenderer.invoke("space:rename", id, name),
  onSpaceSettings: on("space:settings"),
  updateSpace: (id, patch) => ipcRenderer.invoke("space:update", id, patch),
  pickSpaceFolder: (id) => ipcRenderer.invoke("space:pick-folder", id),
  listModels: (directory) => ipcRenderer.invoke("models:list", directory),
  moveSpace: (id, index) => ipcRenderer.invoke("space:move", id, index),
  renameSession: (sessionID, title) => ipcRenderer.invoke("session:rename", sessionID, title),
  setArchived: (sessionID, archived) => ipcRenderer.invoke("session:archive", sessionID, archived),
  setUi: (patch) => ipcRenderer.invoke("ui:set", patch),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  toggleSpace: (id) => ipcRenderer.invoke("space:toggle", id),
  showSpaceMenu: (id) => ipcRenderer.invoke("space:menu", id),
  showSessionMenu: (id) => ipcRenderer.invoke("session:menu", id),
  moveSession: (sessionID, spaceID) => ipcRenderer.invoke("session:move", sessionID, spaceID),
  newSession: (spaceID) => ipcRenderer.invoke("session:new", spaceID),
  openSession: (sessionID) => ipcRenderer.invoke("session:open", sessionID),
  ptyStart: (cols, rows) => ipcRenderer.send("pty:start", cols, rows),
  ptyWrite: (data) => ipcRenderer.send("pty:write", data),
  ptyResize: (cols, rows) => ipcRenderer.send("pty:resize", cols, rows),
  onPtyData: on("pty:data"),
  onPtyReset: on("pty:reset"),
}

contextBridge.exposeInMainWorld("ctrl", api)
