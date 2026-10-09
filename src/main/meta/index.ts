import { DatabaseSync } from "node:sqlite"
import { resourceType } from "../../shared/resources"
import type { ProviderID, ProviderStatus, ResourceItem, ResourceMeta } from "../../shared/types"
import { githubProvider } from "./github"
import { DAY, HOUR, MINUTE, ProviderError, SECOND, type MetaRequest, type Provider } from "./provider"
import { vercelProvider } from "./vercel"

/** Never wake up more often than this, even if something is due sooner. */
const MIN_TICK = 5 * SECOND
/** Delay after a watched session's run ends, so the indexer and the services have settled. */
const AFTER_RUN = 4 * SECOND
/** ctrl's own share of an hourly budget that the CLIs and the agents also spend (GitHub points). */
const HOURLY_CAP = 500
/** Stop when a shared budget gets this low, until it resets. */
const RESERVE = 0.1
/** `next` for final details (stored in SQLite, which has no Infinity) */
const FINAL = Number.MAX_SAFE_INTEGER

type Cached = { meta: ResourceMeta; next: number }
type Watched = MetaRequest & { provider: ProviderID; last: number }

/** Per-provider scheduling state. */
type Runner = {
  provider: Provider
  busy: boolean
  /** No requests before this (rate limit, auth problem, errors) */
  pausedUntil: number
  failures: number
  spent: { hour: number; points: number }
  status: ProviderStatus
}

/**
 * Live details for the resources on screen. Only fetches while the panel is
 * open and the window focused, only for resources whose details are due, and
 * batches them per provider. Details are cached on disk, so reopening the
 * panel or restarting ctrl shows them instantly.
 */
export class ResourceMetaService {
  private db: DatabaseSync
  private cache = new Map<string, Cached>()
  private watched = new Map<string, Watched>()
  private watchedSessions = new Set<string>()
  private focused = false
  private timer?: ReturnType<typeof setTimeout>
  private runners: Record<ProviderID, Runner>

  constructor(
    dbPath: string,
    private hooks: {
      /** Resources of these sessions, from the search index */
      list(sessionIDs: string[]): ResourceItem[]
      onMeta(metas: Record<string, ResourceMeta>): void
      onStatus(): void
    },
  ) {
    const runner = (provider: Provider): Runner => ({
      provider,
      busy: false,
      pausedUntil: 0,
      failures: 0,
      spent: { hour: 0, points: 0 },
      status: { state: "idle" },
    })
    this.runners = { github: runner(githubProvider()), vercel: runner(vercelProvider()) }

    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS resource_meta (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        next INTEGER NOT NULL
      );
    `)
    for (const row of this.db.prepare("SELECT id, data, next FROM resource_meta").all() as {
      id: string
      data: string
      next: number
    }[])
      this.cache.set(row.id, { meta: JSON.parse(row.data), next: row.next })
  }

  get statuses(): Record<ProviderID, ProviderStatus> {
    return { github: this.runners.github.status, vercel: this.runners.vercel.status }
  }

  get(id: string) {
    return this.cache.get(id)?.meta
  }

  /** The panel shows these sessions' resources ([] = hidden). */
  watch(sessionIDs: string[]) {
    this.watchedSessions = new Set(sessionIDs)
    this.refreshWatched()
  }

  /** The index found new mentions in these sessions (null: possibly all). */
  resourcesChanged(sessionIDs: string[] | null) {
    if (!this.watchedSessions.size) return
    if (sessionIDs && !sessionIDs.some((id) => this.watchedSessions.has(id))) return
    this.refreshWatched()
  }

  /** A run just ended in these sessions: the agent may have pushed, merged, deployed or commented. */
  runsEnded(sessionIDs: string[]) {
    if (!sessionIDs.some((id) => this.watchedSessions.has(id))) return
    const soon = Date.now() + AFTER_RUN
    for (const [id, w] of this.watched) {
      const c = this.cache.get(id)
      // Settled things (merged, closed, finished builds) won't move because of a run.
      if (c && this.runners[w.provider].provider.ttl(w.type, c.meta) < DAY && c.next > soon) c.next = soon
    }
    this.schedule(AFTER_RUN)
  }

  setFocused(focused: boolean) {
    this.focused = focused
    if (focused) this.schedule(0)
    else clearTimeout(this.timer)
  }

  /** Settings → Retry: re-read the CLI's token and try now. */
  retry(id: ProviderID) {
    const r = this.runners[id]
    r.provider.resetAuth()
    r.pausedUntil = 0
    r.failures = 0
    this.setStatus(r, { state: "idle" })
    this.schedule(0)
  }

  stop() {
    clearTimeout(this.timer)
    this.db.close()
  }

  private refreshWatched() {
    const items = this.watchedSessions.size ? this.hooks.list([...this.watchedSessions]) : []
    this.watched = new Map()
    for (const i of items) {
      const provider = resourceType(i.type)?.enrich
      if (provider) this.watched.set(i.id, { id: i.id, type: i.type, data: i.data, last: i.last, provider })
    }
    this.schedule(0)
  }

  /** Watched resources with no details yet, stale ones, and ones mentioned again since their last fetch. */
  private due(now: number, provider: ProviderID) {
    return [...this.watched.values()]
      .filter((w) => {
        if (w.provider !== provider) return false
        const c = this.cache.get(w.id)
        return !c || now >= c.next || this.mentionedAgain(w, c)
      })
      .sort((a, b) => b.last - a.last)
  }

  /** Mentioned since its last fetch, so possibly changed (an agent just merged or deployed it). */
  private mentionedAgain(w: Watched, c: Cached) {
    return c.next !== FINAL && w.last > c.meta.fetched
  }

  /** Wakes up when the soonest provider can do something: something is due and it isn't paused. */
  private schedule(delay: number) {
    clearTimeout(this.timer)
    if (!this.focused || !this.watched.size) return
    const now = Date.now()
    let at = Infinity
    for (const r of Object.values(this.runners)) {
      const id = r.provider.id
      let next = Infinity
      for (const w of this.watched.values()) {
        if (w.provider !== id) continue
        const c = this.cache.get(w.id)
        if (c?.next === FINAL) continue
        next = Math.min(next, !c || this.mentionedAgain(w, c) ? now : c.next)
      }
      if (next !== Infinity) at = Math.min(at, Math.max(next, r.pausedUntil))
    }
    if (at === Infinity) return
    // Capped: setTimeout fires right away past ~24.8 days, and waking up once an hour costs nothing.
    this.timer = setTimeout(() => void this.tick(), Math.min(HOUR, Math.max(delay, at - now, 0)))
  }

  private async tick() {
    const now = Date.now()
    await Promise.all(
      Object.values(this.runners).map(async (r) => {
        if (r.busy || now < r.pausedUntil) return
        const batch = this.due(now, r.provider.id).slice(0, r.provider.batchSize)
        if (!batch.length) return
        const hour = Math.floor(now / HOUR)
        if (r.spent.hour !== hour) r.spent = { hour, points: 0 }
        if (r.spent.points >= HOURLY_CAP) {
          r.pausedUntil = (hour + 1) * HOUR
          return this.setStatus(r, { ...r.status, state: "paused", detail: "ctrl used its hourly share of the API budget" })
        }
        r.busy = true
        try {
          await this.fetch(r, batch)
          r.failures = 0
        } catch (err) {
          this.fail(r, err)
        } finally {
          r.busy = false
        }
      }),
    )
    this.schedule(MIN_TICK)
  }

  private async fetch(r: Runner, batch: Watched[]) {
    const result = await r.provider.fetch(batch)
    const insert = this.db.prepare(
      "INSERT INTO resource_meta (id, data, next) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, next = excluded.next",
    )
    const changed: Record<string, ResourceMeta> = {}
    for (const w of batch) {
      const meta = result.metas.get(w.id) ?? { missing: true, fetched: Date.now() }
      const ttl = r.provider.ttl(w.type, meta)
      const next = ttl === Infinity ? FINAL : meta.fetched + ttl
      this.cache.set(w.id, { meta, next })
      insert.run(w.id, JSON.stringify(meta), next)
      changed[w.id] = meta
    }
    this.hooks.onMeta(changed)

    const rate = result.rate
    if (rate) r.spent.points += rate.cost
    const low = rate && rate.remaining < rate.limit * RESERVE
    if (low) r.pausedUntil = rate.resetAt
    this.setStatus(r, {
      state: low ? "paused" : "ok",
      account: result.account ?? r.status.account,
      remaining: rate?.remaining,
      limit: rate?.limit,
      used: rate ? r.spent.points : undefined,
      detail: low ? "the hourly API budget is running low, waiting for it to reset" : undefined,
    })
  }

  private fail(r: Runner, err: unknown) {
    const e = err instanceof ProviderError ? err : new ProviderError(String(err), "network")
    if (e.kind === "no-cli" || e.kind === "logged-out") {
      // Nothing will change until the CLI is set up: Settings has a Retry button, otherwise try again in 10 min.
      r.pausedUntil = Date.now() + 10 * MINUTE
      return this.setStatus(r, { state: e.kind, detail: e.message })
    }
    if (e.kind === "rate-limited") {
      r.pausedUntil = e.retryAt ?? Date.now() + 5 * MINUTE
      return this.setStatus(r, { ...r.status, state: "paused", detail: e.message })
    }
    r.failures++
    r.pausedUntil = Date.now() + Math.min(15 * MINUTE, 30 * SECOND * 2 ** (r.failures - 1))
    this.setStatus(r, { ...r.status, state: "error", detail: e.message })
  }

  private setStatus(r: Runner, status: ProviderStatus) {
    r.status = status
    this.hooks.onStatus()
  }
}
