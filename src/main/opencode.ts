import { OpenCode, type ModelInfo, type PermissionRequest, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { ModelChoices, ModelOption, ModelRef, SessionItem } from "../shared/types"

const SPACE_INSTRUCTIONS_KEY = "ctrl.space"

type Client = ReturnType<typeof OpenCode.make>

const MAX_SESSIONS = 1000

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function describePermission(p: PermissionRequest) {
  const target = p.resources[0] ? ` ${p.resources[0]}` : ""
  const text = `Waiting for permission: ${p.action}${target}`
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}

const REFRESH_EVENTS = new Set([
  "session.viewed",
  "session.idle",
  "session.status.updated",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.moved",
  "session.forked",
  "session.metadata.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

export class OpenCodeService {
  client?: Client
  sessions: SessionItem[] = []
  private timer?: ReturnType<typeof setTimeout>
  private setReady!: (client: Client) => void
  /** Resolves once the opencode service is reachable. */
  ready = new Promise<Client>((resolve) => (this.setReady = resolve))

  constructor(private onChange: () => void) {}

  /** Set while the opencode service can't be reached or sessions can't be loaded. */
  problem: string | null = null

  async start() {
    // Keep retrying: the service may still be starting, or come back later.
    while (true) {
      try {
        const endpoint = await Service.ensure()
        this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        await this.refresh()
        this.setProblem(null)
        this.setReady(this.client)
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

  async refresh() {
    if (!this.client) return
    const [all, active] = await Promise.all([
      this.listAll(),
      this.client.session.active().catch(() => ({}) as Record<string, unknown>),
    ])
    const roots = all.filter((s) => !s.parentID && !s.time.archived)
    this.idleAt = new Map(roots.flatMap((s) => (s.time.idle ? [[s.id, s.time.idle] as const] : [])))
    const waiting = await this.pendingInput([...new Set(roots.map((s) => s.location.directory))])

    this.sessions = roots
      .sort((a, b) => b.time.updated - a.time.updated)
      .map((s) => {
        const { status, statusDetail } = this.statusOf(s, s.id in active, waiting.get(s.id))
        return {
          id: s.id,
          title: s.title || "New session",
          directory: s.location.directory,
          updated: s.time.updated,
          status,
          statusDetail,
        }
      })
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

  /** sessionID → reason it's blocked on you (pending permission or question). */
  private async pendingInput(directories: string[]) {
    const out = new Map<string, string>()
    const results = await Promise.allSettled(
      directories.flatMap((directory) => [
        this.client!.permission.request.list({ location: { directory } }),
        this.client!.form.list({ location: { directory } }),
      ]),
    )
    for (const r of results) {
      if (r.status !== "fulfilled") continue
      for (const item of r.value.data) {
        if (out.has(item.sessionID)) continue
        out.set(item.sessionID, "action" in item ? describePermission(item) : `Question: ${item.title}`)
      }
    }
    return out
  }

  currentSessionID: string | null = null
  private idleAt = new Map<string, number>()

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
    const at = idle ?? this.idleAt.get(sessionID)
    if (at === undefined) return
    await this.client?.session.view({ sessionID, idle: at }).catch(() => {})
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

  scheduleRefresh() {
    clearTimeout(this.timer)
    this.timer = setTimeout(
      () =>
        void this.refresh().then(
          () => this.setProblem(null),
          (err) => this.setProblem(`Couldn't load sessions: ${message(err)}`),
        ),
      250,
    )
  }

  private async listen() {
    while (true) {
      try {
        for await (const event of this.client!.event.subscribe()) {
          if (REFRESH_EVENTS.has(event.type)) this.scheduleRefresh()
        }
      } catch (error) {
        console.error("[ctrl] event stream failed", error)
        this.setProblem("Lost connection to opencode · retrying")
      }
      await new Promise((r) => setTimeout(r, 1000))
      this.scheduleRefresh()
    }
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
    await this.refresh()
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
    await this.refresh()
  }

  async removeSession(sessionID: string) {
    await this.client!.session.remove({ sessionID })
    await this.refresh()
  }
}
