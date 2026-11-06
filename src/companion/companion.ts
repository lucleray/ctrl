// The ctrl Companion: a small always-on-top window listing the sessions that mentioned what's on screen
// (the PR in your browser, the Slack thread you're reading), and starting a new one about it (its New
// button, or a shortcut from any app). Off by default (Settings → ctrl Companion).
//
//   ctrl-context (Swift, native/context.swift) ──JSON lines──► Companion ──view──► companion window
//        └ frontmost app: browser tab URL, Slack/Notion/Linear via Accessibility
//   Companion: URLs → resource keys (shared adapters) → search.db mentions → sessions
//
// Everything lives here and in src/renderer/companion: main only creates it, turns it on and off, and
// tells it when sessions or resources changed. While off, nothing runs (no process, no window, no shortcut).

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeTheme, screen, shell, systemPreferences } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { SessionItem } from "../shared/types"
import type { SessionMention } from "../main/search-db"
import { parseResourceUrl } from "../shared/adapters"
import { formatAccel } from "../shared/shortcuts"
import { lookupFor, relatedName } from "./match"
import type { CompanionGroup, CompanionSession, CompanionView, ProbeMessage } from "./types"

export type CompanionHost = {
  /** dist/ folder (dev) */
  root: string
  sessions(): SessionItem[]
  isArchived(id: string): boolean
  /** The space a session is in, if any */
  spaceOf(id: string): { id: string; name: string } | undefined
  sessionsMentioning(ids: string[], prefixes: string[]): { exact: SessionMention[]; related: SessionMention[] }
  /** Brings ctrl's main window forward on that session */
  open(sessionID: string): void
  /** Brings ctrl's main window forward on a new session, with `text` typed in (not sent) */
  newSession(text: string): void
  /** Bindings of the new-session shortcut (registered globally while on) */
  shortcuts(): string[]
  /** Brings ctrl's main window forward, on Settings if asked */
  show(settings?: boolean): void
  /** "Hide" in the window's menu turns the setting off */
  disable(): void
}

const WIDTH = 300
const MAX_ROWS = 10
const MARGIN = 18
/** ⌃1–9 open the companion's rows, from any app */
const JUMPS = 9
// Same as the sidebar (--sidebar-bg in styles.css): the window paints before the page does.
const LIGHT_BG = "#f4f4f3"
const DARK_BG = "#1f1f1e"

type Saved = { x: number; y: number }

export class Companion {
  private win?: BrowserWindow
  private probe?: ChildProcess
  private enabled = false
  private trusted = true
  private context: Extract<ProbeMessage, { type: "context" }> | null = null
  private lastSent = ""
  private timer?: ReturnType<typeof setTimeout>
  private restarts = 0
  private registered: string[] = []
  /** Sessions ⌃1… open, in order; only that many ⌃N are registered, so the rest stay free for other apps */
  private jumps: string[] = []
  private jumpsRegistered = 0
  private shortcutsPaused = false
  private readonly savedPath = join(app.getPath("userData"), "companion.json")

  constructor(private host: CompanionHost) {
    ipcMain.on("companion:open", (_e, id: string) => this.host.open(id))
    ipcMain.on("companion:new", () => this.newSession())
    ipcMain.on("companion:resize", (_e, height: number) => this.resize(height))
    ipcMain.on("companion:menu", () => this.menu())
    ipcMain.on("companion:access", () => {
      systemPreferences.isTrustedAccessibilityClient(true)
      void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    })
  }

  setEnabled(on: boolean) {
    if (process.platform !== "darwin" || on === this.enabled) return
    this.enabled = on
    if (on) {
      this.restarts = 0
      this.createWindow()
      this.startProbe()
    } else {
      this.stopProbe()
      this.unregisterShortcuts()
      this.win?.destroy()
      this.win = undefined
      this.context = null
      this.lastSent = ""
    }
    this.updateShortcuts()
  }

  private menu() {
    const win = this.win
    if (!win || win.isDestroyed()) return
    Menu.buildFromTemplate([
      {
        label: "New session",
        accelerator: this.host.shortcuts()[0],
        registerAccelerator: false,
        click: () => this.newSession(),
      },
      { label: "Open ctrl", click: () => this.host.show() },
      { label: "Settings…", click: () => this.host.show(true) },
      { type: "separator" },
      { label: "Hide ctrl Companion", toolTip: "Turn it back on in Settings", click: () => this.host.disable() },
    ]).popup({ window: win })
  }

  /** New session about what's on screen: its link typed in, so you can ask about it. */
  newSession() {
    this.host.newSession(this.contextUrl())
  }

  /** The link for what's on screen: the first one ctrl recognizes, else the first one; "" without one. */
  contextUrl(): string {
    const urls = this.context?.urls ?? []
    return urls.find((u) => parseResourceUrl(u)) ?? urls[0] ?? ""
  }

  /** Settings changed: (re)register the global shortcut with the current bindings. */
  updateShortcuts() {
    if (!this.enabled || this.shortcutsPaused) return this.unregisterShortcuts()
    const wanted = this.host.shortcuts()
    if (wanted.join("\n") === this.registered.join("\n")) return
    this.unregisterShortcuts()
    for (const accel of wanted) {
      try {
        if (globalShortcut.register(accel, () => this.newSession())) this.registered.push(accel)
        else console.error(`[ctrl] companion: ${accel} is taken by another app`)
      } catch (e) {
        console.error(`[ctrl] companion: can't register ${accel}: ${e}`)
      }
    }
    this.lastSent = ""
    this.render()
  }

  /** While a shortcut is being recorded in Settings, the keys go to the recorder instead. */
  pauseShortcuts(paused: boolean) {
    this.shortcutsPaused = paused
    this.updateShortcuts()
    // ⌃1–9 follow the rows: rendering re-registers them (or not, while paused).
    this.lastSent = ""
    this.render()
  }

  private unregisterShortcuts() {
    for (const accel of this.registered) globalShortcut.unregister(accel)
    this.registered = []
    this.updateJumps(0)
  }

  /** Keeps ⌃1…⌃count registered (count = rows with a number), dropping the ones past it. */
  private updateJumps(count: number) {
    if (!this.enabled || this.shortcutsPaused) count = 0
    for (let n = this.jumpsRegistered; n > count; n--) globalShortcut.unregister(`Ctrl+${n}`)
    for (let n = this.jumpsRegistered + 1; n <= count; n++) {
      const accel = `Ctrl+${n}`
      try {
        if (!globalShortcut.register(accel, () => this.jump(n)))
          console.error(`[ctrl] companion: ${accel} is taken by another app`)
      } catch (e) {
        console.error(`[ctrl] companion: can't register ${accel}: ${e}`)
      }
    }
    this.jumpsRegistered = count
  }

  private jump(n: number) {
    const id = this.jumps[n - 1]
    if (id) this.host.open(id)
  }

  private hold(held: boolean) {
    const win = this.win
    if (win && !win.isDestroyed()) win.webContents.send("companion:hold", held)
  }

  /** Sessions or resources changed somewhere: refresh the list soon (coalesced). */
  changed() {
    if (!this.enabled || !this.context || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.render()
    }, 300)
  }

  dispose() {
    this.enabled = false
    this.unregisterShortcuts()
    this.stopProbe()
  }

  // ---------- native helper ----------

  private binary() {
    return app.isPackaged
      ? join(process.resourcesPath, "companion", "ctrl-context")
      : join(this.host.root, "dist", "companion", "ctrl-context")
  }

  private startProbe() {
    const bin = this.binary()
    if (!existsSync(bin)) return console.error(`[ctrl] companion: ${bin} is missing (npm run build)`)
    const child = spawn(bin, ["--self-pid", String(process.pid)], { stdio: ["pipe", "pipe", "inherit"] })
    this.probe = child
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let msg: ProbeMessage
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.type === "hold") return this.hold(msg.ctrl)
      if (msg.type === "permission") this.trusted = msg.trusted
      else this.context = msg
      this.render()
    })
    child.on("exit", (code) => {
      if (this.probe !== child) return
      this.probe = undefined
      if (!this.enabled || this.restarts >= 5) return
      console.error(`[ctrl] companion helper exited (${code}), restarting`)
      setTimeout(() => this.enabled && !this.probe && this.startProbe(), 1000 * 2 ** this.restarts++)
    })
  }

  private stopProbe() {
    const child = this.probe
    this.probe = undefined
    // Closing stdin tells it to exit; the kill covers a helper stuck in an AX call.
    child?.stdin?.end()
    child?.kill()
  }

  // ---------- matching ----------

  private compute(): CompanionView {
    const ctx = this.context
    const first = this.host.shortcuts()[0]
    const shortcut = first ? formatAccel(first) : ""
    if (!ctx) return { trusted: this.trusted, context: null, shortcut, groups: [] }
    const lookup = lookupFor(ctx.urls)
    const top = lookup.exact[0]
    const mentions = this.host.sessionsMentioning(lookup.exact, lookup.related)
    const byID = new Map(this.host.sessions().map((s) => [s.id, s]))
    const rows = new Map<string, CompanionSession>()
    for (const m of [...mentions.exact, ...mentions.related]) {
      const s = byID.get(m.session_id)
      if (!s || rows.has(s.id)) continue // newest first, and exact before related
      rows.set(s.id, {
        id: s.id,
        title: s.title,
        harness: s.harness,
        status: s.status,
        archived: this.host.isArchived(s.id),
        last: m.last,
        via: lookup.names.get(m.resource_id) ?? relatedName(m.resource_id),
        exact: m.resource_id === top,
      })
    }
    // Archived ones have their own budget: they're folded by default and shouldn't crowd out live ones.
    const sorted = [...rows.values()].sort((a, b) => Number(b.exact) - Number(a.exact) || b.last - a.last)
    const sessions = [
      ...sorted.filter((s) => !s.archived).slice(0, MAX_ROWS),
      ...sorted.filter((s) => s.archived).slice(0, MAX_ROWS),
    ]
    // Groups in order of their best session; Recents and Archived after the spaces, like the sidebar.
    const groups = new Map<string, CompanionGroup>()
    for (const s of sessions) {
      const space = s.archived ? undefined : this.host.spaceOf(s.id)
      const group: Omit<CompanionGroup, "sessions"> = s.archived
        ? { id: "archived", kind: "archived", name: "Archived" }
        : space
          ? { id: space.id, kind: "space", name: space.name }
          : { id: "recents", kind: "recents", name: "Recents" }
      if (!groups.has(group.id)) groups.set(group.id, { ...group, sessions: [] })
      groups.get(group.id)!.sessions.push(s)
    }
    const rank = { space: 0, recents: 1, archived: 2 }
    const sortedGroups = [...groups.values()].sort((a, b) => rank[a.kind] - rank[b.kind])
    // Numbered top to bottom as shown; archived ones are folded by default, so they get none.
    let n = 0
    for (const g of sortedGroups)
      for (const s of g.sessions) if (!s.archived && n < JUMPS) s.jump = ++n
    const resource = top && lookup.names.get(top)
    return {
      trusted: this.trusted,
      context: { app: ctx.app, label: ctx.label || resource || ctx.title || undefined, resource },
      shortcut,
      groups: sortedGroups,
    }
  }

  private render() {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const view = this.compute()
    const jumps: string[] = []
    for (const g of view.groups) for (const s of g.sessions) if (s.jump) jumps[s.jump - 1] = s.id
    this.jumps = jumps
    this.updateJumps(jumps.length)
    const json = JSON.stringify(view)
    if (json === this.lastSent) return
    this.lastSent = json
    win.webContents.send("companion:view", view)
  }

  // ---------- window ----------

  private createWindow() {
    const saved = this.loadPosition()
    const area = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      // An NSPanel that doesn't activate ctrl when clicked: the app you were in stays frontmost,
      // so its context stays on screen.
      type: "panel",
      width: WIDTH,
      height: 96,
      x: saved?.x ?? area.x + MARGIN,
      y: saved?.y ?? area.y + area.height - 96 - MARGIN,
      show: false,
      frame: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      alwaysOnTop: true,
      webPreferences: { preload: join(this.host.root, "dist", "companion-preload.cjs"), sandbox: false },
    })
    this.win = win
    win.setAlwaysOnTop(true, "floating")
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    win.webContents.on("will-navigate", (e) => e.preventDefault())
    win.on("moved", () => this.savePosition())
    const theme = () => win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG)
    nativeTheme.on("updated", theme)
    win.on("closed", () => nativeTheme.off("updated", theme))
    win.webContents.once("did-finish-load", () => {
      this.lastSent = ""
      this.render()
      win.showInactive()
    })
    const dev = process.env.VITE_DEV_URL
    if (dev) void win.loadURL(new URL("companion/index.html", dev).href)
    else void win.loadFile(join(this.host.root, "dist", "renderer", "companion", "index.html"))
  }

  /** Fits the content; a window in the lower half of its screen grows upward so it stays in its corner. */
  private resize(height: number) {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const h = Math.max(40, Math.min(600, Math.ceil(height)))
    const b = win.getBounds()
    if (b.height === h) return
    const area = screen.getDisplayMatching(b).workArea
    const anchorBottom = b.y + b.height / 2 > area.y + area.height / 2
    let y = anchorBottom ? b.y + b.height - h : b.y
    y = Math.max(area.y, Math.min(y, area.y + area.height - h))
    win.setBounds({ x: b.x, y, width: WIDTH, height: h })
  }

  private loadPosition(): Saved | undefined {
    try {
      const saved = JSON.parse(readFileSync(this.savedPath, "utf8")) as Saved
      // Forget positions on a screen that's gone.
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea
        return saved.x >= a.x && saved.x < a.x + a.width && saved.y >= a.y && saved.y < a.y + a.height
      })
      return visible ? saved : undefined
    } catch {
      return undefined
    }
  }

  private savePosition() {
    if (!this.win) return
    const { x, y } = this.win.getBounds()
    try {
      writeFileSync(this.savedPath, JSON.stringify({ x, y }))
    } catch {}
  }
}
