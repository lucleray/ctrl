import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { SessionItem } from "../shared/types"

type Client = ReturnType<typeof OpenCode.make>

const REFRESH_EVENTS = new Set([
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
    const [list, active] = await Promise.all([
      this.client.session.list({ parentID: "null", limit: 300 }),
      this.client.session.active().catch(() => ({}) as Record<string, unknown>),
    ])
    this.sessions = list.data
      .filter((s) => !s.parentID && !s.time.archived)
      .sort((a, b) => b.time.updated - a.time.updated)
      .map((s) => ({
        id: s.id,
        title: s.title || "New session",
        directory: s.location.directory,
        updated: s.time.updated,
        running: s.id in active,
      }))
    this.onChange()
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

  async removeSession(sessionID: string) {
    await this.client!.session.remove({ sessionID })
    await this.refresh()
  }
}
