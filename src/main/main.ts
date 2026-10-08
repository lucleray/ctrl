import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from "electron"
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FONT_SIZE,
  type AppState,
  type Settings,
  type Space,
  type SpacePatch,
  type ThemeInfo,
  type Toast,
  type UiState,
} from "../shared/types"
import { accelFromInput, commandFor, type CommandID } from "../shared/shortcuts"
import { Attention } from "./attention"
import { OpenCodeService } from "./opencode"
import { loadShellEnv } from "./shell-env"
import { Store } from "./store"
import { Terminal } from "./terminal"
import { cliThemeName, listThemes } from "./themes"

const root = join(fileURLToPath(import.meta.url), "../..")
const LIGHT_BG = "#f7f7f6"
const DARK_BG = "#1c1c1b"

// Dev runs keep their own state so they can't clobber the installed app's. The
// first run starts from a copy of the real state.
function useDevUserData() {
  const real = join(app.getPath("userData"), "state.json")
  const dir = join(app.getPath("appData"), "ctrl-dev")
  app.setPath("userData", dir)
  const dev = join(dir, "state.json")
  if (existsSync(dev) || !existsSync(real)) return
  mkdirSync(dir, { recursive: true })
  copyFileSync(real, dev)
}

app.setName("ctrl")
if (process.env.CTRL_USER_DATA) app.setPath("userData", process.env.CTRL_USER_DATA)
else if (!app.isPackaged) useDevUserData()

if (app.isPackaged) {
  loadShellEnv()
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    process.exit(0)
  }
}

// Test runs (CTRL_HEADLESS=1, implied by the debug hooks) never show the window or take focus.
const headless =
  process.env.CTRL_HEADLESS === "1" || !!process.env.CTRL_EVAL || !!process.env.CTRL_SCREENSHOT

let win: BrowserWindow | undefined
let quitting = false
const store = new Store(join(app.getPath("userData"), "state.json"))
let currentSessionID: string | null = null
let bridgeConnected = false
let bridgeProblem = false
let bridgeTimer: ReturnType<typeof setTimeout> | undefined
let error: string | undefined

// Only surface the TUI connection if it stays down; restarts (theme changes) take ~1s.
const BRIDGE_GRACE_MS = 8000
const watchBridge = () => {
  clearTimeout(bridgeTimer)
  bridgeProblem = false
  if (!bridgeConnected) {
    bridgeTimer = setTimeout(() => {
      bridgeProblem = true
      push()
    }, BRIDGE_GRACE_MS)
  }
}

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
  sessions: pendingDeletes.size ? opencode.sessions.filter((s) => !pendingDeletes.has(s.id)) : opencode.sessions,
  currentSessionID,
  bridgeConnected,
  problem: opencode.problem ?? (bridgeProblem ? "The embedded opencode TUI isn't responding" : undefined),
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

const terminal = new Terminal(app.isPackaged ? join(process.resourcesPath, "bridge") : join(root, "bridge"), {
  onData: (data) => send("pty:data", data),
  onReset: () => send("pty:reset"),
  onRoute: (id) => {
    currentSessionID = id
    opencode.setCurrent(id)
    push()
  },
  onBridge: (connected) => {
    bridgeConnected = connected
    watchBridge()
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

const clampFontSize = (size: number) => Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)))

const setFontSize = (size: number) => {
  const fontSize = clampFontSize(size)
  if (fontSize === store.data.settings.fontSize) return
  store.setSettings({ fontSize })
  push()
}

const openSession = (sessionID: string) => {
  currentSessionID = sessionID
  opencode.setCurrent(sessionID)
  terminal.open(sessionID)
  push()
}

/** Space model if it sets one, else the app default if on, else none (opencode decides). */
const modelFor = (space?: Space) => {
  if (space?.model && (space.modelEnabled ?? true)) return space.model
  const { defaultModel, defaultModelEnabled } = store.data.settings
  return (defaultModelEnabled && defaultModel) || undefined
}

const newSession = async (spaceID: string | null, directory?: string) => {
  const space = spaceID ? store.space(spaceID) : undefined
  const id = await opencode.createSession(directory || space?.directory || homedir(), {
    model: modelFor(space),
    instructions: space?.instructions,
  })
  if (spaceID) store.assign(id, spaceID)
  openSession(id)
}

/** New session in the current session's folder and space; a plain new chat when none is open. */
const newSessionHere = () => {
  const current = opencode.sessions.find((s) => s.id === currentSessionID)
  if (!current) return newSession(null)
  return newSession(store.data.assignments[current.id] ?? null, current.directory)
}

// ---------- toasts & undo ----------

const TOAST_MS = 8000
const undos = new Map<string, { run(): void; expires: number }>()

const toast = (t: Omit<Toast, "id" | "undo" | "duration">, undo?: () => void) => {
  const id = `tst_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  if (undo) undos.set(id, { run: undo, expires: Date.now() + TOAST_MS })
  send("toast", { ...t, id, undo: !!undo, duration: TOAST_MS } satisfies Toast)
  setTimeout(() => undos.delete(id), TOAST_MS + 1000)
}

const runUndo = (id: string) => {
  const entry = undos.get(id)
  undos.delete(id)
  entry?.run()
  push()
}

/** Most recent undo that's still on screen (for ⌘Z). */
const latestUndo = () => {
  const now = Date.now()
  return [...undos].reverse().find(([, u]) => u.expires > now)?.[0]
}

const archive = (sessionIDs: string[]) => {
  const ids = sessionIDs.filter((id) => !store.data.archived[id])
  if (!ids.length) return
  const wasCurrent = currentSessionID && ids.includes(currentSessionID) ? currentSessionID : null
  store.setArchived(ids, true)
  if (wasCurrent) terminal.home()
  push()
  const title = ids.length === 1 ? opencode.sessions.find((s) => s.id === ids[0])?.title : undefined
  toast(
    {
      icon: "archive",
      message: ids.length === 1 ? (title ? `Archived “${title}”` : "Archived chat") : `Archived ${ids.length} chats`,
      viewSessionID: ids.length === 1 ? ids[0] : undefined,
    },
    () => {
      store.setArchived(ids, false)
      if (wasCurrent && !currentSessionID) openSession(wasCurrent)
    },
  )
}

// Deleting is permanent in opencode, so hide the session right away and only
// delete it once the undo window has passed (or when ctrl quits).
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>()

const deleteSession = (sessionID: string) => {
  const title = opencode.sessions.find((s) => s.id === sessionID)?.title
  if (currentSessionID === sessionID) terminal.home()
  pendingDeletes.set(
    sessionID,
    setTimeout(() => void commitDelete(sessionID), TOAST_MS),
  )
  push()
  toast({ icon: "trash", message: title ? `Deleted “${title}”` : "Deleted chat" }, () => {
    clearTimeout(pendingDeletes.get(sessionID))
    pendingDeletes.delete(sessionID)
  })
}

const commitDelete = async (sessionID: string) => {
  if (!pendingDeletes.has(sessionID)) return
  clearTimeout(pendingDeletes.get(sessionID))
  try {
    await opencode.removeSession(sessionID)
    store.assign(sessionID, null)
    delete store.data.archived[sessionID]
    store.save()
  } catch (err) {
    report(err)
  } finally {
    pendingDeletes.delete(sessionID)
    push()
  }
}

const deleteSpace = (id: string) => {
  const index = store.data.spaces.findIndex((s) => s.id === id)
  const space = store.data.spaces[index]
  if (!space) return
  const sessionIDs = Object.entries(store.data.assignments)
    .filter(([, spaceID]) => spaceID === id)
    .map(([sessionID]) => sessionID)
  store.deleteSpace(id)
  push()
  toast({ icon: "trash", message: `Deleted space “${space.name}”` }, () => store.restoreSpace(space, index, sessionIDs))
}

// ---------- shortcuts ----------

let recordingShortcut = false

const runCommand = (id: CommandID) => {
  const size = store.data.settings.fontSize
  if (id === "zoom-in") return setFontSize(size + 1)
  if (id === "zoom-out") return setFontSize(size - 1)
  if (id === "zoom-reset") return setFontSize(FONT_SIZE.default)
  if (id === "undo") {
    const undo = latestUndo()
    if (undo) runUndo(undo)
    send("toast:dismiss", undo)
    return
  }
  if (id === "archive-session") {
    if (currentSessionID) archive([currentSessionID])
    return
  }
  if (id === "new-session-here") void newSessionHere().catch(report)
  // The renderer closes overlays and handles palette/settings/new-chat.
  send("shortcut", id)
}

function registerIpc() {
  ipcMain.handle("state", () => state())
  ipcMain.handle("error:dismiss", () => {
    error = undefined
    push()
  })
  ipcMain.handle("space:create", (_e, name: string) => {
    const id = store.createSpace(name)
    push()
    return id
  })
  ipcMain.handle("space:rename", (_e, id: string, name: string) => {
    store.updateSpace(id, { name })
    push()
  })
  ipcMain.handle("space:update", (_e, id: string, patch: SpacePatch) => {
    store.patchSpace(id, patch)
    push()
  })
  ipcMain.handle("space:pick-folder", async (_e, id: string) => {
    const space = store.space(id)
    if (!space || !win) return
    const res = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      defaultPath: space.directory || homedir(),
    })
    if (res.canceled || !res.filePaths[0]) return
    store.patchSpace(id, { directory: res.filePaths[0] })
    push()
  })
  ipcMain.handle("models:list", (_e, directory?: string) => opencode.listModels(directory))
  ipcMain.handle("space:move", (_e, id: string, index: number) => {
    store.moveSpace(id, index)
    push()
  })
  ipcMain.handle("session:rename", (_e, sessionID: string, title: string) =>
    opencode.renameSession(sessionID, title).catch(report),
  )
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    if (patch.fontSize !== undefined) patch = { ...patch, fontSize: clampFontSize(patch.fontSize) }
    store.setSettings(patch)
    loadThemes()
    applyTheme()
  })
  ipcMain.handle("ui:set", (_e, patch: Partial<UiState>) => {
    store.setUi(patch)
    push()
  })
  ipcMain.handle("session:archive", (_e, sessionID: string, archived: boolean) => {
    if (archived) return archive([sessionID])
    store.setArchived([sessionID], false)
    push()
  })
  ipcMain.handle("session:archive-current", () => {
    if (currentSessionID) archive([currentSessionID])
  })
  ipcMain.handle("session:new-here", () => newSessionHere())
  ipcMain.handle("toast:undo", (_e, id: string) => runUndo(id))
  ipcMain.handle("shortcut:record", (_e, on: boolean) => {
    recordingShortcut = on
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
      { label: "Space settings…", click: () => send("space:settings", id) },
      { type: "separator" },
      {
        label: "Archive all sessions",
        click: () =>
          archive(opencode.sessions.filter((s) => store.data.assignments[s.id] === id).map((s) => s.id)),
      },
      { label: "Delete space", click: () => deleteSpace(id) },
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
        : { label: "Archive", click: () => archive([sessionID]) },
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
      { label: "Delete session", click: () => deleteSession(sessionID) },
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
    icon: join(root, "build/icon.png"),
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
  // Mac-style: closing hides the window, the TUI keeps running, and the dock
  // icon brings it back. Only ⌘Q (or the dock's Quit) actually quits.
  win.on("close", (event) => {
    if (quitting || headless || process.platform !== "darwin") return
    event.preventDefault()
    const w = win!
    if (w.isFullScreen()) {
      w.once("leave-full-screen", () => w.hide())
      w.setFullScreen(false)
    } else w.hide()
  })
  // Intercept app shortcuts before they reach the focused terminal (or the app
  // menu, so ⌘W archives instead of closing). While a shortcut is being
  // recorded in settings, every key press goes to the recorder instead.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return
    const accel = accelFromInput(input)
    if (!accel) return
    if (recordingShortcut) {
      event.preventDefault()
      send("shortcut:recorded", accel)
      return
    }
    const id = commandFor(accel, store.data.settings.shortcuts)
    if (!id) return
    // ⌘Z only means undo while there's something to undo.
    if (id === "undo" && !latestUndo()) return
    // Nothing to archive: let the menu's Close Window hide ctrl as usual.
    if (id === "archive-session" && !currentSessionID) return
    event.preventDefault()
    runCommand(id)
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

  // Debug helper: send a main → renderer event after load, e.g. CTRL_SEND='["space:settings","spc_x"]'
  const sendEvent = process.env.CTRL_SEND
  if (sendEvent) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => send(...(JSON.parse(sendEvent) as [string, ...unknown[]])), 2000)
    })
  }

  // Debug helper: replay real keyboard input, e.g.
  // CTRL_INPUT='[[4000,"keyDown","Meta",["meta"]],[4100,"keyDown","2",["meta"]]]'
  const input = process.env.CTRL_INPUT
  if (input) {
    const events = JSON.parse(input) as [number, "keyDown" | "keyUp", string, string[]?][]
    for (const [at, type, keyCode, modifiers = []] of events) {
      setTimeout(
        () =>
          win?.webContents.sendInputEvent({
            type,
            keyCode,
            modifiers: modifiers as Electron.InputEvent["modifiers"],
          }),
        at,
      )
    }
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
  // In dev Electron shows its own icon; packaged builds use build/icon.icns.
  if (!app.isPackaged && !headless && process.platform === "darwin") app.dock?.setIcon(join(root, "build/icon.png"))
  if (headless && process.platform === "darwin") {
    // No dock icon, no activation: the app stays in the background.
    app.setActivationPolicy("accessory")
    app.dock?.hide()
  }
  registerIpc()
  await terminal.init()
  watchBridge()
  loadThemes()
  applyTheme()
  // When following the OS, re-theme (and restart the TUI) as the OS flips light/dark.
  nativeTheme.on("updated", () => {
    if (store.data.settings.appearance === "system") applyTheme()
  })
  createWindow()
  opencode.start().catch(report)
})

app.on("second-instance", () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.on("activate", () => {
  if (headless || !win || win.isDestroyed()) return
  win.show()
})

app.on("before-quit", (event) => {
  quitting = true
  // Finish deletions that were waiting out their undo window first.
  if (!pendingDeletes.size) return
  event.preventDefault()
  void Promise.allSettled([...pendingDeletes.keys()].map(commitDelete)).then(() => app.quit())
})

app.on("window-all-closed", () => app.quit())

app.on("will-quit", () => terminal.dispose())
