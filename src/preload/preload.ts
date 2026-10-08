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
  onState: on("state"),
  onRenameSpace: on("space:rename"),
  onRenameSession: on("session:rename"),
  onShortcut: on("shortcut"),
  createSpace: (name) => ipcRenderer.invoke("space:create", name),
  renameSpace: (id, name) => ipcRenderer.invoke("space:rename", id, name),
  moveSpace: (id, index) => ipcRenderer.invoke("space:move", id, index),
  renameSession: (sessionID, title) => ipcRenderer.invoke("session:rename", sessionID, title),
  setArchived: (sessionID, archived) => ipcRenderer.invoke("session:archive", sessionID, archived),
  setUi: (patch) => ipcRenderer.invoke("ui:set", patch),
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
