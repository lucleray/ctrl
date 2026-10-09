import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron"
import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FONT_SIZE,
  FX_INSTALL,
  harnessOf,
  type AppState,
  type FxCheck,
  type Harness,
  type ModelChoices,
  type ModelOption,
  type OpencodeCheck,
  type SessionItem,
  type Settings,
  type Space,
  type SoundEvent,
  type SpacePatch,
  type TermInfo,
  type ThemeInfo,
  type Toast,
  type UiState,
} from "../shared/types"
import { accelFromInput, commandFor, type CommandID } from "../shared/shortcuts"
import { Attention } from "./attention"
import { playSound } from "./sound"
import { ADAPTERS } from "../shared/adapters"
import { AdapterService } from "./adapters/service"
import { checkFx, FxSessions, rawID, SESSIONS_DIR } from "./fx"
import { FxTerminals, MAX_LIVE } from "./fx-terminals"
import { OpenCodeService } from "./opencode"
import { checkOpencode } from "./opencode-bin"
import { Skill } from "./skill"
import { Updater } from "./updater"
import { Search } from "./search"
import { loadShellEnv } from "./shell-env"
import { Store } from "./store"
import { Terminal } from "./terminal"
import { WrappedLinks } from "./wrapped-links" // wrapped-links
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
// The databases below open before Electron creates userData on its own.
mkdirSync(app.getPath("userData"), { recursive: true })

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
/** The single embedded opencode TUI, as a terminal next to the fx ones. */
const OPENCODE_TERM = "opencode"
/** The opencode TUI is on screen (and no fx terminal is). */
let showOpencode = false
/** Session the opencode TUI shows (route reported by the bridge); null = its home screen */
let opencodeRoute: string | null = null
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

const activeTermID = () => fxTerms.activeID ?? (showOpencode && opencodeStarted ? OPENCODE_TERM : null)

/** Session on screen, whichever harness it belongs to. */
const currentSessionID = (): string | null => {
  if (fxTerms.activeID) return fxTerms.active()?.sessionID ?? null
  return showOpencode ? opencodeRoute : null
}

/** Both harnesses' sessions, newest first. Rebuilt when either changes. */
let sessions: SessionItem[] = []
const rebuildSessions = () => {
  sessions = [...opencode.sessions, ...fx.sessions].sort((a, b) => b.updated - a.updated)
}
const sessionByID = (id: string) => sessions.find((s) => s.id === id)

const terms = (): TermInfo[] => [
  ...(opencodeStarted ? [{ id: OPENCODE_TERM, harness: "opencode" as const, sessionID: opencodeRoute }] : []),
  ...fxTerms.list(),
]

const state = (): AppState => ({
  version: app.getVersion(),
  opencode: opencodeCheck,
  fx: fxCheck,
  skill: skill.current,
  update: updater.status,
  spaces: store.data.spaces,
  assignments: store.data.assignments,
  archived: store.data.archived,
  ui: store.data.ui,
  settings: store.data.settings,
  themes,
  dark: nativeTheme.shouldUseDarkColors,
  sessions: pendingDeletes.size ? sessions.filter((s) => !pendingDeletes.has(s.id)) : sessions,
  currentSessionID: currentSessionID(),
  bridgeConnected,
  terms: terms(),
  activeTermID: activeTermID(),
  mcp: opencode.mcp,
  adapters: adapters.adapters,
  // Without a usable opencode, the setup screen (or Settings) explains what's wrong instead.
  problem:
    (opencodeCheck.state === "ok"
      ? (opencode.problem ?? (bridgeProblem ? "The embedded opencode TUI isn't responding" : undefined))
      : undefined) ?? fx.problem ?? undefined,
  error,
})

let pushQueued = false
const push = () => {
  if (pushQueued) return
  pushQueued = true
  queueMicrotask(() => {
    pushQueued = false
    attention.refreshBadge(sessions)
    send("state", state())
  })
}

/** Sessions running as of the last update, to notice runs ending. */
let running = new Set<string>()

const sessionsChanged = () => {
  rebuildSessions()
  attention.update(sessions)
  const now = new Set(sessions.filter((s) => s.status === "running").map((s) => s.id))
  const ended = [...running].filter((id) => !now.has(id))
  running = now
  if (ended.length) adapters.runsEnded(ended)
  push()
}

const opencode = new OpenCodeService(() => {
  watchMcp()
  sessionsChanged()
})

// ---------- fx ----------

/** You've seen everything up to now in this fx session: it stops being unread (opencode keeps its own read state). */
const markFxViewed = (sessionID: string | null) => {
  if (!sessionID || harnessOf(sessionID) !== "fx") return
  const at = fx.lastActivity(sessionID)
  if (at === undefined || (store.data.viewed[sessionID] ?? 0) >= at) return
  store.setViewed(sessionID, at)
}

const fx: FxSessions = new FxSessions({
  onChange: () => {
    markFxViewed(currentSessionID())
    sessionsChanged()
  },
  liveStatus: (id) => fxTerms.status(id),
  isOurPid: (pid) => fxTerms.isOurPid(pid),
  onOwner: (sessionID, pid) => {
    const claimed = fxTerms.claim(sessionID, pid)
    if (!claimed) return
    // A session started from a space joins it once fx tells us its id.
    if (claimed.spaceID && !claimed.previous) store.assign(sessionID, claimed.spaceID)
    // /new or /resume inside a space's session keeps you in that space.
    else if (claimed.previous && store.data.assignments[claimed.previous] && !store.data.assignments[sessionID])
      store.assign(sessionID, store.data.assignments[claimed.previous])
    if (claimed.previous) fx.readSoon(rawID(claimed.previous))
  },
  viewedAt: (id) => Math.max(store.data.viewed[id] ?? 0, store.data.viewedSince),
  titleOverride: (id) => store.data.titles[id],
  currentSessionID,
})

const fxTerms: FxTerminals = new FxTerminals({
  onData: (termID, data, end) => send("pty:data", termID, data, end),
  onChange: () => {
    fx.rebuild()
    saveOpen()
  },
  // A status report (turn done, waiting on you) means the session's files changed too.
  onStatus: (sessionID) => fx.readSoon(rawID(sessionID)),
  onExit: (_termID, sessionID) => {
    if (!sessionID) return
    // fx is gone: flush a rename that had to wait, and refresh the owner.
    setTimeout(() => void flushTitle(sessionID), 300)
    fx.readSoon(rawID(sessionID))
  },
})
if (store.data.termSize) fxTerms.size = store.data.termSize

let fxCheck: FxCheck = { state: "checking" }
let fxStarted = false

/** fx is optional: its sessions show up once it's installed. */
const recheckFx = async () => {
  fxCheck = await checkFx()
  console.log(`[ctrl] fx: ${JSON.stringify(fxCheck)}`)
  if (fxCheck.state === "ok" && !fxStarted) {
    fxStarted = true
    await fx.start()
    // Renames that were waiting for an fx that has quit since.
    for (const id of Object.keys(store.data.titles)) void flushTitle(id)
  }
  push()
}

const search = new Search(join(root, "dist/indexer.cjs"), join(app.getPath("userData"), "search.db"), (ids) => {
  send("resources:changed", ids)
  adapters.resourcesChanged(ids)
})

const adapters = new AdapterService(
  join(app.getPath("userData"), "resource-meta.db"),
  ADAPTERS,
  store.data.settings.adapterModes,
  {
    list: (sessionIDs) => search.resources(sessionIDs),
    onMeta: (metas) => send("resources:meta", metas),
    onStatus: push,
  },
)
void adapters.check()

// wrapped-links
const wrappedLinks = new WrappedLinks(
  () => opencode.client,
  (id) => sessionByID(id)?.updated,
)

const attention = new Attention({
  window: () => win,
  settings: () => store.data.settings,
  isArchived: (id) => !!store.data.archived[id],
  open: (id) => openSession(id),
  quiet: headless,
})

let opencodeOut = 0
const terminal = new Terminal(app.isPackaged ? join(process.resourcesPath, "bridge") : join(root, "bridge"), {
  onData: (data) => {
    opencodeOut += data.length
    send("pty:data", OPENCODE_TERM, data, opencodeOut)
  },
  onReset: () => send("pty:reset", OPENCODE_TERM),
  onRoute: (id) => {
    opencodeRoute = id
    if (showOpencode) opencode.setCurrent(id)
    saveOpen()
    push()
  },
  onBridge: (connected) => {
    bridgeConnected = connected
    watchBridge()
    push()
  },
})

// ---------- opencode install, read-session skill, updates ----------

let opencodeCheck: OpencodeCheck = { state: "checking" }
let opencodeStarted = false

/** The TUI and the service connection only start once a recent enough opencode is installed. */
const recheckOpencode = async () => {
  opencodeCheck = await checkOpencode()
  console.log(`[ctrl] opencode: ${JSON.stringify(opencodeCheck)}`)
  if (opencodeCheck.state === "ok" && !opencodeStarted) {
    opencodeStarted = true
    opencode.start().catch(report)
    const size = store.data.termSize ?? fxTerms.size
    terminal.start(size.cols, size.rows)
    // On screen at launch unless an fx session takes its place (restoreOpen).
    if (!fxTerms.activeID) showOpencode = true
  }
  push()
}

const skill = new Skill(
  app.isPackaged ? join(process.resourcesPath, "skills", "read-session") : join(root, "skills", "read-session"),
)
let skillSuggested = false

const installSkill = () => {
  try {
    skill.install()
    toast({ icon: "check", message: "Installed the read-session skill. Sessions you drop on the terminal can now be read by the agent" })
  } catch (err) {
    report(err)
  }
  push()
}

/** Offers the skill once per launch: at the first launch, then whenever a session is referenced without it. */
const suggestSkill = () => {
  if (skillSuggested || skill.refresh().state !== "missing") return
  skillSuggested = true
  toast(
    { icon: "link", message: "Install the read-session skill so agents can read the sessions you drop on the terminal?" },
    { action: { label: "Install", run: installSkill } },
  )
}

/** ctrl's copy of the skill follows ctrl's version. */
const refreshSkill = () => {
  if (skill.refresh().state !== "outdated") return
  try {
    skill.install()
  } catch (err) {
    console.error("[ctrl] couldn't refresh the read-session skill", err)
  }
}

const updater = new Updater(app.getVersion(), {
  onChange: push,
  onAvailable: (version) =>
    toast(
      { icon: "download", message: `ctrl ${version} is available` },
      { sticky: true, action: { label: "Update", run: () => void updater.install().catch(report) } },
    ),
  quit: () => app.quit(),
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
    opencodeRoute,
  )
  fxTerms.colorScheme(dark)
  push()
}

const clampFontSize = (size: number) => Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)))

const setFontSize = (size: number) => {
  const fontSize = clampFontSize(size)
  if (fontSize === store.data.settings.fontSize) return
  store.setSettings({ fontSize })
  push()
}

/** Shows the opencode TUI (and no fx terminal). */
const showOpencodeTerm = () => {
  markFxViewed(currentSessionID())
  showOpencode = true
  fxTerms.deactivate()
}

/** Shows an fx terminal: the opencode TUI goes to the back, and its session stops counting as on screen. */
const showFxTerm = () => {
  markFxViewed(currentSessionID())
  showOpencode = false
  opencode.setCurrent(null)
}

/** Nothing on screen: the empty state. */
const showNothing = () => {
  markFxViewed(currentSessionID())
  showOpencode = false
  opencode.setCurrent(null)
  fxTerms.deactivate()
}

const openSession = (sessionID: string) => {
  if (harnessOf(sessionID) === "fx") return openFxSession(sessionID)
  if (!opencodeStarted) return report(new Error("opencode isn't installed, so its sessions can't be opened"))
  showOpencodeTerm()
  opencodeRoute = sessionID
  opencode.setCurrent(sessionID)
  terminal.open(sessionID)
  saveOpen()
  push()
}

const openFxSession = (sessionID: string) => {
  const session = fx.get(sessionID)
  if (!session) return
  if (!fxTerms.bySession(sessionID) && session.ownerPid !== undefined && !fxTerms.isOurPid(session.ownerPid)) {
    toast({
      icon: "alert",
      message: `“${sessionByID(sessionID)?.title ?? "This session"}” is open in another terminal (pid ${session.ownerPid}). Quit fx there to open it here.`,
    })
    return
  }
  showFxTerm()
  void flushTitle(sessionID).finally(() => {
    fxTerms.open(sessionID, { cwd: session.directory, env: {} })
    markFxViewed(sessionID)
    push()
  })
}

/** Space harness if it sets one, else the app default. Falls back to the other one when that isn't installed. */
const harnessFor = (space?: Space): Harness => {
  const wanted = space?.harness ?? store.data.settings.defaultHarness
  const ready = (h: Harness) => (h === "fx" ? fxStarted : opencodeStarted)
  const other: Harness = wanted === "fx" ? "opencode" : "fx"
  return !ready(wanted) && ready(other) ? other : wanted
}

/** Space model for that harness if it sets one, else the app default if on, else none (the harness decides). */
const modelFor = (harness: Harness, space?: Space) => {
  const on = (space?.modelEnabled ?? true) && space
  const spaceModel = harness === "fx" ? space?.fxModel : space?.model
  if (on && spaceModel) return spaceModel
  const { defaultModel, defaultFxModel, defaultModelEnabled } = store.data.settings
  return (defaultModelEnabled && (harness === "fx" ? defaultFxModel : defaultModel)) || undefined
}

const newSession = async (spaceID: string | null, directory?: string, harness?: Harness) => {
  const space = spaceID ? store.space(spaceID) : undefined
  harness ??= harnessFor(space)
  const cwd = directory || space?.directory || homedir()
  const model = modelFor(harness, space)
  if (harness === "fx") {
    if (!fxStarted) throw new Error(`fx isn't installed. Install it with: ${FX_INSTALL}`)
    const args = model ? ["--model", model.id, ...(model.variant ? ["--effort", model.variant] : [])] : []
    showFxTerm()
    // The session joins the space once fx reports its id (onOwner).
    fxTerms.create({ cwd, args, env: {}, spaceID })
    push()
    return
  }
  if (!opencodeStarted) throw new Error("opencode isn't installed, so ctrl can't start an opencode session")
  const id = await opencode.createSession(cwd, { model, instructions: space?.instructions })
  if (spaceID) store.assign(id, spaceID)
  openSession(id)
}

/** New session in the current session's folder, space and harness; a plain new chat when none is open. */
const newSessionHere = () => {
  const current = sessionByID(currentSessionID() ?? "")
  if (!current) return newSession(null)
  return newSession(store.data.assignments[current.id] ?? null, current.directory, current.harness)
}

// ---------- reopening sessions at launch ----------

/** Off until the saved list has been read back, so the empty startup state can't overwrite it. */
let restored = false
const RESTORE_STAGGER_MS = 300

const saveOpen = () => {
  if (restored) store.setOpen(fxTerms.openSessions().slice(0, MAX_LIVE), currentSessionID())
}

/**
 * fx has no background service, so its processes die with ctrl. Bring back the fx sessions that
 * were open, in the background one at a time, and whichever session was on screen. `fx resume`
 * reprints each conversation.
 */
const restoreOpen = () => {
  const { sessions: open, current } = store.data.open
  const reopenable = (id: string) => {
    if (store.data.archived[id]) return false
    // opencode's list may still be loading: the TUI opens it (or says it's gone) either way.
    if (harnessOf(id) === "opencode") return opencodeStarted
    const s = fx.get(id)
    // Opened in another terminal since: fx won't let two processes share it.
    return !!s && (s.ownerPid === undefined || fxTerms.isOurPid(s.ownerPid))
  }
  const rest = open.filter((id) => id !== current && harnessOf(id) === "fx" && reopenable(id)).slice(0, MAX_LIVE - 1)
  if (current && reopenable(current)) openSession(current)
  // Least recent first, so the most recent ends up first in the next save.
  rest.reverse().forEach((id, i) =>
    setTimeout(() => {
      const s = fx.get(id)
      if (s && !fxTerms.bySession(id)) fxTerms.open(id, { cwd: s.directory, env: {} }, true)
    }, RESTORE_STAGGER_MS * (i + 1)),
  )
  restored = true
  if (current || rest.length) console.log(`[ctrl] reopening ${rest.length + (current ? 1 : 0)} sessions`)
}

// ---------- titles ----------

const renameSession = async (sessionID: string, title: string) => {
  if (harnessOf(sessionID) === "opencode") return opencode.renameSession(sessionID, title)
  title = title.trim()
  if (!title) return
  // fx rewrites session.json while it runs, so the rename waits in state.json until no fx owns the session.
  store.setTitle(sessionID, title)
  fx.rebuild()
  await flushTitle(sessionID)
}

const flushTitle = async (sessionID: string) => {
  const title = store.data.titles[sessionID]
  const session = fx.get(sessionID)
  if (!title || !session) return
  if (session.ownerPid !== undefined || fxTerms.bySession(sessionID)) return
  try {
    await fx.writeTitle(sessionID, title)
    store.setTitle(sessionID, null)
  } catch (err) {
    console.error("[ctrl] couldn't write the fx title", err)
  }
}

// ---------- models ----------

let fxModelCache: { at: number; choices: Promise<ModelChoices> } | undefined
const FX_MODEL_CACHE_MS = 5 * 60_000

/** `fx models --json` for fx's active provider. Newer fx also lists each model's efforts. */
const listFxModels = (): Promise<ModelChoices> => {
  if (fxCheck.state !== "ok") return Promise.reject(new Error("fx isn't installed"))
  if (fxModelCache && Date.now() - fxModelCache.at < FX_MODEL_CACHE_MS) return fxModelCache.choices
  const bin = fxCheck.bin
  const choices = new Promise<ModelChoices>((resolve, reject) => {
    execFile(bin, ["models", "--json"], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      type Listed = { id: string; name?: string; efforts?: string[] }
      let json: { ids?: string[]; models?: Listed[] }
      try {
        json = JSON.parse(stdout)
      } catch {
        return reject(err ?? new Error("fx models returned no JSON"))
      }
      const list: Listed[] = json.models ?? (json.ids ?? []).map((id) => ({ id }))
      const models: ModelOption[] = list.map((m, i) => ({
        providerID: "fx",
        id: m.id,
        name: m.name ?? m.id.split("/").pop()!,
        providerName: "fx",
        vendor: m.id.includes("/") ? m.id.split("/")[0] : undefined,
        // fx lists newest first within a vendor; keep that order.
        released: list.length - i,
        variants: m.efforts ?? [],
      }))
      models.sort((a, b) => (a.vendor ?? "").localeCompare(b.vendor ?? "") || b.released - a.released)
      resolve({ models, providers: [{ id: "fx", name: "fx" }] })
    })
  })
  fxModelCache = { at: Date.now(), choices }
  choices.catch(() => (fxModelCache = undefined))
  return choices
}

// ---------- toasts & undo ----------

const TOAST_MS = 8000
const undos = new Map<string, { run(): void; expires: number }>()
const toastActions = new Map<string, () => void>()

type ToastOptions = {
  undo?: () => void
  /** Primary button, e.g. { label: "Fix", run } */
  action?: { label: string; run(): void }
  /** Stays up until dismissed, for problems that outlive the moment (dismiss it yourself once resolved) */
  sticky?: boolean
}

/** The one way to notify inside ctrl (docs/ARCHITECTURE.md → Notifications). Returns the toast id. */
const toast = (t: Pick<Toast, "icon" | "message" | "viewSessionID">, opts: ToastOptions = {}) => {
  const id = `tst_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const duration = opts.sticky ? null : TOAST_MS
  if (opts.undo) undos.set(id, { run: opts.undo, expires: Date.now() + TOAST_MS })
  if (opts.action) toastActions.set(id, opts.action.run)
  send("toast", { ...t, id, undo: !!opts.undo, action: opts.action?.label, duration } satisfies Toast)
  if (!opts.sticky) setTimeout(() => (undos.delete(id), toastActions.delete(id)), TOAST_MS + 1000)
  return id
}

const dismissToast = (id: string) => {
  undos.delete(id)
  toastActions.delete(id)
  send("toast:dismiss", id)
}

const runToastAction = (id: string) => {
  const run = toastActions.get(id)
  toastActions.delete(id)
  run?.()
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
  const current = currentSessionID()
  const wasCurrent = current && ids.includes(current) ? current : null
  store.setArchived(ids, true)
  if (wasCurrent) leave(wasCurrent)
  // Archived fx sessions don't need a process, unless they're busy.
  for (const id of ids) {
    if (harnessOf(id) !== "fx") continue
    const status = fxTerms.status(id)?.state
    if (status !== "working" && status !== "blocked") fxTerms.closeSession(id)
  }
  push()
  const title = ids.length === 1 ? sessionByID(ids[0])?.title : undefined
  toast(
    {
      icon: "archive",
      message: ids.length === 1 ? (title ? `Archived “${title}”` : "Archived chat") : `Archived ${ids.length} chats`,
      viewSessionID: ids.length === 1 ? ids[0] : undefined,
    },
    {
      undo: () => {
        store.setArchived(ids, false)
        if (wasCurrent && !currentSessionID()) openSession(wasCurrent)
      },
    },
  )
}

/** The session on screen goes away (archived, deleted): opencode goes back to its home screen, fx to the empty state. */
const leave = (sessionID: string) => {
  if (harnessOf(sessionID) === "opencode") terminal.home()
  else showNothing()
}

// Deleting is permanent (opencode removes it, fx's folder goes to the Trash), so hide
// the session right away and only delete it once the undo window has passed (or when ctrl quits).
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>()

const deleteSession = (sessionID: string) => {
  const title = sessionByID(sessionID)?.title
  const fxSession = fx.get(sessionID)
  if (harnessOf(sessionID) === "fx" && fxSession?.ownerPid !== undefined && !fxTerms.isOurPid(fxSession.ownerPid)) {
    toast({ icon: "alert", message: `“${title}” is open in another terminal. Quit fx there to delete it.` })
    return
  }
  if (currentSessionID() === sessionID) leave(sessionID)
  pendingDeletes.set(
    sessionID,
    setTimeout(() => void commitDelete(sessionID), TOAST_MS),
  )
  push()
  toast(
    { icon: "trash", message: title ? `Deleted “${title}”` : "Deleted chat" },
    {
      undo: () => {
        clearTimeout(pendingDeletes.get(sessionID))
        pendingDeletes.delete(sessionID)
      },
    },
  )
}

const commitDelete = async (sessionID: string) => {
  if (!pendingDeletes.has(sessionID)) return
  clearTimeout(pendingDeletes.get(sessionID))
  try {
    if (harnessOf(sessionID) === "fx") {
      const term = fxTerms.bySession(sessionID)
      if (term) {
        fxTerms.close(term.id)
        // Let fx release its lock and finish writing before the folder moves.
        await new Promise((r) => setTimeout(r, 500))
      }
      // The Trash, not rm: a mistaken delete can still be recovered from Finder.
      await shell.trashItem(join(SESSIONS_DIR, rawID(sessionID)))
      fx.forget(sessionID)
    } else await opencode.removeSession(sessionID)
    store.forgetSession(sessionID)
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
  toast(
    { icon: "trash", message: `Deleted space “${space.name}”` },
    { undo: () => store.restoreSpace(space, index, sessionIDs) },
  )
}

// ---------- MCP servers ----------

const MCP_BROKEN = new Set(["failed", "needs_auth"])
/** Open "MCP failing" toast per server, keyed by the error it shows, so the same failure doesn't re-toast. */
const mcpAlerts = new Map<string, { error: string; toastID: string }>()

/** Toasts once per new MCP failure (including at launch) and clears the toast when the server recovers. */
const watchMcp = () => {
  for (const server of opencode.mcp) {
    const alert = mcpAlerts.get(server.name)
    if (!MCP_BROKEN.has(server.status)) {
      // pending = reconnecting: keep the toast until it actually settles.
      if (alert && server.status !== "pending") {
        dismissToast(alert.toastID)
        mcpAlerts.delete(server.name)
      }
      continue
    }
    const error = server.error ?? server.status
    if (alert?.error === error) continue
    if (alert) dismissToast(alert.toastID)
    const what = server.status === "needs_auth" ? "needs sign-in" : "is failing"
    const toastID = toast(
      { icon: "alert", message: `MCP “${server.name}” ${what}: ${error}` },
      { sticky: true, action: { label: "Fix", run: () => fixMcp(server.name) } },
    )
    mcpAlerts.set(server.name, { error, toastID })
  }
  for (const [name, alert] of mcpAlerts) {
    if (opencode.mcp.some((s) => s.name === name)) continue
    dismissToast(alert.toastID)
    mcpAlerts.delete(name)
  }
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Opens the TUI's new-session screen with a fix-it prompt typed in, not sent. */
const fixMcp = (name: string) => {
  const server = opencode.mcp.find((s) => s.name === name)
  const status = server?.status ?? "failed"
  const error = server?.error ? `, error: "${oneLine(server.error, 300)}"` : ""
  const prompt =
    `The "${name}" MCP server is broken in opencode (status: ${status}${error}). ` +
    `Diagnose and fix it: check its entry in my opencode config and \`opencode mcp list\`. ` +
    `If it only needs sign-in, tell me to run /mcps and select it instead.`
  showOpencodeTerm()
  terminal.prefill(prompt)
  push()
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
    const current = currentSessionID()
    if (current) archive([current])
    return
  }
  if (id === "new-session-here") void newSessionHere().catch(report)
  if (id === "toggle-resources") {
    store.setUi({ resourcesOpen: !store.data.ui.resourcesOpen })
    push()
    return
  }
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
  ipcMain.handle("models:list", (_e, harness: Harness, directory?: string) =>
    harness === "fx" ? listFxModels() : opencode.listModels(directory),
  )
  ipcMain.handle("space:move", (_e, id: string, index: number) => {
    store.moveSpace(id, index)
    push()
  })
  ipcMain.handle("session:rename", (_e, sessionID: string, title: string) =>
    renameSession(sessionID, title).catch(report),
  )
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    if (patch.fontSize !== undefined) patch = { ...patch, fontSize: clampFontSize(patch.fontSize) }
    store.setSettings(patch)
    if (patch.adapterModes) {
      adapters.setModes(patch.adapterModes)
      // Panels re-read their resources: without an adapter that's off, with or without its details.
      send("resources:changed", null)
    }
    loadThemes()
    applyTheme()
  })
  ipcMain.handle("sound:play", (_e, choice: string) => playSound(choice))
  ipcMain.handle("sound:pick", async (_e, event: SoundEvent) => {
    if (!win) return null
    const current = store.data.settings.soundChoices[event]
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      defaultPath: current?.startsWith("/") ? current : homedir(),
      filters: [{ name: "Audio", extensions: ["aiff", "aif", "wav", "mp3", "m4a", "caf", "aac"] }],
    })
    const file = res.filePaths[0]
    if (res.canceled || !file) return null
    store.setSettings({ soundChoices: { ...store.data.settings.soundChoices, [event]: file } })
    playSound(file)
    push()
    return file
  })
  ipcMain.handle("ui:set", (_e, patch: Partial<UiState>) => {
    store.setUi(patch)
    push()
    // The skill offer waits for the welcome screen, so it doesn't land on top of it.
    if (patch.onboarded && !store.data.ui.skillPrompted && skill.refresh().state === "missing") {
      store.setUi({ skillPrompted: true })
      setTimeout(suggestSkill, 1500)
    }
  })
  ipcMain.handle("session:archive", (_e, sessionID: string, archived: boolean) => {
    if (archived) return archive([sessionID])
    store.setArchived([sessionID], false)
    push()
  })
  ipcMain.handle("session:archive-current", () => {
    const current = currentSessionID()
    if (current) archive([current])
  })
  ipcMain.handle("session:new-here", () => newSessionHere())
  ipcMain.handle("open-external", (_e, url: string) => openExternal(url))
  // wrapped-links
  ipcMain.handle("links:resolve", (_e, url: string, next: string) => wrappedLinks.resolve(currentSessionID(), url, next))
  ipcMain.handle("links:prefetch", () => {
    const current = currentSessionID()
    if (current) wrappedLinks.prefetch(current)
  })
  ipcMain.handle("toast:undo", (_e, id: string) => runUndo(id))
  ipcMain.handle("toast:action", (_e, id: string) => runToastAction(id))
  ipcMain.handle("mcp:fix", (_e, name: string) => fixMcp(name))
  ipcMain.handle("mcp:reconnect", (_e, name: string) => opencode.reconnectMcp(name).catch(report))
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
    const harness = harnessFor(space)
    const other: Harness = harness === "fx" ? "opencode" : "fx"
    const otherReady = other === "fx" ? fxStarted : opencodeStarted
    Menu.buildFromTemplate([
      { label: "New session", click: () => void newSession(id).catch(report) },
      ...(otherReady
        ? [{ label: `New ${other} session`, click: () => void newSession(id, undefined, other).catch(report) }]
        : []),
      { type: "separator" },
      { label: "Rename", click: () => send("space:rename", id) },
      { label: "Space settings…", click: () => send("space:settings", id) },
      { type: "separator" },
      {
        label: "Archive all sessions",
        click: () =>
          archive(sessions.filter((s) => store.data.assignments[s.id] === id).map((s) => s.id)),
      },
      { label: "Delete space", click: () => deleteSpace(id) },
    ]).popup({ window: win })
  })
  ipcMain.handle("session:menu", (_e, sessionID: string) => {
    if (!win) return
    const current = store.data.assignments[sessionID] ?? null
    const fxTerm = harnessOf(sessionID) === "fx" ? fxTerms.bySession(sessionID) : undefined
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
      ...(harnessOf(sessionID) === "fx"
        ? [
            { type: "separator" as const },
            {
              label: "Reveal session folder",
              click: () => shell.showItemInFolder(join(SESSIONS_DIR, rawID(sessionID), "session.json")),
            },
            ...(fxTerm ? [{ label: "Quit fx process", click: () => fxTerms.close(fxTerm.id) }] : []),
          ]
        : []),
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
  ipcMain.handle("search", (_e, query: string) => search.search(query))
  ipcMain.handle("resources:list", (_e, sessionIDs: string[]) =>
    search
      .resources(sessionIDs)
      .filter((r) => adapters.shows(r.type))
      .map((r) => ({ ...r, meta: adapters.get(r) })),
  )
  ipcMain.on("resources:watch", (_e, sessionIDs: string[]) => adapters.watch(sessionIDs))
  ipcMain.handle("adapter:retry", (_e, id: string) => adapters.retry(id))
  ipcMain.handle("adapters:check", () => {
    // Settings just opened: also pick up a skill installed or removed by hand.
    skill.refresh()
    push()
    return adapters.check()
  })

  ipcMain.handle("opencode:recheck", () => Promise.all([recheckOpencode(), recheckFx()]))
  ipcMain.handle("skill:install", () => installSkill())
  ipcMain.handle("skill:uninstall", () => {
    skill.uninstall()
    push()
  })
  ipcMain.handle("skill:referenced", () => suggestSkill())
  ipcMain.handle("update:check", () => updater.check())
  ipcMain.handle("update:install", () => updater.install().catch(report))

  // The opencode TUI repaints itself, so a re-attached xterm only needs live output from here on.
  ipcMain.handle("pty:attach", (_e, termID: string) =>
    termID === OPENCODE_TERM ? { data: "", end: opencodeOut } : fxTerms.backlog(termID),
  )
  ipcMain.on("pty:write", (_e, termID: string, data: string) =>
    termID === OPENCODE_TERM ? terminal.write(data) : fxTerms.write(termID, data),
  )
  ipcMain.on("pty:resize", (_e, cols: number, rows: number) => {
    terminal.resize(cols, rows)
    fxTerms.resize(cols, rows)
    store.setTermSize(cols, rows)
  })
}

const openExternal = (url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return
  if (headless) return console.log(`[ctrl] open external (suppressed): ${parsed.href}`)
  void shell.openExternal(parsed.href)
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
  // Live resource details only refresh while you're looking (test runs never get focus).
  adapters.setFocused(headless || win.isFocused())
  win.on("focus", () => adapters.setFocused(true))
  win.on("blur", () => adapters.setFocused(headless))

  // Never open Electron windows for links; hand them to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    if (url === win?.webContents.getURL()) return
    event.preventDefault()
    openExternal(url)
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
    if (id === "archive-session" && !currentSessionID()) return
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

  // Debug helper: CTRL_FRAMES=<dir>,<startMs>,<intervalMs>,<count> captures numbered frames (for GIFs)
  const frames = process.env.CTRL_FRAMES?.split(",")
  if (frames) {
    const [dir, start, interval, count] = [frames[0], ...frames.slice(1).map(Number)]
    mkdirSync(dir, { recursive: true })
    setTimeout(async () => {
      for (let i = 0; i < count; i++) {
        const next = Date.now() + interval
        const image = await win!.webContents.capturePage()
        writeFileSync(join(dir, `${String(i).padStart(4, "0")}.png`), image.toPNG())
        await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())))
      }
      console.log(`[ctrl] ${count} frames saved to ${dir}`)
    }, start)
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
  // Both checks first: the session on screen at quit comes back, whichever harness it belongs to.
  void Promise.all([recheckOpencode(), recheckFx()]).then(restoreOpen)
  search.start()
  refreshSkill()
  if (!store.data.ui.skillPrompted && skill.refresh().state === "missing") {
    win!.webContents.once("did-finish-load", () =>
      setTimeout(() => {
        // One thing at a time: the welcome screen comes first (finishing it offers the skill).
        if (!store.data.ui.onboarded) return
        store.setUi({ skillPrompted: true })
        suggestSkill()
      }, 3000),
    )
  }
  // CTRL_UPDATES=1 is a test hook (docs/DEVELOPMENT.md): dev runs don't update themselves otherwise.
  if (app.isPackaged || process.env.CTRL_UPDATES === "1") updater.start()
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

app.on("will-quit", () => {
  terminal.dispose()
  fxTerms.dispose()
  fx.stop()
  search.stop()
  adapters.stop()
  updater.stop()
})
