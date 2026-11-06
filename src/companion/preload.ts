import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { CompanionApi, CompanionView } from "./types"

const api: CompanionApi = {
  onView(cb) {
    const listener = (_e: IpcRendererEvent, view: CompanionView) => cb(view)
    ipcRenderer.on("companion:view", listener)
    return () => void ipcRenderer.removeListener("companion:view", listener)
  },
  onHold(cb) {
    const listener = (_e: IpcRendererEvent, held: boolean) => cb(held)
    ipcRenderer.on("companion:hold", listener)
    return () => void ipcRenderer.removeListener("companion:hold", listener)
  },
  open: (id) => ipcRenderer.send("companion:open", id),
  newSession: () => ipcRenderer.send("companion:new"),
  resize: (height) => ipcRenderer.send("companion:resize", height),
  menu: () => ipcRenderer.send("companion:menu"),
  requestAccess: () => ipcRenderer.send("companion:access"),
}

contextBridge.exposeInMainWorld("companion", api)
