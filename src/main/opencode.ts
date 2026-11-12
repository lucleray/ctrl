import { OpenCode, type ModelInfo, type PermissionRequest, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { homedir } from "node:os"
import { findOpencode } from "./opencode-bin"
import { CTRL_INSTRUCTIONS } from "../shared/ctrl-instructions"
import type { HarnessSource } from "./harness"
import type {
  McpServerItem,
  ModelChoices,
  ModelOption,
  ModelRef,
  OpencodeServer,
  SessionActivity,
  SessionItem,
} from "../shared/types"
import type { ChatPending, FormField } from "./remote"

const SPACE_INSTRUCTIONS_KEY = "ctrl.space"
const CTRL_INSTRUCTIONS_KEY = "ctrl.cli"
/** The TUI runs in ~, so that's whose MCP servers count. CTRL_MCP_DIR is a debug hook (docs/DEVELOPMENT.md). */
const MCP_DIR = process.env.CTRL_MCP_DIR || homedir()

type Client = ReturnType<typeof OpenCode.make>
type Event = { type: string; data?: Record<string, unknown> }

/** Cap for the full sync on launch plus loadOlder(); sessions created afterwards are added on top. */
const MAX_SESSIONS = 1000
/** Page size for session.list, on every page (cursor pages fall back to 50 without it). */
const PAGE_SIZE = 300
/**
 * The full sync only loads sessions updated this recently; older ones wait for loadOlder() (Archived
 * section, palette search, CLI). Keeps launch and reconnects proportional to recent activity, not history.
 */
const RECENT_MS = 30 * 24 * 60 * 60_000
/** Coalesce a burst of events for one session (execution end + idle) into one fetch. */
const FETCH_DEBOUNCE_MS = 100
/**
 * Shells are listed per folder, and asking a folder makes opencode load it. So the full sync only asks the
 * folders of sessions updated this recently (a session that starts a shell gets updated), at most
 * SHELL_FOLDERS of them. Shells started later arrive as events wherever they run.
 */
const SHELL_RECENT_MS = 6 * 60 * 60_000
const SHELL_FOLDERS = 12
/** Subagents nest; walking up to the root stops here. */
const MAX_DEPTH = 16
const MAX_SUBAGENTS = 2000

/**
 * Runs inside the service. Fails once it lost its macOS login session (e.g. the terminal that
 * spawned it went away): user lookups then return the bare uid.
 */
const HEALTH_PROBE = `[ "$(/usr/bin/id -un)" != "$(/usr/bin/id -u)" ]`
const HEALTH_INTERVAL_MS = 5 * 60_000
const HEALTH_TIMEOUT_MS = 15_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function describePermission(p: Pick<PermissionRequest, "action" | "resources">) {
  const target = p.resources[0] ? ` ${p.resources[0]}` : ""
  const text = `Waiting for permission: ${p.action}${target}`
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}

/** Events whose payload lacks what the sidebar shows (idle time, outcome, updated): re-read that one session. */
const FETCH_EVENTS = new Set([
  "session.created",
  "session.forked",
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

/** A pending permission or question, keyed by its request/form id. Questions keep their form for the phone. */
type Form = { id: string; sessionID: string; title: string; fields?: FormField[] }
const question = (form: Form) => ({
  sessionID: form.sessionID,
  detail: `Question: ${form.title}`,
  kind: "question" as const,
  title: form.title,
  fields: form.fields ?? [],
})

type Pending =
  | { sessionID: string; detail: string; kind: "permission" }
  | { sessionID: string; detail: string; kind: "question"; title: string; fields: FormField[] }

/**
 * Keeps the sidebar's session list in sync with opencode.
 *
 * One full sync on launch and after the event stream reconnects (events may
 * have been missed), of the sessions updated in the last RECENT_MS; older ones
 * load on demand (loadOlder). After that, events patch the in-memory state
 * directly, or re-read just the session they're about, so the cost of an update
 * doesn't grow with the number of sessions.
 */
export class OpenCodeService implements HarnessSource {
  readonly harness = "opencode" as const
  client?: Client
  sessions: SessionItem[] = []
  /** MCP servers for the TUI's folder (~), where global config applies. */
  mcp: McpServerItem[] = []
  private mcpTimer?: ReturnType<typeof setTimeout>
  private setReady!: (client: Client) => void
  /** Resolves once the opencode service is reachable. */
  ready = new Promise<Client>((resolve) => (this.setReady = resolve))

  /** Root, non-archived sessions as opencode reports them. */
  private infos = new Map<string, SessionInfo>()
  /** Running sessions, subagents included. */
  private running = new Set<string>()
  /** Subagent → the session that started it (opencode's parentID), learned as subagents start. */
  private subagentParents = new Map<string, string>()
  /** Running shells → the session that started them (`metadata.sessionID`). */
  private shells = new Map<string, string>()
  /** Background activity per root session, derived in rebuild(). */
  private activityByRoot = new Map<string, SessionActivity>()
  private pending = new Map<string, Pending>()
  /** Events that arrive during a full sync are applied after it, so the snapshot can't overwrite them. */
  private buffered: Event[] | null = null
  private fetchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Runs that ended but whose idle time/outcome haven't been fetched yet. They stay "running" until then:
   * flipping to idle first would hide the running → unread transition that notifications rely on.
   */
  private ending = new Set<string>()
  /** Deleted while a fetch was in flight: don't let the fetch bring it back. */
  private deleted = new Set<string>()
  /** Where the recent sync stopped: the older sessions it already got, and the cursor for the rest. */
  private olderStart: { head: SessionInfo[]; cursor: string | null } | null = null
  private olderLoad: Promise<void> | null = null
  /** loadOlder() was asked for: a re-sync loads the older sessions again. */
  private wantOlder = false
  /** Bumped by every full sync, so an older-load started before it doesn't merge stale data. */
  private generation = 0

  constructor(private onChange: () => void) {}

  /** Set while the opencode service can't be reached or sessions can't be loaded. */
  problem: string | null = null

  server: OpencodeServer = { state: "checking" }
  private checking = false

  async start() {
    await this.connect()
    void this.listen()
    setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS)
  }

  private async connect() {
    // Keep retrying: the service may still be starting, or come back later.
    while (true) {
      try {
        // The default command is `opencode` from PATH, which a Finder launch may not have.
        const bin = findOpencode()
        const endpoint = await Service.ensure(bin ? { command: [bin, "serve", "--service"] } : {})
        this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        return
      } catch (err) {
        this.setProblem(`Can't reach opencode: ${message(err)}`)
        await sleep(3000)
      }
    }
  }

  private setProblem(problem: string | null) {
    if (problem === this.problem) return
    this.problem = problem
    this.onChange()
  }

  private setServer(server: OpencodeServer) {
    if (JSON.stringify(server) === JSON.stringify(this.server)) return
    this.server = server
    this.onChange()
  }

  /** Runs HEALTH_PROBE inside the service. Only a clean failure counts: an unreachable or slow service isn't this. */
  async checkHealth() {
    const client = this.client
    if (!client || this.checking || this.server.state === "restarting") return
    this.checking = true
    try {
      const info = await client.server.info()
      const healthy = await this.probe(client)
      this.setServer({ state: healthy ? "ok" : "broken", version: info.version, pid: info.pid })
    } catch (err) {
      console.error("[ctrl] opencode health check failed", err)
    } finally {
      this.checking = false
    }
  }

  private async probe(client: Client) {
    const location = { directory: homedir() }
    const { data } = await client.shell.create({ location, command: HEALTH_PROBE, timeout: HEALTH_TIMEOUT_MS })
    try {
      let shell = data
      const deadline = Date.now() + HEALTH_TIMEOUT_MS
      while (shell.status === "running" && Date.now() < deadline) {
        await sleep(250)
        shell = (await client.shell.get({ id: shell.id, location })).data
      }
      return !(shell.status === "exited" && shell.exit !== 0)
    } finally {
      void client.shell.remove({ id: data.id, location }).catch(() => {})
    }
  }

  /** Stops the registered service (whoever started it) and starts a fresh one from ctrl. Runs in progress stop. */
  async restart() {
    if (this.server.state === "restarting") return
    this.setServer({ state: "restarting" })
    try {
      await Service.stop({ pty: "handoff" })
      // listen() picks up the new client on its next reconnect.
      await this.connect()
    } finally {
      this.server = { state: "checking" }
      this.onChange()
      await this.checkHealth()
    }
  }

  /** Snapshot of recently updated root sessions, which ones run, and what's waiting on you. */
  private async sync() {
    const client = this.client!
    const generation = ++this.generation
    // Older sessions load again once this sync is done (wantOlder); asking before then waits for nothing.
    this.olderStart = null
    this.olderLoad = null
    const [{ recent, older }, active] = await Promise.all([
      this.listRecent(),
      client.session.active().catch(() => ({}) as Record<string, unknown>),
    ])
    const roots = recent.filter((s) => !s.parentID && !s.time.archived)
    const byID = new Map(roots.map((s) => [s.id, s]))
    // Only a running session can wait on you, so only their folders are asked. Asking a folder makes
    // opencode load it (config, plugins, MCP), and every folder that ever had a session adds up.
    const running = Object.keys(active)
    const shellCutoff = Date.now() - SHELL_RECENT_MS
    const shellFolders = [
      ...new Set(roots.filter((s) => s.time.updated >= shellCutoff).map((s) => s.location.directory)),
    ].slice(0, SHELL_FOLDERS)
    const [pending, shells, parents] = await Promise.all([
      this.pendingInput([...new Set(running.flatMap((id) => byID.get(id)?.location.directory ?? []))]),
      this.listShells(shellFolders),
      // Running sessions the root list doesn't have are subagents (bounded by what runs right now).
      this.parentsOf(running.filter((id) => !byID.has(id))),
    ])
    if (generation !== this.generation) return
    this.infos = byID
    this.olderStart = older
    this.olderLoad = null
    this.running = new Set(running)
    this.pending = pending
    this.shells = shells
    for (const [id, parentID] of parents) this.subagentParents.set(id, parentID)
    this.rebuild()
    this.refreshMcpSoon()
    console.log(`[ctrl] full sync: ${roots.length} recent sessions`)
    if (this.wantOlder) void this.loadOlder()
  }

  /**
   * Adds the sessions the full sync left out (not updated in RECENT_MS). Called when they're about to be
   * shown or looked up; cheap once loaded, and a no-op before the first sync.
   */
  loadOlder(): Promise<void> {
    this.wantOlder = true
    const start = this.olderStart
    if (!start || !this.client) return Promise.resolve()
    this.olderLoad ??= (async () => {
      const generation = this.generation
      const found = [...start.head]
      let cursor = start.cursor
      try {
        while (cursor && this.infos.size + found.length < MAX_SESSIONS) {
          const res = await this.client!.session.list({ cursor, limit: PAGE_SIZE })
          found.push(...res.data)
          cursor = (res.data.length ? res.cursor.next : null) ?? null
        }
      } catch (err) {
        console.error("[ctrl] loading older sessions failed", err)
      }
      if (generation !== this.generation) return
      this.olderStart = null
      let added = 0
      for (const s of found) {
        if (s.parentID || s.time.archived || this.infos.has(s.id) || this.deleted.has(s.id)) continue
        this.infos.set(s.id, s)
        added++
      }
      if (added) this.rebuild()
      console.log(`[ctrl] loaded ${added} older sessions`)
    })()
    return this.olderLoad
  }

  /** Status changes arrive one server at a time (and per folder); re-list once per burst. */
  private refreshMcpSoon() {
    clearTimeout(this.mcpTimer)
    this.mcpTimer = setTimeout(() => void this.refreshMcp(), FETCH_DEBOUNCE_MS)
  }

  private async refreshMcp() {
    try {
      const res = await this.client!.mcp.list({ location: { directory: MCP_DIR } })
      this.mcp = res.data.map((s) => ({
        name: s.name,
        status: s.status.status,
        error: "error" in s.status ? s.status.error : undefined,
      }))
      this.onChange()
    } catch (err) {
      console.error("[ctrl] mcp list failed", err)
    }
  }

  async reconnectMcp(server: string) {
    await this.client!.mcp.connect({ server, location: { directory: MCP_DIR } })
    await this.refreshMcp()
  }

  /**
   * Root sessions updated in the last RECENT_MS, newest first (opencode lists by update time). Stops at the
   * first page that reaches older ones, and returns where it stopped so loadOlder() can pick up from there.
   */
  private async listRecent() {
    const cutoff = Date.now() - RECENT_MS
    const recent: SessionInfo[] = []
    let res = await this.client!.session.list({ parentID: "null", limit: PAGE_SIZE })
    while (true) {
      const fresh = res.data.filter((s) => s.time.updated >= cutoff)
      recent.push(...fresh)
      const next = (res.data.length ? res.cursor.next : null) ?? null
      if (fresh.length < res.data.length || !next || recent.length >= MAX_SESSIONS) {
        const older = res.data.filter((s) => s.time.updated < cutoff)
        return { recent, older: older.length || next ? { head: older, cursor: next } : null }
      }
      res = await this.client!.session.list({ cursor: next, limit: PAGE_SIZE })
    }
  }

  /** Running shells in these folders, by shell id → session id. */
  private async listShells(directories: string[]) {
    const out = new Map<string, string>()
    const results = await Promise.allSettled(
      directories.map((directory) => this.client!.shell.list({ location: { directory } })),
    )
    for (const r of results) {
      if (r.status !== "fulfilled") continue
      for (const shell of r.value.data) {
        const sessionID = shell.metadata?.sessionID
        if (shell.status === "running" && typeof sessionID === "string") out.set(shell.id, sessionID)
      }
    }
    return out
  }

  /** Parent of each subagent session. */
  private async parentsOf(ids: string[]) {
    const out = new Map<string, string>()
    const results = await Promise.allSettled(ids.map((sessionID) => this.client!.session.get({ sessionID })))
    for (const r of results) if (r.status === "fulfilled" && r.value.parentID) out.set(r.value.id, r.value.parentID)
    return out
  }

  private async pendingInput(directories: string[]) {
    const out = new Map<string, Pending>()
    const results = await Promise.allSettled(
      directories.flatMap((directory) => [
        this.client!.permission.request.list({ location: { directory } }),
        this.client!.form.list({ location: { directory } }),
      ]),
    )
    for (const r of results) {
      if (r.status !== "fulfilled") continue
      for (const item of r.value.data) {
        if ("action" in item) out.set(item.id, { sessionID: item.sessionID, detail: describePermission(item), kind: "permission" })
        else out.set(item.id, question(item as unknown as Form))
      }
    }
    return out
  }

  private async listen() {
    while (true) {
      try {
        const events = this.client!.event.subscribe()[Symbol.asyncIterator]()
        // Open the stream before the snapshot, so nothing between the two is lost.
        const first = events.next()
        this.buffered = []
        const synced = this.sync().then(
          () => {
            this.setProblem(null)
            this.setReady(this.client!)
            void this.checkHealth()
          },
          (err) => this.setProblem(`Couldn't load sessions: ${message(err)}`),
        )
        void synced.finally(() => {
          const queued = this.buffered ?? []
          this.buffered = null
          for (const event of queued) this.apply(event)
        })
        for (let next = await first; !next.done; next = await events.next()) {
          const event = next.value as Event
          if (this.buffered) this.buffered.push(event)
          else this.apply(event)
        }
      } catch (error) {
        console.error("[ctrl] event stream failed", error)
        this.setProblem("Lost connection to opencode · retrying")
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  private apply(event: Event) {
    const d = event.data ?? {}
    const id = typeof d.sessionID === "string" ? d.sessionID : undefined
    if (id) this.onSessionEvent?.(id, event.type)
    switch (event.type) {
      case "permission.asked":
        this.pending.set(String(d.id), {
          sessionID: id!,
          detail: describePermission(d as unknown as PermissionRequest),
          kind: "permission",
        })
        return this.rebuild()
      case "permission.replied":
        this.pending.delete(String(d.requestID))
        return this.rebuild()
      case "form.created": {
        const form = d.form as unknown as Form
        this.pending.set(form.id, question(form))
        return this.rebuild()
      }
      case "form.replied":
      case "form.cancelled":
        this.pending.delete(String(d.id))
        return this.rebuild()
      case "mcp.status.changed":
        return this.refreshMcpSoon()
      case "shell.created": {
        const info = d.info as { id: string; status: string; metadata?: Record<string, unknown> }
        const sessionID = info.metadata?.sessionID
        if (info.status !== "running" || typeof sessionID !== "string") return
        this.shells.set(info.id, sessionID)
        return this.rebuild()
      }
      case "shell.exited":
      case "shell.deleted":
        if (this.shells.delete(String(d.id))) this.rebuild()
        return
    }
    if (!id) return
    const info = this.infos.get(id)
    switch (event.type) {
      case "session.deleted":
        this.deleted.add(id)
        this.infos.delete(id)
        this.running.delete(id)
        this.subagentParents.delete(id)
        return this.rebuild()
      case "session.renamed":
        if (info) this.infos.set(id, { ...info, title: String(d.title) })
        return this.rebuild()
      case "session.moved":
        if (info) this.infos.set(id, { ...info, location: d.location as SessionInfo["location"] })
        return this.rebuild()
      case "session.viewed":
        if (info) this.infos.set(id, { ...info, time: { ...info.time, viewed: Number(d.idle) } })
        return this.rebuild()
    }
    if (event.type === "session.execution.started") {
      this.ending.delete(id)
      this.running.add(id)
      this.rebuild()
    } else if (event.type.startsWith("session.execution.")) {
      this.ending.add(id)
    }
    if (FETCH_EVENTS.has(event.type)) this.fetchSoon(id)
  }

  private fetchSoon(id: string) {
    clearTimeout(this.fetchTimers.get(id))
    this.fetchTimers.set(
      id,
      setTimeout(() => {
        this.fetchTimers.delete(id)
        void this.fetchSession(id)
      }, FETCH_DEBOUNCE_MS),
    )
  }

  /** Re-reads one session. Subagent and archived sessions stay out of the sidebar. */
  private async fetchSession(id: string) {
    let info: SessionInfo | undefined
    try {
      info = await this.client!.session.get({ sessionID: id })
    } catch {
      // Deleted meanwhile, or a transient failure the next event or sync will fix.
    }
    if (this.ending.delete(id)) this.running.delete(id)
    if (info?.parentID) this.subagentParents.set(id, info.parentID)
    if (info && !this.deleted.has(id) && !info.parentID) {
      if (info.time.archived) this.infos.delete(id)
      else this.infos.set(id, info)
    }
    this.rebuild()
  }

  /** The root session a subagent (at any depth) belongs to. */
  private rootOf(id: string) {
    let root = id
    for (let i = 0; i < MAX_DEPTH; i++) {
      const parent = this.subagentParents.get(root)
      if (!parent) break
      root = parent
    }
    return root
  }

  /** Shells and running subagents per root session. Proportional to what runs, not to how many sessions exist. */
  private rebuildActivity() {
    const out = new Map<string, SessionActivity>()
    const entry = (root: string) => {
      let a = out.get(root)
      if (!a) out.set(root, (a = { shells: 0, subagents: 0 }))
      return a
    }
    for (const sessionID of this.shells.values()) entry(this.rootOf(sessionID)).shells++
    for (const id of this.running) {
      if (!this.subagentParents.has(id)) continue
      entry(this.rootOf(id)).subagents++
    }
    this.activityByRoot = out
    // Every subagent ever seen would pile up: past a bound, forget the ones nothing runs in anymore.
    if (this.subagentParents.size > MAX_SUBAGENTS) {
      const shellSessions = new Set(this.shells.values())
      for (const id of this.subagentParents.keys())
        if (!this.running.has(id) && !shellSessions.has(id)) this.subagentParents.delete(id)
    }
  }

  activity(sessionID: string) {
    return this.activityByRoot.get(sessionID)
  }

  /** opencode's ⌃B: shells and subagents the turn waits for go on in the background (a no-op when there's none). */
  async background(sessionID: string) {
    await this.client?.session.background({ sessionID })
  }

  /** Derives the sidebar list from in-memory state, without touching the network. */
  private rebuild() {
    this.rebuildActivity()
    const waiting = new Map<string, string>()
    for (const p of this.pending.values()) if (!waiting.has(p.sessionID)) waiting.set(p.sessionID, p.detail)
    this.sessions = [...this.infos.values()]
      .sort((a, b) => b.time.updated - a.time.updated)
      .map((s) => ({
        id: s.id,
        harness: "opencode" as const,
        title: s.title || "New session",
        directory: s.location.directory,
        updated: s.time.updated,
        ...this.statusOf(s, this.running.has(s.id), waiting.get(s.id)),
      }))
    this.onChange()
  }

  private statusOf(
    s: SessionInfo,
    running: boolean,
    waiting: string | undefined,
  ): Pick<SessionItem, "status" | "statusDetail"> {
    if (waiting) return { status: "needs-input", statusDetail: waiting }
    if (running) return { status: "running", statusDetail: "Running" }
    const idle = s.time.idle
    const unread = idle !== undefined && (s.time.viewed === undefined || idle > s.time.viewed)
    if (!unread) return { status: "idle" }
    // You're looking at it right now, so it isn't unread: tell opencode too.
    if (s.id === this.currentSessionID) {
      void this.markViewed(s.id, idle)
      return { status: "idle" }
    }
    if (s.outcome === "failed") return { status: "failed", statusDetail: "Failed" }
    return { status: "unread", statusDetail: "Finished · unread" }
  }

  currentSessionID: string | null = null

  /** Optimistically clears unread/failed for a session you just opened. */
  /** Every event about a session (remote control's chat view refreshes on them). */
  onSessionEvent?: (sessionID: string, type: string) => void

  /** Permissions and questions waiting on you in this session, with their request/form ids. */
  pendingFor(sessionID: string): ChatPending[] {
    return [...this.pending].flatMap(([id, p]): ChatPending[] => {
      if (p.sessionID !== sessionID) return []
      if (p.kind === "permission") return [{ id, kind: p.kind, detail: p.detail }]
      return [{ id, kind: p.kind, detail: p.detail, title: p.title, fields: p.fields }]
    })
  }

  setCurrent(sessionID: string | null) {
    this.currentSessionID = sessionID
    if (!sessionID) return
    const s = this.sessions.find((x) => x.id === sessionID)
    if (s && (s.status === "unread" || s.status === "failed")) {
      s.status = "idle"
      s.statusDetail = undefined
      void this.markViewed(sessionID)
      this.onChange()
    }
  }

  async markViewed(sessionID: string, idle?: number) {
    const at = idle ?? this.infos.get(sessionID)?.time.idle
    if (at === undefined) return
    await this.client?.session.view({ sessionID, idle: at }).catch(() => {})
  }

  async createSession(directory: string, opts: { model?: ModelRef; instructions?: string; ctrl?: boolean } = {}) {
    const session = await this.client!.session.create({ location: { directory }, model: opts.model })
    if (opts.instructions?.trim()) {
      // Durable and invisible in the transcript: opencode adds it to the system context of every turn.
      await this.client!.session.instructions.entry.put({
        sessionID: session.id,
        key: SPACE_INSTRUCTIONS_KEY,
        value: opts.instructions.trim(),
      })
    }
    if (opts.ctrl) await this.syncCtrlInstructions(session.id, true)
    await this.fetchSession(session.id)
    return session.id
  }

  /** What ctrl last set per session this run, so syncing the session on screen on every push is free. */
  private ctrlApplied = new Map<string, boolean>()

  /**
   * Adds or removes the ctrl instruction. Called for new sessions and for the one on screen, so sessions ctrl
   * didn't create (TUI `/new`, older ones) pick it up when opened, and setting changes reach them the same way.
   */
  async syncCtrlInstructions(sessionID: string, on: boolean) {
    if (!this.client || this.ctrlApplied.get(sessionID) === on) return
    this.ctrlApplied.set(sessionID, on)
    const entry = this.client.session.instructions.entry
    const key = CTRL_INSTRUCTIONS_KEY
    // No retry on failure: this runs on every push, and removing an entry that was never set fails too.
    await (on ? entry.put({ sessionID, key, value: CTRL_INSTRUCTIONS }) : entry.remove({ sessionID, key })).catch(
      (err) => on && console.error("[ctrl] ctrl instruction", sessionID, message(err)),
    )
  }

  async listModels(directory?: string): Promise<ModelChoices> {
    const location = directory ? { directory } : undefined
    const client = await this.ready
    const providers = await client.provider.list({ location }).then(
      (r) => r.data.map((p) => ({ id: p.id, name: p.name })),
      () => [],
    )
    const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id
    const option = (m: ModelInfo): ModelOption => ({
      providerID: m.providerID,
      id: m.id,
      name: m.name,
      providerName: providerName(m.providerID),
      vendor: m.id.includes("/") ? m.id.split("/")[0] : undefined,
      released: m.time.released,
      variants: m.variants.map((v) => v.id),
    })
    // A folder opencode hasn't loaded yet can briefly report no models.
    let list = await client.model.list({ location })
    for (let i = 0; i < 5 && list.data.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500))
      list = await client.model.list({ location })
    }
    const rank = (id: string) => {
      const i = providers.findIndex((p) => p.id === id)
      return i === -1 ? providers.length : i
    }
    const models = list.data
      .map(option)
      .sort(
        (a, b) =>
          rank(a.providerID) - rank(b.providerID) ||
          a.providerID.localeCompare(b.providerID) ||
          (a.vendor ?? "").localeCompare(b.vendor ?? "") ||
          b.released - a.released ||
          a.name.localeCompare(b.name),
      )
    const used = new Set(models.map((m) => m.providerID))
    return {
      models,
      providers: [...used].sort((a, b) => rank(a) - rank(b)).map((id) => ({ id, name: providerName(id) })),
    }
  }

  async renameSession(sessionID: string, title: string) {
    await this.client!.session.update({ sessionID, title })
    const info = this.infos.get(sessionID)
    if (info) this.infos.set(sessionID, { ...info, title })
    this.rebuild()
  }

  async removeSession(sessionID: string) {
    await this.client!.session.remove({ sessionID })
    this.deleted.add(sessionID)
    this.infos.delete(sessionID)
    this.running.delete(sessionID)
    this.subagentParents.delete(sessionID)
    this.rebuild()
  }
}
