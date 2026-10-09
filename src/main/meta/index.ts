import { DatabaseSync } from "node:sqlite"
import { resourceType } from "../../shared/resources"
import type { GithubStatus, ResourceItem, ResourceMeta } from "../../shared/types"
import { fetchGithub, GithubError, GithubToken, type MetaRequest } from "./github"

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** Resources per GraphQL request; ~1 point each. */
const BATCH = 40
/** Never wake up more often than this, even if something is due sooner. */
const MIN_TICK = 5 * SECOND
/** Delay after a watched session's run ends, so the indexer and GitHub have settled. */
const AFTER_RUN = 4 * SECOND
/** ctrl's own share of the hourly budget, which gh and the agents also spend. */
const HOURLY_CAP = 500
/** Stop when the shared budget gets this low, until it resets. */
const RESERVE = 0.1

/**
 * How long details stay fresh: things that are moving (CI running, GitHub
 * computing mergeability) refresh every minute, settled ones rarely.
 */
function ttl(type: string, m: ResourceMeta) {
  if (m.missing) return 24 * HOUR
  if (type === "github-repo") return 7 * 24 * HOUR
  if (type === "github-commit") return m.ci === "pending" ? MINUTE : 24 * HOUR
  const open = m.state === "open" || m.state === "draft"
  if (!open) return 24 * HOUR
  if (type === "github-pr" && (m.ci === "pending" || m.conflicts === undefined)) return MINUTE
  if (m.state === "draft") return 10 * MINUTE
  return type === "github-pr" ? 5 * MINUTE : 10 * MINUTE
}

/** Done changing (merged, closed, CI finished): a finished run won't make it move again. */
function settled(type: string, m: ResourceMeta) {
  return ttl(type, m) >= 24 * HOUR
}

type Cached = { meta: ResourceMeta; next: number }
type Watched = MetaRequest & { last: number }

/**
 * Live details for the resources on screen. Only fetches while the panel is
 * open and the window focused, only for resources whose details are due, and
 * batches everything into one GitHub request. Details are cached on disk, so
 * reopening the panel or restarting ctrl shows them instantly.
 */
export class ResourceMetaService {
  private db: DatabaseSync
  private cache = new Map<string, Cached>()
  private watched = new Map<string, Watched>()
  private watchedSessions = new Set<string>()
  private focused = false
  private busy = false
  private timer?: ReturnType<typeof setTimeout>
  private token = new GithubToken()
  /** No requests before this (rate limit, errors) */
  private pausedUntil = 0
  private failures = 0
  private spent: { hour: number; points: number } = { hour: 0, points: 0 }
  status: GithubStatus = { state: "idle" }

  constructor(
    dbPath: string,
    private hooks: {
      /** Resources of these sessions, from the search index */
      list(sessionIDs: string[]): ResourceItem[]
      onMeta(metas: Record<string, ResourceMeta>): void
      onStatus(): void
    },
  ) {
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

  /** A run just ended in these sessions: the agent may have pushed, merged or commented. */
  runsEnded(sessionIDs: string[]) {
    if (!sessionIDs.some((id) => this.watchedSessions.has(id))) return
    const soon = Date.now() + AFTER_RUN
    for (const [id, w] of this.watched) {
      const c = this.cache.get(id)
      if (c && !settled(w.type, c.meta) && c.next > soon) c.next = soon
    }
    this.schedule(AFTER_RUN)
  }

  setFocused(focused: boolean) {
    this.focused = focused
    if (focused) this.schedule(0)
    else clearTimeout(this.timer)
  }

  /** Settings → Retry: re-read gh's token and try now. */
  retry() {
    this.token.reset()
    this.pausedUntil = 0
    this.failures = 0
    this.setStatus({ state: "idle" })
    this.schedule(0)
  }

  stop() {
    clearTimeout(this.timer)
    this.db.close()
  }

  private refreshWatched() {
    const items = this.watchedSessions.size ? this.hooks.list([...this.watchedSessions]) : []
    this.watched = new Map(
      items
        .filter((i) => resourceType(i.type)?.enrich === "github")
        .map((i) => [i.id, { id: i.id, type: i.type, data: i.data, last: i.last }]),
    )
    this.schedule(0)
  }

  /** Watched resources with no details yet, stale ones, and ones mentioned again since their last fetch. */
  private due(now: number) {
    return [...this.watched.values()]
      .filter((w) => {
        const c = this.cache.get(w.id)
        return !c || now >= c.next || w.last > c.meta.fetched
      })
      .sort((a, b) => b.last - a.last)
  }

  private schedule(delay: number) {
    clearTimeout(this.timer)
    if (!this.focused || !this.watched.size) return
    this.timer = setTimeout(() => void this.tick(), Math.max(delay, this.pausedUntil - Date.now(), 0))
  }

  private async tick() {
    if (this.busy) return
    const now = Date.now()
    if (now < this.pausedUntil) return this.schedule(0)
    const hour = Math.floor(now / HOUR)
    if (this.spent.hour !== hour) this.spent = { hour, points: 0 }
    if (this.spent.points >= HOURLY_CAP) {
      this.pausedUntil = (hour + 1) * HOUR
      this.setStatus({ ...this.status, state: "paused", detail: "ctrl used its hourly share of the GitHub budget" })
      return this.schedule(0)
    }

    const batch = this.due(now).slice(0, BATCH)
    if (batch.length) {
      this.busy = true
      try {
        await this.fetch(batch)
        this.failures = 0
      } catch (err) {
        this.fail(err)
      } finally {
        this.busy = false
      }
    }
    this.scheduleNext()
  }

  private async fetch(batch: Watched[]) {
    const token = await this.token.get()
    let result
    try {
      result = await fetchGithub(token, batch)
    } catch (err) {
      // gh may have refreshed or switched accounts: re-read the token once.
      if (!(err instanceof GithubError && err.kind === "logged-out")) throw err
      this.token.reset()
      result = await fetchGithub(await this.token.get(), batch)
    }

    const insert = this.db.prepare(
      "INSERT INTO resource_meta (id, data, next) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, next = excluded.next",
    )
    const changed: Record<string, ResourceMeta> = {}
    for (const w of batch) {
      const meta = result.metas.get(w.id) ?? { missing: true, fetched: Date.now() }
      const next = meta.fetched + ttl(w.type, meta)
      this.cache.set(w.id, { meta, next })
      insert.run(w.id, JSON.stringify(meta), next)
      changed[w.id] = meta
    }
    this.hooks.onMeta(changed)

    const rate = result.rate
    if (rate) this.spent.points += rate.cost
    const low = rate && rate.remaining < rate.limit * RESERVE
    if (low) this.pausedUntil = rate.resetAt
    this.setStatus({
      state: low ? "paused" : "ok",
      login: result.login,
      remaining: rate?.remaining,
      limit: rate?.limit,
      used: this.spent.points,
      detail: low ? "GitHub's hourly budget is running low, waiting for it to reset" : undefined,
    })
  }

  private fail(err: unknown) {
    const e = err instanceof GithubError ? err : new GithubError(String(err), "network")
    if (e.kind === "no-cli" || e.kind === "logged-out") {
      // Nothing will change until gh is set up: Settings has a Retry button, otherwise try again in 10 min.
      this.pausedUntil = Date.now() + 10 * MINUTE
      this.setStatus({ state: e.kind, detail: e.message })
      return
    }
    if (e.kind === "rate-limited") {
      this.pausedUntil = e.retryAt ?? Date.now() + 5 * MINUTE
      this.setStatus({ ...this.status, state: "paused", detail: e.message })
      return
    }
    this.failures++
    this.pausedUntil = Date.now() + Math.min(15 * MINUTE, 30 * SECOND * 2 ** (this.failures - 1))
    this.setStatus({ ...this.status, state: "error", detail: e.message })
  }

  private scheduleNext() {
    const now = Date.now()
    if (this.due(now).length) return this.schedule(MIN_TICK)
    let next = Infinity
    for (const id of this.watched.keys()) next = Math.min(next, this.cache.get(id)?.next ?? now)
    if (next !== Infinity) this.schedule(Math.max(MIN_TICK, next - now))
  }

  private setStatus(status: GithubStatus) {
    this.status = status
    this.hooks.onStatus()
  }
}
