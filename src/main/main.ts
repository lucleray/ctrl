import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from "electron"
import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AppState, Settings, ThemeInfo, UiState } from "../shared/types"
import { Attention } from "./attention"
import { OpenCodeService } from "./opencode"
import { Store } from "./store"
import { Terminal } from "./terminal"
import { cliThemeName, listThemes } from "./themes"

const root = join(fileURLToPath(import.meta.url), "../..")
const LIGHT_BG = "#f7f7f6"
const DARK_BG = "#1c1c1b"

if (process.env.CTRL_USER_DATA) app.setPath("userData", process.env.CTRL_USER_DATA)

// Test runs (CTRL_HEADLESS=1, implied by the debug hooks) never show the window or take focus.
const headless =
  process.env.CTRL_HEADLESS === "1" || !!process.env.CTRL_EVAL || !!process.env.CTRL_SCREENSHOT

let win: BrowserWindow | undefined
const store = new Store(join(app.getPath("userData"), "state.json"))
let currentSessionID: string | null = null
let bridgeConnected = false
let error: string | undefined

const send = (channel: string, ...args: unknown[]) => {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, ...args)
  } catch {
    // Frame can be gone mid-reload/shutdown; the next push resyncs.
  }
}

const state = (): AppState => ({
  spaces: store.data.spaces,
  assignments: store.data.assignments,
  archived: store.data.archived,
  ui: store.data.ui,
  settings: store.data.settings,
  themes,
  dark: nativeTheme.shouldUseDarkColors,
  sessions: opencode.sessions,
  currentSessionID,
  bridgeConnected,
  error,
})

let pushQueued = false
const push = () => {
  if (pushQueued) return
  pushQueued = true
  queueMicrotask(() => {
    pushQueued = false
    attention.refreshBadge(opencode.sessions)
    send("state", state())
  })
}

const opencode = new OpenCodeService(() => {
  attention.update(opencode.sessions)
  push()
})

const attention = new Attention({
  window: () => win,
  settings: () => store.data.settings,
  isArchived: (id) => !!store.data.archived[id],
  open: (id) => openSession(id),
  quiet: headless,
})

const terminal = new Terminal(join(root, "bridge"), {
  onData: (data) => send("pty:data", data),
  onReset: () => send("pty:reset"),
  onRoute: (id) => {
    currentSessionID = id
    opencode.setCurrent(id)
    push()
  },
  onBridge: (connected) => {
    bridgeConnected = connected
    push()
  },
})

let themes: ThemeInfo = { builtin: [], custom: [] }
const loadThemes = () => (themes = { ...listThemes(), cliDefault: cliThemeName() })

/** Applies appearance to the app chrome and the matching theme/mode to the embedded TUI. */
const applyTheme = () => {
  const { appearance, tuiTheme } = store.data.settings
  nativeTheme.themeSource = appearance
  const dark = nativeTheme.shouldUseDarkColors
  win?.setBackgroundColor(dark ? DARK_BG : LIGHT_BG)
  // Nested objects merge over cli.json, so omitting `name` keeps the user's theme.
  terminal.setCliOverrides(
    { theme: { mode: dark ? "dark" : "light", ...(tuiTheme ? { name: tuiTheme } : {}) } },
    currentSessionID,
  )
  push()
}

const openSession = (sessionID: string) => {
  currentSessionID = sessionID
  opencode.setCurrent(sessionID)
  terminal.open(sessionID)
  push()
}

const newSession = async (spaceID: string | null) => {
  const dir = (spaceID && store.space(spaceID)?.directory) || homedir()
  const id = await opencode.createSession(dir)
  if (spaceID) store.assign(id, spaceID)
  openSession(id)
}

function registerIpc() {
  ipcMain.handle("state", () => state())
  ipcMain.handle("space:create", (_e, name: string) => {
    const id = store.createSpace(name)
    push()
    return id
  })
  ipcMain.handle("space:rename", (_e, id: string, name: string) => {
    store.updateSpace(id, { name })
    push()
  })
  ipcMain.handle("space:move", (_e, id: string, index: number) => {
    store.moveSpace(id, index)
    push()
  })
  ipcMain.handle("session:rename", (_e, sessionID: string, title: string) =>
    opencode.renameSession(sessionID, title).catch(report),
  )
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    store.setSettings(patch)
    loadThemes()
    applyTheme()
  })
  ipcMain.handle("ui:set", (_e, patch: Partial<UiState>) => {
    store.setUi(patch)
    push()
  })
  ipcMain.handle("session:archive", (_e, sessionID: string, archived: boolean) => {
    store.setArchived([sessionID], archived)
    push()
  })
  ipcMain.handle("space:toggle", (_e, id: string) => {
    store.updateSpace(id, { collapsed: !store.space(id)?.collapsed })
    push()
  })
  ipcMain.handle("space:menu", (_e, id: string) => {
    const space = store.space(id)
    if (!space || !win) return
    Menu.buildFromTemplate([
      { label: "New session", click: () => void newSession(id).catch(report) },
      { type: "separator" },
      { label: "Rename", click: () => send("space:rename", id) },
      {
        label: space.directory ? `Folder: ${space.directory.replace(homedir(), "~")}` : "Set folder…",
        click: async () => {
          const res = await dialog.showOpenDialog(win!, {
            properties: ["openDirectory"],
            defaultPath: space.directory || homedir(),
          })
          if (res.canceled || !res.filePaths[0]) return
          store.updateSpace(id, { directory: res.filePaths[0] })
          push()
        },
      },
      { type: "separator" },
      {
        label: "Archive all sessions",
        click: () => {
          const ids = opencode.sessions
            .filter((s) => store.data.assignments[s.id] === id && !store.data.archived[s.id])
            .map((s) => s.id)
          store.setArchived(ids, true)
          push()
        },
      },
      {
        label: "Delete space",
        click: async () => {
          const res = await dialog.showMessageBox(win!, {
            type: "warning",
            message: `Delete "${space.name}"?`,
            detail: "Sessions are kept and stay in Recents.",
            buttons: ["Delete", "Cancel"],
            defaultId: 1,
            cancelId: 1,
          })
          if (res.response !== 0) return
          store.deleteSpace(id)
          push()
        },
      },
    ]).popup({ window: win })
  })
  ipcMain.handle("session:menu", (_e, sessionID: string) => {
    if (!win) return
    const current = store.data.assignments[sessionID] ?? null
    Menu.buildFromTemplate([
      { label: "Open", click: () => openSession(sessionID) },
      { label: "Rename", click: () => send("session:rename", sessionID) },
      store.data.archived[sessionID]
        ? { label: "Unarchive", click: () => (store.setArchived([sessionID], false), push()) }
        : { label: "Archive", click: () => (store.setArchived([sessionID], true), push()) },
      {
        label: "Move to",
        submenu: [
          { label: "No space", type: "radio", checked: current === null, click: () => move(sessionID, null) },
          ...store.data.spaces.map((s) => ({
            label: s.name,
            type: "radio" as const,
            checked: current === s.id,
            click: () => move(sessionID, s.id),
          })),
        ],
      },
      { type: "separator" },
      {
        label: "Delete session",
        click: async () => {
          const res = await dialog.showMessageBox(win!, {
            type: "warning",
            message: "Delete this session?",
            detail: "This permanently deletes it from opencode.",
            buttons: ["Delete", "Cancel"],
            defaultId: 1,
            cancelId: 1,
          })
          if (res.response !== 0) return
          await opencode.removeSession(sessionID).catch(report)
          store.assign(sessionID, null)
          push()
        },
      },
    ]).popup({ window: win })
  })
  const move = (sessionID: string, spaceID: string | null) => {
    store.assign(sessionID, spaceID)
    // Moving a session somewhere is a clear signal it's wanted again.
    if (store.data.archived[sessionID]) store.setArchived([sessionID], false)
    push()
  }
  ipcMain.handle("session:move", (_e, sessionID: string, spaceID: string | null) => move(sessionID, spaceID))
  ipcMain.handle("session:new", (_e, spaceID: string | null) => newSession(spaceID))
  ipcMain.handle("session:open", (_e, sessionID: string) => openSession(sessionID))

  ipcMain.on("pty:start", (_e, cols: number, rows: number) => terminal.start(cols, rows))
  ipcMain.on("pty:write", (_e, data: string) => terminal.write(data))
  ipcMain.on("pty:resize", (_e, cols: number, rows: number) => terminal.resize(cols, rows))
}

function report(err: unknown) {
  console.error(err)
  error = err instanceof Error ? err.message : String(err)
  push()
}

function createWindow() {
  win = new BrowserWindow({
    show: !headless,
    paintWhenInitiallyHidden: true,
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG,
    webPreferences: {
      preload: join(root, "dist/preload.cjs"),
      sandbox: false,
    },
  })
  // Intercept app shortcuts before they reach the focused terminal.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.meta || input.control || input.alt || input.shift) return
    const key = input.key.toLowerCase()
    const name =
      key === "p" || key === "k" ? "palette" : key === "n" ? "new-chat" : key === "," ? "settings" : null
    if (!name) return
    event.preventDefault()
    send("shortcut", name)
  })

  if (process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL)
  else win.loadFile(join(root, "dist/renderer/index.html"))

  // Debug helper: CTRL_SCREENSHOT=/path.png CTRL_SCREENSHOT_DELAY=8000
  const evalJs = process.env.CTRL_EVAL
  if (evalJs) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const result = await win!.webContents.executeJavaScript(evalJs)
          if (result !== undefined) console.log(`[ctrl] eval: ${JSON.stringify(result)}`)
        } catch (err) {
          console.error("[ctrl] eval failed", err)
        }
      }, 3000)
    })
  }

  const shot = process.env.CTRL_SCREENSHOT
  if (shot) {
    setTimeout(async () => {
      const image = await win!.webContents.capturePage()
      writeFileSync(shot, image.toPNG())
      console.log(`[ctrl] screenshot saved to ${shot}`)
    }, Number(process.env.CTRL_SCREENSHOT_DELAY ?? 8000))
  }
}

app.whenReady().then(async () => {
  if (headless && process.platform === "darwin") {
    // No dock icon, no activation: the app stays in the background.
    app.setActivationPolicy("accessory")
    app.dock?.hide()
  }
  registerIpc()
  await terminal.init()
  loadThemes()
  applyTheme()
  // When following the OS, re-theme (and restart the TUI) as the OS flips light/dark.
  nativeTheme.on("updated", () => {
    if (store.data.settings.appearance === "system") applyTheme()
  })
  createWindow()
  opencode.start().catch(report)
})

app.on("window-all-closed", () => {
  terminal.dispose()
  app.quit()
})
