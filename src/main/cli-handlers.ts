import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { CliError, type CallerContext } from "../shared/cli/protocol"
import { describeType, formatModel, parseModel, SETTING_KEYS, type SettingType } from "../shared/cli/settings"
import { COMMANDS as APP_COMMANDS } from "../shared/shortcuts"
import {
  FONT_SIZE,
  STATUS_RANK,
  SYSTEM_SOUNDS,
  type AdapterInfo,
  type CliStatus,
  type FxCheck,
  type Harness,
  type McpServerItem,
  type ModelChoices,
  type ModelRef,
  type OpencodeCheck,
  type ResourceItem,
  type ResourceMeta,
  type SearchResult,
  type SessionItem,
  type SessionStatus,
  type Settings,
  type SkillStatus,
  type Space,
  type SpacePatch,
  type ThemeInfo,
  type UiState,
  type UpdateStatus,
} from "../shared/types"
import { parseResourceUrl, resourceType } from "../shared/adapters"
import type { RequestResult } from "./adapters/service"
import type { Handler } from "./cli-server"
import type { Store } from "./store"

/** What the CLI needs from main. main.ts implements it with the same functions the UI uses. */
export type CliHost = {
  store: Store
  version: string
  socket: string
  sessions(): SessionItem[]
  currentSessionID(): string | null
  /** Session an fx pty has right now */
  termSession(termID: string): string | null | undefined
  /** fx: ctrl runs a process for it */
  isLive(sessionID: string): boolean
  activeTermID(): string | null
  checks(): { opencode: OpencodeCheck; fx: FxCheck; update: UpdateStatus; cli: CliStatus; problem?: string }
  /** Creates a session. Returns its id, or for fx the terminal still waiting for one. */
  newSession(opts: {
    spaceID: string | null
    harness?: Harness
    directory?: string
    model?: ModelRef
    focus: boolean
    parentID?: string | null
  }): Promise<{ id: string } | { pending: true; terminal: string }>
  openSession(sessionID: string): void
  renameSession(sessionID: string, title: string): Promise<void>
  /** Moves it with the descendants that shared its space; returns those descendants. */
  move(sessionID: string, spaceID: string | null): string[]
  /** No toast: the CLI returns an undo command instead (principle 8) */
  archive(sessionIDs: string[]): void
  unarchive(sessionIDs: string[]): void
  /** No toast, like archive */
  deleteSpace(spaceID: string): void
  createSpace(name: string): string
  changed(): void
  /** opencode: through the service. fx: typed into its pty. */
  prompt(sessionID: string, text: string): Promise<void>
  /** fx: types text into a terminal whose session id isn't known yet, and submits it */
  promptTerminal(termID: string, text: string): Promise<void>
  /** Types text into a session's prompt without sending it. opencode: only the session on screen. */
  type(sessionID: string, text: string): Promise<void>
  stop(sessionID: string): Promise<boolean>
  setSettings(patch: Partial<Settings>): void
  setUi(patch: Partial<UiState>): void
  themes(): ThemeInfo
  adapters(): AdapterInfo[]
  toast(message: string, viewSessionID?: string): string
  window(action?: "show" | "hide" | "raise"): { visible: boolean; focused: boolean }
  renderer(event: "settings" | "palette", arg?: unknown): void
  home(prefill?: string): void
  search(query: string): SearchResult
  resources(sessionIDs: string[]): (ResourceItem & { meta?: ResourceMeta })[]
  resourcesByID(ids: string[]): (ResourceItem & { meta?: ResourceMeta })[]
  /** Fetches live details like the panel would (`force`: all of them), waiting at most `wait` ms */
  fetchResources(items: ResourceItem[], opts: { force: boolean; wait: number }): Promise<RequestResult>
  resourceMeta(item: { id: string; type: string }): ResourceMeta | undefined
  models(harness: Harness, directory?: string): Promise<ModelChoices>
  mcp(): McpServerItem[]
  reconnectMcp(name: string): Promise<void>
  skill(name: "read-session" | "ctrl", action?: "install" | "uninstall"): SkillStatus
  update(action: "check" | "install"): Promise<UpdateStatus>
  digestScript(): string
  nodeRunner(): { command: string; env: Record<string, string> }
  /** Called after every state change (coalesced). Returns an unsubscribe function. */
  onChange(cb: () => void): () => void
}

// ---------- helpers ----------

/** Most ms `session new` spends before replying: under the CLI's default --timeout (15s). */
export const SESSION_NEW_BUDGET = 12_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ensureString = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new CliError("USAGE", `${what} must be a string`)
  return value
}

/** Expands ~ and makes relative paths absolute against the caller's folder. */
const expandPath = (path: string, caller: CallerContext) => {
  const p = path.startsWith("~") ? homedir() + path.slice(1) : path
  return isAbsolute(p) ? p : resolve(caller.cwd || homedir(), p)
}

/** Quotes a value for the `undo` commands agents run in a POSIX shell. */
const sh = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

const folder = (path: string, caller: CallerContext) => {
  const abs = expandPath(path, caller)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new CliError("NOT_FOUND", `No folder at ${abs}`)
  return abs
}

export function createHandlers(host: CliHost, { sessionNewBudget = SESSION_NEW_BUDGET } = {}): Record<string, Handler> {
  const { store } = host

  const sessionView = (s: SessionItem) => ({
    id: s.id,
    harness: s.harness,
    title: s.title,
    directory: s.directory,
    spaceID: store.data.assignments[s.id] ?? null,
    archived: store.data.archived[s.id] ?? null,
    createdByAgent: store.data.createdByAgent[s.id] ?? null,
    parentID: store.data.parents[s.id] ?? null,
    children: childrenOf(s.id),
    status: s.status,
    ...(s.statusDetail ? { statusDetail: s.statusDetail } : {}),
    updated: s.updated,
    current: host.currentSessionID() === s.id,
    ...(s.harness === "fx" ? { live: host.isLive(s.id) } : {}),
    ...(s.elsewhere ? { elsewhere: true } : {}),
  })

  const spaceView = (space: Space) => {
    const inSpace = host.sessions().filter((s) => store.data.assignments[s.id] === space.id && !store.data.archived[s.id])
    const status = inSpace.reduce<SessionStatus>(
      (best, s) => (STATUS_RANK[s.status] > STATUS_RANK[best] ? s.status : best),
      "idle",
    )
    return {
      id: space.id,
      name: space.name,
      index: store.data.spaces.indexOf(space),
      collapsed: !!space.collapsed,
      directory: space.directory ?? null,
      harness: space.harness ?? null,
      model: formatModel(space.model),
      fxModel: formatModel(space.fxModel),
      modelEnabled: space.modelEnabled ?? true,
      instructions: space.instructions ?? null,
      ctrlInstructions: space.ctrlInstructions ?? null,
      sessions: inSpace.length,
      status,
    }
  }

  const byID = (id: string) => host.sessions().find((s) => s.id === id)

  // Only child sessions have an entry, so this stays small next to the session list.
  const childrenOf = (id: string) =>
    Object.entries(store.data.parents)
      .filter(([, parent]) => parent === id)
      .map(([child]) => child)

  /** The session the caller runs in, if ctrl knows it; undefined otherwise (no error). */
  const selfSession = (caller: CallerContext) => {
    try {
      return byID(selfID(caller))
    } catch {
      return undefined
    }
  }

  /** `none` = no parent. Refuses a parent that is the session itself or one of its children. */
  const resolveParent = (selector: unknown, caller: CallerContext, child?: string): SessionItem | null => {
    if (selector === "none") return null
    const parent = resolveSession(selector, caller)
    if (child && store.isAncestor(child, parent.id)) {
      throw new CliError("CONFLICT", parent.id === child ? "A session can't be its own parent" : `${parent.id} is a child of ${child}`, {
        hint: `Detach it first: ctrl session move ${parent.id} --parent none`,
      })
    }
    return parent
  }

  const selfID = (caller: CallerContext) => {
    const fromTerm = caller.termID ? host.termSession(caller.termID) : undefined
    const id = fromTerm ?? caller.sessionID ?? caller.opencodeSessionID
    if (!id) {
      throw new CliError("NO_SELF", "`self` only works inside a session ctrl runs", {
        hint: "Pass a session id instead (ctrl session list)",
      })
    }
    return id
  }

  /** Remembers that an agent created this session, and from which session when the caller runs in one. */
  const markCreatedByAgent = (sessionID: string, caller: CallerContext) => {
    if (!caller.agent) return
    let by: string | null = null
    try {
      by = selfID(caller)
    } catch {}
    store.setCreatedByAgent(sessionID, caller.agent, by)
    host.changed()
  }

  /** id, self, current or name:<title> → a session ctrl knows. */
  const resolveSession = (selector: unknown, caller: CallerContext): SessionItem => {
    const sel = ensureString(selector, "session").trim()
    let id: string
    if (sel === "self") id = selfID(caller)
    else if (sel === "current") {
      const current = host.currentSessionID()
      if (!current) throw new CliError("NOT_FOUND", "No session is on screen", { hint: "ctrl session focus <session>" })
      id = current
    } else if (sel.startsWith("name:")) {
      const name = sel.slice(5).trim().toLowerCase()
      const matches = host.sessions().filter((s) => s.title.trim().toLowerCase() === name)
      if (!matches.length) {
        throw new CliError("NOT_FOUND", `No session titled "${sel.slice(5)}"`, {
          hint: `ctrl session list --query ${JSON.stringify(sel.slice(5))}`,
        })
      }
      if (matches.length > 1) {
        throw new CliError("AMBIGUOUS", `${matches.length} sessions are titled "${sel.slice(5)}"`, {
          hint: "Pass an id instead",
          candidates: matches.slice(0, 20).map((s) => ({ id: s.id, title: s.title, updated: s.updated })),
        })
      }
      return matches[0]
    } else id = sel
    const found = byID(id)
    if (!found) {
      throw new CliError("NOT_FOUND", `No session ${id}`, {
        hint: id.startsWith("ses_") || id.startsWith("fx:") ? "ctrl session list --all" : "Session ids look like ses_… or fx:…",
      })
    }
    return found
  }

  const resolveSpace = (selector: unknown, caller: CallerContext): Space => {
    const sel = ensureString(selector, "space").trim()
    if (sel === "current") {
      const current = host.currentSessionID()
      const spaceID = current ? store.data.assignments[current] : undefined
      if (!spaceID) throw new CliError("NOT_FOUND", "The session on screen isn't in a space")
      return store.space(spaceID)!
    }
    if (sel === "self") {
      const spaceID = store.data.assignments[selfID(caller)]
      if (!spaceID) throw new CliError("NOT_FOUND", "This session isn't in a space")
      return store.space(spaceID)!
    }
    if (sel.startsWith("name:")) {
      const name = sel.slice(5).trim().toLowerCase()
      const matches = store.data.spaces.filter((s) => s.name.trim().toLowerCase() === name)
      if (!matches.length) throw new CliError("NOT_FOUND", `No space named "${sel.slice(5)}"`, { hint: "ctrl space list" })
      if (matches.length > 1) {
        throw new CliError("AMBIGUOUS", `${matches.length} spaces are named "${sel.slice(5)}"`, {
          hint: "Pass an id instead",
          candidates: matches.map((s) => ({ id: s.id, name: s.name })),
        })
      }
      return matches[0]
    }
    const space = store.space(sel)
    if (!space) {
      const byName = store.data.spaces.filter((s) => s.name.toLowerCase() === sel.toLowerCase())
      throw new CliError("NOT_FOUND", `No space ${sel}`, {
        hint: byName.length ? `To match by name, pass name:${sel}` : "ctrl space list",
      })
    }
    return space
  }

  /** `none` = no space. */
  const resolveTargetSpace = (selector: unknown, caller: CallerContext): string | null =>
    selector === "none" ? null : resolveSpace(selector, caller).id

  const parseModelArg = (value: string, harness: Harness): ModelRef => {
    const model = parseModel(value, harness)
    if (!model) {
      throw new CliError("USAGE", `Bad model ${JSON.stringify(value)}`, {
        hint: harness === "fx" ? "Format: <model>[#<effort>] (ctrl models list --harness fx)" : "Format: <provider>/<model>[#<variant>] (ctrl models list)",
      })
    }
    return model
  }

  const spacePatch = (args: Record<string, any>, caller: CallerContext): SpacePatch => {
    const patch: SpacePatch = {}
    if (args.directory !== undefined) patch.directory = args.directory === "" ? null : folder(args.directory, caller)
    if (args.harness !== undefined) patch.harness = args.harness === "default" ? null : args.harness
    if (args.model !== undefined) patch.model = args.model === "" ? null : parseModelArg(args.model, "opencode")
    if (args["fx-model"] !== undefined) patch.fxModel = args["fx-model"] === "" ? null : parseModelArg(args["fx-model"], "fx")
    if (args["model-enabled"] !== undefined) patch.modelEnabled = args["model-enabled"]
    if (args.instructions !== undefined) patch.instructions = args.instructions === "" ? null : args.instructions
    if (args["ctrl-instructions"] !== undefined)
      patch.ctrlInstructions = args["ctrl-instructions"] === "default" ? null : args["ctrl-instructions"] === "on"
    return patch
  }

  /** Commands that recreate a space as it is now, settings and sessions included (`space delete`'s undo). */
  const spaceUndo = (space: Space) => {
    const sel = `name:${space.name}`
    const flags = [
      `--index ${store.data.spaces.indexOf(space)}`,
      space.directory && `--directory ${sh(space.directory)}`,
      space.harness && `--harness ${space.harness}`,
      space.model && `--model ${sh(formatModel(space.model)!)}`,
      space.fxModel && `--fx-model ${sh(formatModel(space.fxModel)!)}`,
      space.modelEnabled === false && "--no-model-enabled",
      space.instructions && `--instructions ${sh(space.instructions)}`,
      space.ctrlInstructions !== undefined && `--ctrl-instructions ${space.ctrlInstructions ? "on" : "off"}`,
    ].filter(Boolean)
    const moves = Object.entries(store.data.assignments)
      .filter(([, spaceID]) => spaceID === space.id)
      .map(([sessionID]) => `ctrl session move ${sessionID} --space ${sh(sel)}`)
    // Moving unarchives, so archived sessions get archived again.
    const archived = Object.entries(store.data.assignments)
      .filter(([sessionID, spaceID]) => spaceID === space.id && store.data.archived[sessionID])
      .map(([sessionID]) => sessionID)
    return [
      `ctrl space create ${sh(space.name)} ${flags.join(" ")}`,
      ...moves,
      ...(archived.length ? [`ctrl session archive ${archived.join(" ")}`] : []),
    ].join(" && ")
  }

  const page = <T>(items: T[], args: Record<string, any>) => {
    const limit = Math.max(1, Math.min(500, Number(args.limit ?? 50)))
    let offset = 0
    if (args.cursor !== undefined) {
      const m = /^c(\d+)$/.exec(String(args.cursor))
      if (!m) throw new CliError("USAGE", "Bad --cursor (pass `next` from the previous page)")
      offset = Number(m[1])
    }
    const slice = items.slice(offset, offset + limit)
    return { items: slice, next: offset + limit < items.length ? `c${offset + limit}` : null, total: items.length }
  }

  // ---------- waiting ----------

  /** Resolves with the first truthy value of `check`, re-evaluated on every state change. */
  const waitFor = <T>(check: () => T | undefined | false, timeout: number, what: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const first = check()
      if (first) return resolve(first)
      let timer: ReturnType<typeof setTimeout> | undefined
      const off = host.onChange(() => {
        const value = check()
        if (!value) return
        off()
        clearTimeout(timer)
        resolve(value)
      })
      timer = setTimeout(() => {
        off()
        reject(new CliError("TIMEOUT", `Timed out after ${timeout}ms waiting for ${what}`))
      }, timeout)
    })

  /** Rejects with TIMEOUT when `work` (a harness call) takes longer than `ms`, instead of hanging the reply. */
  const bounded = <T>(work: Promise<T>, ms: number, what: string, hint?: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CliError("TIMEOUT", `Timed out after ${ms}ms waiting for ${what}`, hint ? { hint } : {})),
        ms,
      )
    })
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
  }

  /**
   * After sending a prompt, wait (briefly) until the turn shows as started, so `send` then
   * `wait --for done` can't see the idle state from before the prompt.
   */
  const started = (id: string, before: number, max = 5000) =>
    waitFor(
      () => {
        const s = byID(id)
        return s && (s.status === "running" || s.status === "needs-input" || s.status === "failed" || s.updated > before)
      },
      max,
      "the turn to start",
    ).catch(() => undefined)

  const WAIT_STATES: Record<string, SessionStatus[]> = {
    done: ["idle", "unread", "failed", "needs-input"],
    idle: ["idle", "unread"],
    "needs-input": ["needs-input"],
    running: ["running"],
    failed: ["failed"],
  }

  // ---------- settings ----------

  const expandedKeys = () => {
    const keys: { key: string; type: SettingType; description: string; path: [keyof Settings, string?] }[] = []
    for (const k of SETTING_KEYS) {
      const [root, sub] = k.key.split(".") as [keyof Settings, string?]
      if (!sub) keys.push({ ...k, path: [root] })
      else {
        const items =
          root === "soundChoices"
            ? ["needs-input", "failed", "finished"]
            : root === "shortcuts"
              ? APP_COMMANDS.map((c) => c.id)
              : host.adapters().map((a) => a.id)
        for (const item of items) keys.push({ key: `${root}.${item}`, type: k.type, description: k.description, path: [root, item] })
      }
    }
    return keys
  }

  const findKey = (key: string) => {
    const k = expandedKeys().find((k) => k.key === key)
    if (!k) {
      const near = expandedKeys().filter((x) => x.key.toLowerCase().includes(key.toLowerCase().split(".")[0]))
      throw new CliError("NOT_FOUND", `No setting ${key}`, {
        hint: "ctrl settings list",
        ...(near.length ? { candidates: near.slice(0, 20).map((n) => n.key) } : {}),
      })
    }
    return k
  }

  const readSetting = (k: ReturnType<typeof findKey>) => {
    const [root, sub] = k.path
    const s = store.data.settings
    if (root === "shortcuts") return s.shortcuts[sub as keyof Settings["shortcuts"]] ?? APP_COMMANDS.find((c) => c.id === sub)!.defaults
    if (root === "adapterModes") return host.adapters().find((a) => a.id === sub)?.mode ?? null
    const value = sub ? (s[root] as Record<string, unknown>)[sub] : s[root]
    if (k.type.kind === "model") return formatModel(value as ModelRef | null)
    return value ?? null
  }

  const parseValue = (raw: unknown, key: string, type: SettingType, caller: CallerContext): unknown => {
    let value: unknown = raw
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
    }
    const bad = (expected: string) =>
      new CliError("USAGE", `${key} must be ${expected}, got ${JSON.stringify(value)}`)
    switch (type.kind) {
      case "enum":
        if (typeof value !== "string" || !type.values.includes(value)) throw bad(describeType(type))
        return value
      case "bool":
        if (typeof value !== "boolean") throw bad("true or false")
        return value
      case "int":
        if (typeof value !== "number" || !Number.isInteger(value) || value < type.min || value > type.max)
          throw bad(describeType(type))
        return value
      case "string": {
        if (value === null || value === "") return null
        if (typeof value !== "string") throw bad("a string or null")
        if (key === "tuiTheme") {
          const themes = host.themes()
          if (![...themes.builtin, ...themes.custom].includes(value))
            throw new CliError("USAGE", `No opencode theme named ${value}`, { hint: "ctrl settings list (see tuiTheme values)" })
        }
        return value
      }
      case "folder":
        if (value === null || value === "") return null
        if (typeof value !== "string") throw bad(describeType(type))
        return folder(value, caller)
      case "model": {
        if (value === null || value === "") return null
        if (typeof value === "string") return parseModelArg(value, type.harness)
        const m = value as ModelRef
        if (!m || typeof m !== "object" || typeof m.providerID !== "string" || typeof m.id !== "string")
          throw bad(describeType(type))
        return { providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) }
      }
      case "sound":
        if (value === null) return null
        if (typeof value !== "string") throw bad(describeType(type))
        if (value.startsWith("/")) {
          if (!existsSync(value)) throw new CliError("NOT_FOUND", `No file at ${value}`)
          return value
        }
        if (!SYSTEM_SOUNDS.includes(value))
          throw new CliError("USAGE", `${value} isn't a macOS sound`, { candidates: SYSTEM_SOUNDS })
        return value
      case "accelerators":
        if (value === null) return null
        if (typeof value === "string") return [value]
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw bad("a list of accelerators")
        return value
    }
  }

  const writeSetting = (k: ReturnType<typeof findKey>, value: unknown) => {
    const [root, sub] = k.path
    const s = store.data.settings
    if (root === "shortcuts") {
      const next = { ...s.shortcuts }
      if (value === null) delete next[sub as keyof typeof next]
      else next[sub as keyof typeof next] = value as string[]
      return host.setSettings({ shortcuts: next })
    }
    if (root === "adapterModes") {
      const adapter = host.adapters().find((a) => a.id === sub)
      if (value === "live" && !adapter?.cli) throw new CliError("UNSUPPORTED_HARNESS", `${sub} has no live details, only links`)
      return host.setSettings({ adapterModes: { ...s.adapterModes, [sub!]: value as "off" | "links" | "live" } })
    }
    if (sub) return host.setSettings({ [root]: { ...(s[root] as object), [sub]: value } } as Partial<Settings>)
    host.setSettings({ [root]: value } as Partial<Settings>)
  }

  const DEFAULTS: Partial<Record<string, unknown>> = {
    appearance: "system",
    tuiTheme: null,
    fontSize: FONT_SIZE.default,
    defaultHarness: "opencode",
    defaultDirectory: null,
    defaultModelEnabled: false,
    defaultModel: null,
    defaultFxModel: null,
    ctrlInstructions: true,
    dockBadge: true,
    notifications: true,
    sounds: true,
    soundsWhenFocused: false,
    "soundChoices.needs-input": "Glass",
    "soundChoices.failed": "Basso",
    "soundChoices.finished": "Hero",
  }
  const defaultOf = (key: string) => {
    if (key.startsWith("shortcuts.")) return APP_COMMANDS.find((c) => c.id === key.slice(10))?.defaults ?? null
    if (key.startsWith("adapterModes.")) return null
    return DEFAULTS[key] ?? null
  }

  // ---------- typing into terminals ----------

  /** opencode can only be typed into while the session is on screen. */
  const typeable = async (s: SessionItem, focus: boolean) => {
    if (s.harness === "fx") {
      if (s.elsewhere)
        throw new CliError("CONFLICT", `${s.id} is open in fx in another terminal`, { hint: "Quit fx there first" })
      if (focus) host.openSession(s.id)
      return
    }
    if (host.currentSessionID() === s.id) return
    if (!focus) {
      throw new CliError("CONFLICT", `${s.id} isn't on screen, and opencode has one TUI to type into`, {
        hint: "Add --focus to put it on screen first, or --submit to send through the service",
      })
    }
    host.openSession(s.id)
    await waitFor(() => host.currentSessionID() === s.id, 5000, "the session to be on screen")
    // The TUI swaps screens right after reporting the route; let the prompt mount.
    await sleep(300)
  }

  const refString = (s: SessionItem, target: Harness) => {
    const title = s.title.replace(/[[\]()\n\r]/g, " ").replace(/\s+/g, " ").trim()
    return `${target === "fx" ? "" : "@"}session[${title}](${s.id})`
  }

  // ---------- resources ----------

  const sessionMap = () => new Map(host.sessions().map((s) => [s.id, s]))
  const limitArg = (value: unknown) => Math.max(1, Math.min(500, Number(value ?? 100)))
  const waitArg = (value: unknown, fallback: number) => Math.max(0, Math.min(60_000, Number(value ?? fallback)))

  /** `--session` / `--space` / `--type` / `--limit`, as the panel scopes them: newest mention first. */
  const scopedResources = (args: Record<string, any>, caller: CallerContext) => {
    let ids: string[]
    if (args.space !== undefined) {
      const spaceID = resolveSpace(args.space, caller).id
      ids = host.sessions().filter((s) => store.data.assignments[s.id] === spaceID).map((s) => s.id)
    } else ids = ((args.session as string[] | undefined) ?? ["current"]).map((sel) => resolveSession(sel, caller).id)
    let items = host.resources(ids)
    // A session never lists itself as a reference, like the panel.
    if (ids.length === 1) items = items.filter((r) => r.type !== "session" || r.data.id !== ids[0])
    if (args.type?.length) items = items.filter((r) => args.type.includes(r.type))
    return items.slice(0, limitArg(args.limit))
  }

  const resourceView = (r: ResourceItem & { meta?: ResourceMeta }, sessions: Map<string, SessionItem>, pending = false) => {
    const offline = resourceType(r.type)?.describe(r.data)
    const subtitle = r.meta?.subtitle ?? offline?.subtitle
    // Referenced sessions: their current state from the session list, null once deleted.
    const ref = r.type === "session" ? sessions.get(r.data.id) : undefined
    return {
      id: r.id,
      type: r.type,
      url: r.url,
      title: ref?.title ?? r.meta?.title ?? offline?.title ?? r.url,
      ...(r.type === "session" ? { session: ref ? sessionView(ref) : null } : {}),
      ...(subtitle ? { subtitle } : {}),
      mentions: r.mentions,
      sessions: r.sessions,
      first: r.first,
      last: r.last,
      sharedByYou: r.sharedByYou,
      data: r.data,
      ...(r.meta ? { live: r.meta } : {}),
      ...(pending ? { pending: true } : {}),
    }
  }

  /** Fetches the page's live details (the panel's cache policy, or all with `force`), then answers with them. */
  const fetchedResources = async (items: ResourceItem[], opts: { force: boolean; wait: number }) => {
    const result = await host.fetchResources(items, opts)
    const pending = new Set(result.pending)
    const sessions = sessionMap()
    return {
      items: items.map((r) => resourceView({ ...r, meta: host.resourceMeta(r) }, sessions, pending.has(r.id))),
      errors: result.errors,
    }
  }

  // ---------- handlers ----------

  const handlers: Record<string, Handler> = {
    "app status": () => {
      const checks = host.checks()
      return {
        version: host.version,
        socket: host.socket,
        opencode: checks.opencode,
        fx: checks.fx,
        skill: host.skill("read-session"),
        cliSkill: host.skill("ctrl"),
        cli: checks.cli,
        update: checks.update,
        window: host.window(),
        ...(checks.problem ? { problem: checks.problem } : {}),
      }
    },
    "app update check": () => host.update("check"),
    "app update install": () => host.update("install"),

    // ----- sessions -----
    "session list": (args, req) => {
      let list = host.sessions()
      if (args.archived) list = list.filter((s) => store.data.archived[s.id])
      else if (!args.all) list = list.filter((s) => !store.data.archived[s.id])
      if (args.space !== undefined) {
        const target = resolveTargetSpace(args.space, req.caller)
        list = list.filter((s) => (store.data.assignments[s.id] ?? null) === target)
      }
      if (args.status?.length) list = list.filter((s) => args.status.includes(s.status))
      if (args.harness) list = list.filter((s) => s.harness === args.harness)
      if (args.query) {
        const q = String(args.query).toLowerCase()
        list = list.filter((s) => s.title.toLowerCase().includes(q))
      }
      if (args.directory) {
        const dir = expandPath(args.directory, req.caller).replace(/\/$/, "")
        list = list.filter((s) => s.directory.replace(/\/$/, "") === dir)
      }
      if (args.parent !== undefined) {
        const parent = resolveSession(args.parent, req.caller)
        list = list.filter((s) => store.data.parents[s.id] === parent.id)
      }
      if (args.archived) list = [...list].sort((a, b) => store.data.archived[b.id] - store.data.archived[a.id])
      const p = page(list, args)
      return { ...p, items: p.items.map(sessionView) }
    },
    "session get": (args, req) => sessionView(resolveSession(args.session, req.caller)),
    "session new": async (args, req) => {
      // Everything below shares one budget that ends before the CLI's default --timeout (15s), so the
      // agent always gets a reply that says what happened, never a silent wait.
      const deadline = Date.now() + sessionNewBudget
      const left = () => Math.max(250, deadline - Date.now())
      // From a session, new sessions are its children unless --parent says otherwise.
      const parent = args.parent !== undefined ? resolveParent(args.parent, req.caller) : (selfSession(req.caller) ?? null)
      // Without --space, a child starts like the sidebar's New child session: the parent's space, folder and harness.
      const fromParent = parent && args.space === undefined ? parent : undefined
      const spaceID =
        args.space !== undefined ? resolveTargetSpace(args.space, req.caller) : fromParent ? (store.data.assignments[fromParent.id] ?? null) : null
      const space = spaceID ? store.space(spaceID) : undefined
      const harness: Harness | undefined = args.harness ?? fromParent?.harness
      const directory = args.directory ? folder(args.directory, req.caller) : fromParent?.directory
      const model = args.model ? parseModelArg(args.model, harness ?? space?.harness ?? store.data.settings.defaultHarness) : undefined
      const created = await bounded(
        host.newSession({ spaceID, harness, directory, model, focus: !!args.focus, parentID: parent?.id ?? null }),
        left(),
        "the harness to create the session",
        "Check the harness: ctrl app status. The session may still show up: ctrl session list --limit 5",
      )
      if (args.focus && args.raise) host.window("raise")
      const unsent = (id: string) =>
        args.prompt ? `${id} was created, the prompt may not have been sent: ctrl session read ${id}, then ctrl session send ${id} --text -` : undefined
      if ("pending" in created) {
        const sentAt = Date.now()
        if (args.prompt) {
          await bounded(host.promptTerminal(created.terminal, args.prompt), left(), "fx to take the prompt", "ctrl session list --harness fx --limit 5")
        }
        // fx reports the id once its process is up (and, for some versions, after the first prompt).
        const id = await waitFor(() => host.termSession(created.terminal) ?? undefined, left(), "fx to report the new session's id").catch(
          () => undefined,
        )
        if (!id) return created
        markCreatedByAgent(id, req.caller)
        if (args.title) await bounded(host.renameSession(id, args.title), left(), "the rename", `ctrl session rename ${id} <title>`)
        const s = await waitFor(() => byID(id), left(), "the session to show up").catch(() => undefined)
        if (s && args.prompt) await started(id, sentAt, Math.min(5000, left()))
        return s ? sessionView(byID(id) ?? s) : { id, pending: true }
      }
      markCreatedByAgent(created.id, req.caller)
      if (args.title) {
        await bounded(host.renameSession(created.id, args.title), left(), "the rename", unsent(created.id) ?? `ctrl session rename ${created.id} <title>`)
      }
      const s = await waitFor(() => byID(created.id), left(), "the session to show up")
      if (args.prompt) {
        await bounded(host.prompt(created.id, args.prompt), left(), "the prompt to be sent", unsent(created.id))
        await started(created.id, s.updated, Math.min(5000, left()))
      }
      return sessionView(byID(created.id) ?? s)
    },
    "session focus": async (args, req) => {
      const s = resolveSession(args.session, req.caller)
      if (s.elsewhere) throw new CliError("CONFLICT", `${s.id} is open in fx in another terminal`, { hint: "Quit fx there first" })
      if (store.data.archived[s.id]) host.unarchive([s.id])
      host.openSession(s.id)
      if (args.raise) host.window("raise")
      await waitFor(() => host.currentSessionID() === s.id, 5000, "the session to be on screen").catch(() => undefined)
      return sessionView(byID(s.id) ?? s)
    },
    "session rename": async (args, req) => {
      const s = resolveSession(args.session, req.caller)
      const title = String(args.title).trim()
      if (!title) throw new CliError("USAGE", "Title can't be empty")
      const changed = s.title !== title
      if (changed) await host.renameSession(s.id, title)
      const pending = s.harness === "fx" && !!store.data.titles[s.id]
      return { ...sessionView(byID(s.id) ?? s), title, changed, ...(pending ? { pending } : {}) }
    },
    "session move": (args, req) => {
      const s = resolveSession(args.session, req.caller)
      if (args.space === undefined && args.parent === undefined) {
        throw new CliError("USAGE", "Pass --space, --parent or both", { hint: `ctrl session move ${s.id} --space <space>` })
      }
      const parent = args.parent !== undefined ? resolveParent(args.parent, req.caller, s.id) : undefined
      let parentChanged = false
      if (parent !== undefined) {
        parentChanged = (store.data.parents[s.id] ?? null) !== (parent?.id ?? null)
        if (parentChanged) {
          store.setParent(s.id, parent?.id ?? null)
          host.changed()
        }
      }
      // A session moved under a parent joins the parent's space, unless --space says otherwise.
      const target =
        args.space !== undefined
          ? resolveTargetSpace(args.space, req.caller)
          : parent
            ? (store.data.assignments[parent.id] ?? null)
            : (store.data.assignments[s.id] ?? null)
      const spaceChanged = (store.data.assignments[s.id] ?? null) !== target || !!store.data.archived[s.id]
      const followed = spaceChanged ? host.move(s.id, target) : []
      return {
        ...sessionView(byID(s.id) ?? s),
        changed: spaceChanged || parentChanged,
        ...(followed.length ? { followed } : {}),
      }
    },
    "session archive": (args, req) => {
      const ids = [...new Set((args.session as string[]).map((sel) => resolveSession(sel, req.caller).id))]
      const todo = ids.filter((id) => !store.data.archived[id])
      if (todo.length) host.archive(todo)
      return { archived: ids, changed: todo.length > 0, ...(todo.length ? { undo: `ctrl session unarchive ${todo.join(" ")}` } : {}) }
    },
    "session unarchive": (args, req) => {
      const ids = [...new Set((args.session as string[]).map((sel) => resolveSession(sel, req.caller).id))]
      const todo = ids.filter((id) => store.data.archived[id])
      if (todo.length) host.unarchive(todo)
      return { unarchived: ids, changed: todo.length > 0 }
    },
    "session send": async (args, req) => {
      const s = resolveSession(args.session, req.caller)
      const text = String(args.text)
      if (!text.trim()) throw new CliError("USAGE", "--text can't be empty")
      if (args.submit === false) {
        await typeable(s, !!args.focus)
        await host.type(s.id, text)
        return { id: s.id, submitted: false }
      }
      if (s.elsewhere) throw new CliError("CONFLICT", `${s.id} is open in fx in another terminal`, { hint: "Quit fx there first" })
      if (args.focus) host.openSession(s.id)
      await host.prompt(s.id, text)
      await started(s.id, s.updated)
      return { id: s.id, submitted: true }
    },
    "session wait": async (args, req) => {
      const s = resolveSession(args.session, req.caller)
      const want = WAIT_STATES[args.for ?? "done"]
      const done = await waitFor(
        () => {
          const now = byID(s.id)
          if (!now) throw new CliError("NOT_FOUND", `${s.id} was deleted`)
          return want.includes(now.status) ? now : undefined
        },
        Number(args.timeout ?? 600000),
        `${s.id} to be ${args.for ?? "done"}`,
      )
      return sessionView(done)
    },
    "session ref": (args, req) => {
      const s = resolveSession(args.session, req.caller)
      return { ref: refString(s, args.for ?? "opencode"), id: s.id, title: s.title }
    },
    "session reference": async (args, req) => {
      const source = resolveSession(args.source, req.caller)
      const into = resolveSession(args.into ?? "current", req.caller)
      const ref = refString(source, into.harness)
      const text = args.text ? `${ref} ${args.text}` : `${ref} `
      if (args.submit) {
        if (args.focus) host.openSession(into.id)
        await host.prompt(into.id, text.trim())
        await started(into.id, into.updated)
        return { into: into.id, ref, submitted: true }
      }
      await typeable(into, !!args.focus)
      await host.type(into.id, text)
      return { into: into.id, ref, submitted: false }
    },
    "session read": async (args, req) => {
      const s = resolveSession(args.session, req.caller)
      const runner = host.nodeRunner()
      const argv = [host.digestScript(), s.id, ...(args.turn !== undefined ? ["--turn", String(args.turn)] : [])]
      const digest = await new Promise<string>((resolve, reject) =>
        execFile(
          runner.command,
          argv,
          { env: { ...process.env, ...runner.env }, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout, stderr) => (err ? reject(new CliError("INTERNAL", `digest failed: ${stderr || err.message}`)) : resolve(stdout)),
        ),
      )
      return { id: s.id, digest }
    },
    "session stop": async (args, req) => {
      const s = resolveSession(args.session, req.caller)
      if (s.harness === "fx" && !host.isLive(s.id))
        throw new CliError("UNSUPPORTED_HARNESS", "fx sessions can only be stopped while open in ctrl")
      return { id: s.id, stopped: await host.stop(s.id) }
    },

    // ----- spaces -----
    "space list": () => ({ items: store.data.spaces.map(spaceView) }),
    "space get": (args, req) => {
      const space = resolveSpace(args.space, req.caller)
      const view = spaceView(space)
      if (!args.sessions) return view
      const items = host
        .sessions()
        .filter((s) => store.data.assignments[s.id] === space.id && !store.data.archived[s.id])
        .map(sessionView)
      return { ...view, items }
    },
    "space create": (args, req) => {
      const name = String(args.name).trim()
      if (!name) throw new CliError("USAGE", "Name can't be empty")
      const patch = spacePatch(args, req.caller)
      const id = host.createSpace(name)
      store.patchSpace(id, patch)
      if (args.index !== undefined) store.moveSpace(id, args.index)
      host.changed()
      return spaceView(store.space(id)!)
    },
    "space rename": (args, req) => {
      const space = resolveSpace(args.space, req.caller)
      const name = String(args.name).trim()
      if (!name) throw new CliError("USAGE", "Name can't be empty")
      const changed = space.name !== name
      if (changed) {
        store.updateSpace(space.id, { name })
        host.changed()
      }
      return { ...spaceView(space), changed }
    },
    "space set": (args, req) => {
      const space = resolveSpace(args.space, req.caller)
      const patch = spacePatch(args, req.caller)
      if (!Object.keys(patch).length) throw new CliError("USAGE", "Nothing to set", { hint: "Pass at least one of --directory, --harness, --model, --fx-model, --model-enabled, --instructions, --ctrl-instructions" })
      const before = JSON.stringify(space)
      store.patchSpace(space.id, patch)
      const changed = JSON.stringify(space) !== before
      if (changed) host.changed()
      return { ...spaceView(space), changed }
    },
    "space move": (args, req) => {
      const space = resolveSpace(args.space, req.caller)
      const before = store.data.spaces.indexOf(space)
      store.moveSpace(space.id, args.index)
      const changed = store.data.spaces.indexOf(space) !== before
      if (changed) host.changed()
      return { ...spaceView(space), changed }
    },
    "space fold": (args, req) => {
      const space = resolveSpace(args.space, req.caller)
      const changed = !space.collapsed
      if (changed) (store.updateSpace(space.id, { collapsed: true }), host.changed())
      return { ...spaceView(space), changed }
    },
    "space unfold": (args, req) => {
      const space = resolveSpace(args.space, req.caller)
      const changed = !!space.collapsed
      if (changed) (store.updateSpace(space.id, { collapsed: false }), host.changed())
      return { ...spaceView(space), changed }
    },
    "space archive-all": (args, req) => {
      const space = resolveSpace(args.space, req.caller)
      const ids = host
        .sessions()
        .filter((s) => store.data.assignments[s.id] === space.id && !store.data.archived[s.id])
        .map((s) => s.id)
      if (ids.length) host.archive(ids)
      return { archived: ids, ...(ids.length ? { undo: `ctrl session unarchive ${ids.join(" ")}` } : {}) }
    },
    "space delete": (args) => {
      const id = String(args.id)
      const space = store.space(id)
      if (!space) throw new CliError("NOT_FOUND", `No space ${id}`, { hint: "Deletes take an exact id (ctrl space list)" })
      const undo = spaceUndo(space)
      host.deleteSpace(id)
      return { id, undo }
    },

    // ----- settings -----
    "settings list": () => {
      const themes = host.themes()
      return {
        items: expandedKeys().map((k) => ({
          key: k.key,
          type: describeType(k.type),
          ...(k.type.kind === "enum" ? { values: k.type.values } : {}),
          ...(k.key === "tuiTheme" ? { values: [...themes.builtin, ...themes.custom] } : {}),
          ...(k.type.kind === "sound" ? { values: SYSTEM_SOUNDS } : {}),
          default: defaultOf(k.key),
          value: readSetting(k),
          description: k.description,
        })),
      }
    },
    "settings get": (args) => {
      const k = findKey(String(args.key))
      return { key: k.key, value: readSetting(k) }
    },
    "settings set": (args, req) => {
      const k = findKey(String(args.key))
      const value = parseValue(args.value, k.key, k.type, req.caller)
      const before = JSON.stringify(readSetting(k))
      writeSetting(k, value)
      const after = readSetting(k)
      return { key: k.key, value: after, changed: JSON.stringify(after) !== before }
    },
    "settings reset": (args) => {
      const k = findKey(String(args.key))
      const before = JSON.stringify(readSetting(k))
      const def = defaultOf(k.key)
      const value = k.key.startsWith("shortcuts.")
        ? null
        : k.key.startsWith("adapterModes.")
          ? (host.adapters().find((a) => a.id === k.path[1])?.cli ? "live" : "links")
          : k.type.kind === "model"
            ? null
            : def
      writeSetting(k, value)
      const after = readSetting(k)
      return { key: k.key, value: after, changed: JSON.stringify(after) !== before }
    },

    // ----- ui -----
    "ui get": () => {
      const ui = store.data.ui
      return {
        currentSessionID: host.currentSessionID(),
        activeTerminal: host.activeTermID(),
        sidebarWidth: ui.sidebarWidth,
        resources: { open: ui.resourcesOpen, collapsed: ui.resourcesCollapsed, scope: ui.resourcesScope, width: ui.resourcesWidth },
        recentsCollapsed: ui.recentsCollapsed,
        archivedCollapsed: ui.archivedCollapsed,
        window: host.window(),
      }
    },
    "ui home": (args) => {
      if (host.checks().opencode.state !== "ok")
        throw new CliError("HARNESS_MISSING", "opencode isn't installed", { hint: "curl -fsSL https://opencode.ai/v2/install | bash" })
      host.home(args.prefill)
      return {}
    },
    "ui window": (args) => host.window(args.action),
    "ui resources": (args) => {
      const ui = store.data.ui
      const fold = args.action === "fold" || args.action === "unfold"
      const open = fold ? ui.resourcesOpen : args.action === "toggle" ? !ui.resourcesOpen : args.action === "open"
      const collapsed = fold ? args.action === "fold" : ui.resourcesCollapsed
      host.setUi({ resourcesOpen: open, resourcesCollapsed: collapsed, ...(args.scope ? { resourcesScope: args.scope } : {}) })
      return { open, collapsed, scope: store.data.ui.resourcesScope }
    },
    "ui sidebar": (args) => {
      const width = Math.max(200, Math.min(520, Number(args.width)))
      host.setUi({ sidebarWidth: width })
      return { width }
    },
    "ui section": (args) => {
      const collapsed = args.action === "fold"
      host.setUi(args.section === "recents" ? { recentsCollapsed: collapsed } : { archivedCollapsed: collapsed })
      return { section: args.section, collapsed }
    },
    "ui settings": (args) => {
      const open = (args.action ?? "open") === "open"
      host.renderer("settings", open)
      return { open }
    },
    "ui palette": (args) => {
      host.renderer("palette", args.query ?? "")
      return {}
    },
    "ui toast": (args, req) => {
      const view = args.view ? resolveSession(args.view, req.caller).id : undefined
      return { id: host.toast(String(args.message), view) }
    },

    // ----- search, resources, models -----
    search: (args) => {
      const query = (args.query as string[]).join(" ").trim()
      if (!query) throw new CliError("USAGE", "Empty query")
      const limit = Math.max(1, Math.min(100, Number(args.limit ?? 20)))
      const visible = (id: string) => args.archived || !store.data.archived[id]
      const words = query.toLowerCase().split(/\s+/)
      const titles = host
        .sessions()
        .filter((s) => visible(s.id) && words.every((w) => s.title.toLowerCase().includes(w)))
        .slice(0, limit)
        .map(sessionView)
      const result = host.search(query)
      const hits = result.hits
        .filter((h) => visible(h.sessionID))
        .slice(0, limit)
        .map((h) => ({
          sessionID: h.sessionID,
          title: byID(h.sessionID)?.title ?? h.title,
          role: h.role,
          created: h.created,
          snippet: h.snippet.replaceAll("\uE000", "«").replaceAll("\uE001", "»"),
        }))
      return { titles, hits, index: result.status }
    },
    "resources list": async (args, req) => {
      const items = scopedResources(args, req.caller)
      if (args.cached) {
        const sessions = sessionMap()
        return { items: items.map((r) => resourceView(r, sessions)), errors: [] }
      }
      return fetchedResources(items, { force: false, wait: waitArg(args.wait, 5000) })
    },
    "resources refresh": async (args, req) => {
      const sels = (args.resource as string[] | undefined) ?? []
      let items: ResourceItem[]
      if (sels.length) {
        if (args.session !== undefined || args.space !== undefined)
          throw new CliError("USAGE", "Pass resource ids, or --session / --space, not both")
        // Canonical ids as `resources list` returns them, or any URL of the resource.
        const ids = [...new Set(sels.map((s) => parseResourceUrl(s)?.key ?? s))]
        const found = host.resourcesByID(ids)
        const unknown = ids.filter((id) => !found.some((r) => r.id === id))
        if (unknown.length)
          throw new CliError("NOT_FOUND", `No resource ${unknown.join(", ")} in ctrl's sessions`, {
            hint: "ctrl resources list --space <space> shows resource ids",
          })
        items = found
        if (args.type?.length) items = items.filter((r) => args.type.includes(r.type))
        items = items.slice(0, limitArg(args.limit))
      } else items = scopedResources(args, req.caller)
      return fetchedResources(items, { force: true, wait: waitArg(args.wait, 10000) })
    },
    "models list": async (args, req) => {
      const harness: Harness = args.harness ?? "opencode"
      const checks = host.checks()
      if ((harness === "fx" ? checks.fx.state : checks.opencode.state) !== "ok")
        throw new CliError("HARNESS_MISSING", `${harness} isn't installed`)
      const dir = args.directory ? folder(args.directory, req.caller) : undefined
      const choices = await host.models(harness, dir)
      const q = args.query ? String(args.query).toLowerCase() : ""
      return {
        items: choices.models
          .filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
          .map((m) => ({
            ref: formatModel({ providerID: m.providerID, id: m.id }),
            providerID: m.providerID,
            id: m.id,
            name: m.name,
            providerName: m.providerName,
            variants: m.variants,
          })),
      }
    },

    // ----- mcp, skill -----
    "mcp list": () => ({ items: host.mcp() }),
    "mcp reconnect": async (args) => {
      const name = String(args.name)
      if (!host.mcp().some((s) => s.name === name))
        throw new CliError("NOT_FOUND", `No MCP server ${name}`, { candidates: host.mcp().map((s) => s.name) })
      await host.reconnectMcp(name)
      return { name }
    },
    "skill status": () => ({
      items: (["read-session", "ctrl"] as const).map((name) => ({ name, ...host.skill(name) })),
    }),
    "skill install": (args) => {
      const name = args.name as "read-session" | "ctrl"
      if (host.skill(name).state === "external")
        throw new CliError("CONFLICT", `A ${name} skill ctrl doesn't manage is installed; leaving it alone`)
      return { name, ...host.skill(name, "install") }
    },
    "skill uninstall": (args) => {
      const name = args.name as "read-session" | "ctrl"
      return { name, ...host.skill(name, "uninstall") }
    },

    // ----- events -----
    events: async (args, req, stream) => {
      const types: string[] | undefined = args.type?.length ? args.type : undefined
      const only = args.session?.length ? new Set((args.session as string[]).map((s) => resolveSession(s, req.caller).id)) : undefined
      const emit = (e: { type: string; sessionID?: string } & Record<string, unknown>) => {
        if (types && !types.includes(e.type)) return
        if (only && (!e.sessionID || !only.has(e.sessionID))) return
        stream.emit({ ...e, at: Date.now() })
      }
      type Snap = { title: string; spaceID: string | null; status: string; archived: boolean }
      const snapshot = () => {
        const map = new Map<string, Snap>()
        for (const s of host.sessions())
          map.set(s.id, {
            title: s.title,
            spaceID: store.data.assignments[s.id] ?? null,
            status: s.status,
            archived: !!store.data.archived[s.id],
          })
        return {
          sessions: map,
          current: host.currentSessionID(),
          spaces: JSON.stringify(store.data.spaces),
          settings: JSON.stringify(store.data.settings),
        }
      }
      let prev = snapshot()
      stream.emit({ type: "ready", at: Date.now() })
      const off = host.onChange(() => {
        const next = snapshot()
        for (const [id, s] of next.sessions) {
          const before = prev.sessions.get(id)
          if (!before) {
            const item = byID(id)
            emit({ type: "session.created", sessionID: id, ...(item ? { session: sessionView(item) } : {}) })
            continue
          }
          const changes: Record<string, unknown> = {}
          for (const key of Object.keys(s) as (keyof Snap)[]) if (s[key] !== before[key]) changes[key] = s[key]
          if (Object.keys(changes).length) emit({ type: "session.updated", sessionID: id, changes })
        }
        for (const id of prev.sessions.keys()) if (!next.sessions.has(id)) emit({ type: "session.deleted", sessionID: id })
        if (next.current !== prev.current) emit({ type: "focus.changed", sessionID: next.current ?? undefined, previous: prev.current })
        if (next.spaces !== prev.spaces) emit({ type: "spaces.changed" })
        if (next.settings !== prev.settings) emit({ type: "settings.changed" })
        prev = next
      })
      await stream.closed
      off()
    },
  }

  return handlers
}
