import { OpenCode, type PermissionRequest, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { SessionItem } from "../shared/types"

type Client = ReturnType<typeof OpenCode.make>

const MAX_SESSIONS = 1000

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

  constructor(private onChange: () => void) {}

  async start() {
    const endpoint = await Service.ensure()
    this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    await this.refresh()
    void this.listen()
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
    this.timer = setTimeout(() => void this.refresh().catch(console.error), 250)
  }

  private async listen() {
    while (true) {
      try {
        for await (const event of this.client!.event.subscribe()) {
          if (REFRESH_EVENTS.has(event.type)) this.scheduleRefresh()
        }
      } catch (error) {
        console.error("[ctrl] event stream failed", error)
      }
      await new Promise((r) => setTimeout(r, 1000))
      this.scheduleRefresh()
    }
  }

  async createSession(directory: string) {
    const session = await this.client!.session.create({ location: { directory } })
    await this.refresh()
    return session.id
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
