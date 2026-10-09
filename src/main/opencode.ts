import { OpenCode, type ModelInfo, type PermissionRequest, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { ModelChoices, ModelOption, ModelRef, SessionItem } from "../shared/types"

const SPACE_INSTRUCTIONS_KEY = "ctrl.space"

type Client = ReturnType<typeof OpenCode.make>
type Event = { type: string; data?: Record<string, unknown> }

/** Cap for the full sync on launch; sessions created afterwards are added on top. */
const MAX_SESSIONS = 1000
/** Coalesce a burst of events for one session (execution end + idle) into one fetch. */
const FETCH_DEBOUNCE_MS = 100

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

/** A pending permission or question, keyed by its request/form id. */
type Pending = { sessionID: string; detail: string }

/**
 * Keeps the sidebar's session list in sync with opencode.
 *
 * One full sync on launch and after the event stream reconnects (events may
 * have been missed). After that, events patch the in-memory state directly, or
 * re-read just the session they're about, so the cost of an update doesn't grow
 * with the number of sessions.
 */
export class OpenCodeService {
  client?: Client
  sessions: SessionItem[] = []
  private setReady!: (client: Client) => void
  /** Resolves once the opencode service is reachable. */
  ready = new Promise<Client>((resolve) => (this.setReady = resolve))

  /** Root, non-archived sessions as opencode reports them. */
  private infos = new Map<string, SessionInfo>()
  private running = new Set<string>()
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

  constructor(private onChange: () => void) {}

  /** Set while the opencode service can't be reached or sessions can't be loaded. */
  problem: string | null = null

  async start() {
    // Keep retrying: the service may still be starting, or come back later.
    while (true) {
      try {
        const endpoint = await Service.ensure()
        this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        break
      } catch (err) {
        this.setProblem(`Can't reach opencode: ${message(err)}`)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    void this.listen()
  }

  private setProblem(problem: string | null) {
    if (problem === this.problem) return
    this.problem = problem
    this.onChange()
  }

  /** Full snapshot: every root session, which ones run, and what's waiting on you. */
  private async sync() {
    const client = this.client!
    const [all, active] = await Promise.all([
      this.listAll(),
      client.session.active().catch(() => ({}) as Record<string, unknown>),
    ])
    const roots = all.filter((s) => !s.parentID && !s.time.archived)
    const pending = await this.pendingInput([...new Set(roots.map((s) => s.location.directory))])
    this.infos = new Map(roots.map((s) => [s.id, s]))
    this.running = new Set(Object.keys(active))
    this.pending = pending
    this.rebuild()
    console.log(`[ctrl] full sync: ${roots.length} sessions`)
  }

  private async listAll() {
    const all: SessionInfo[] = []
    let res = await this.client!.session.list({ parentID: "null", limit: 300 })
    all.push(...res.data)
    while (res.cursor.next && res.data.length > 0 && all.length < MAX_SESSIONS) {
      res = await this.client!.session.list({ cursor: res.cursor.next })
      all.push(...res.data)
    }
    return all
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
        const detail = "action" in item ? describePermission(item) : `Question: ${item.title}`
        out.set(item.id, { sessionID: item.sessionID, detail })
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
    switch (event.type) {
      case "permission.asked":
        this.pending.set(String(d.id), {
          sessionID: id!,
          detail: describePermission(d as unknown as PermissionRequest),
        })
        return this.rebuild()
      case "permission.replied":
        this.pending.delete(String(d.requestID))
        return this.rebuild()
      case "form.created": {
        const form = d.form as { id: string; sessionID: string; title: string }
        this.pending.set(form.id, { sessionID: form.sessionID, detail: `Question: ${form.title}` })
        return this.rebuild()
      }
      case "form.replied":
      case "form.cancelled":
        this.pending.delete(String(d.id))
        return this.rebuild()
    }
    if (!id) return
    const info = this.infos.get(id)
    switch (event.type) {
      case "session.deleted":
        this.deleted.add(id)
        this.infos.delete(id)
        this.running.delete(id)
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
    if (info && !this.deleted.has(id) && !info.parentID) {
      if (info.time.archived) this.infos.delete(id)
      else this.infos.set(id, info)
    }
    this.rebuild()
  }

  /** Derives the sidebar list from in-memory state, without touching the network. */
  private rebuild() {
    const waiting = new Map<string, string>()
    for (const p of this.pending.values()) if (!waiting.has(p.sessionID)) waiting.set(p.sessionID, p.detail)
    this.sessions = [...this.infos.values()]
      .sort((a, b) => b.time.updated - a.time.updated)
      .map((s) => ({
        id: s.id,
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

  async createSession(directory: string, opts: { model?: ModelRef; instructions?: string } = {}) {
    const session = await this.client!.session.create({ location: { directory }, model: opts.model })
    if (opts.instructions?.trim()) {
      // Durable and invisible in the transcript: opencode adds it to the system context of every turn.
      await this.client!.session.instructions.entry.put({
        sessionID: session.id,
        key: SPACE_INSTRUCTIONS_KEY,
        value: opts.instructions.trim(),
      })
    }
    await this.fetchSession(session.id)
    return session.id
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
    this.rebuild()
  }
}
