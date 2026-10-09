import { DatabaseSync } from "node:sqlite"
import {
  AdapterError,
  DAY,
  MINUTE,
  SECOND,
  type AdapterMode,
  type CachePolicy,
  type MetaRequest,
  type ResourceAdapter,
} from "../../shared/adapters/adapter"
import { adapterMode } from "../../shared/adapters"
import type { AdapterInfo, AdapterStatus, ResourceItem, ResourceMeta } from "../../shared/types"
import { runCli } from "./cli"

/** Bump to drop cached details (their shape changed). */
const CACHE_VERSION = 2
/** Never wake up more often than this, even if something is due sooner. */
const MIN_TICK = 5 * SECOND
/** Longest sleep: setTimeout misfires past ~24.8 days, and waking up hourly costs nothing. */
const MAX_TICK = 60 * MINUTE
/** Delay after a watched session's run ends, so the indexer and the services have settled. */
const AFTER_RUN = 4 * SECOND

type Cached = { meta: ResourceMeta; cache: CachePolicy }
type Watched = MetaRequest & { last: number }

type LiveAdapter = ResourceAdapter & { live: NonNullable<ResourceAdapter["live"]> }

/** A live adapter's scheduling state. */
type Runner = {
  adapter: LiveAdapter
  busy: boolean
  /** No requests before this (rate limit, auth problem, errors) */
  pausedUntil: number
  failures: number
  status: AdapterStatus
  checking?: Promise<void>
}

const nextFetch = (c: Cached) => c.meta.fetched + c.cache.maxAge

/**
 * Live details for the resources on screen, from whichever adapter handles
 * each type. Only fetches while the panel is open and the window focused, only
 * what's due by the adapter's cache policy, in batches per adapter. Cached on
 * disk, so reopening the panel or restarting ctrl shows details instantly.
 */
export class AdapterService {
  private db: DatabaseSync
  private cache = new Map<string, Cached>()
  private adapterList: ResourceAdapter[]
  private runners: Runner[]
  private byType = new Map<string, Runner>()
  private modes: Record<string, AdapterMode>
  private watched = new Map<string, Watched>()
  private watchedSessions = new Set<string>()
  private focused = false
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    dbPath: string,
    adapters: ResourceAdapter[],
    modes: Record<string, AdapterMode>,
    private hooks: {
      /** Resources of these sessions, from the search index */
      list(sessionIDs: string[]): ResourceItem[]
      onMeta(metas: Record<string, ResourceMeta>): void
      onStatus(): void
    },
  ) {
    this.modes = modes
    this.adapterList = adapters
    this.runners = adapters
      .filter((a): a is LiveAdapter => !!a.live)
      .map((adapter) => ({ adapter, busy: false, pausedUntil: 0, failures: 0, status: { state: "checking" } }))
    for (const r of this.runners) for (const type of r.adapter.types) this.byType.set(type.id, r)

    this.db = new DatabaseSync(dbPath)
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    if (user_version !== CACHE_VERSION) this.db.exec("DROP TABLE IF EXISTS resource_meta")
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- max_age NULL = Infinity (SQLite has none)
      CREATE TABLE IF NOT EXISTS resource_meta (
        id TEXT PRIMARY KEY,
        meta TEXT NOT NULL,
        max_age INTEGER,
        on_mention INTEGER NOT NULL
      );
      PRAGMA user_version = ${CACHE_VERSION};
    `)
    for (const row of this.db.prepare("SELECT id, meta, max_age, on_mention FROM resource_meta").all() as {
      id: string
      meta: string
      max_age: number | null
      on_mention: number
    }[])
      this.cache.set(row.id, {
        meta: JSON.parse(row.meta),
        cache: { maxAge: row.max_age ?? Infinity, refreshOnMention: !!row.on_mention },
      })
  }

  get adapters(): AdapterInfo[] {
    return this.adapterList.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      types: a.types.map((t) => t.id),
      cli: a.live?.cli,
      mode: adapterMode(a, this.modes),
      status: this.runners.find((r) => r.adapter === a)?.status,
    }))
  }

  /** Whether resources of this type are shown at all (their adapter isn't off). */
  shows(type: string) {
    const a = this.adapterList.find((a) => a.types.some((t) => t.id === type))
    return !a || adapterMode(a, this.modes) !== "off"
  }

  /** Cached details, if an adapter fetching live details handles this resource's type. */
  get(item: { id: string; type: string }) {
    return this.runnerFor(item.type) ? this.cache.get(item.id)?.meta : undefined
  }

  setModes(modes: Record<string, AdapterMode>) {
    this.modes = modes
    this.refreshWatched()
  }

  /**
   * Checks each CLI is installed and logged in (Settings' status), whatever
   * the adapter's mode, so Settings can tell whether turning it on would work.
   */
  check(id?: string) {
    return Promise.all(this.runners.filter((r) => !id || r.adapter.id === id).map((r) => this.checkOne(r)))
  }

  private checkOne(r: Runner) {
    r.checking ??= (async () => {
      try {
        const { account } = await r.adapter.live.check({ run: runCli })
        // Set up since the last failure: fetch again right away.
        if (r.status.state !== "ok" && r.status.state !== "paused") {
          r.pausedUntil = 0
          r.failures = 0
          this.schedule(0)
        }
        if (r.status.state !== "paused") this.setStatus(r, { state: "ok", account: account ?? r.status.account })
      } catch (err) {
        const e = err instanceof AdapterError ? err : new AdapterError(String(err), "network")
        if (e.kind === "rate-limited") return
        this.setStatus(r, { state: e.kind === "network" ? "error" : e.kind, detail: e.message })
      } finally {
        r.checking = undefined
      }
    })()
    return r.checking
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

  /** A run just ended in these sessions: the agent may have pushed, merged, deployed or posted. */
  runsEnded(sessionIDs: string[]) {
    if (!sessionIDs.some((id) => this.watchedSessions.has(id))) return
    const soon = Date.now() + AFTER_RUN
    for (const id of this.watched.keys()) {
      const c = this.cache.get(id)
      // Only things that change on their own; names and final states won't move because of a run.
      if (c && c.cache.maxAge < DAY && nextFetch(c) > soon) c.cache = { ...c.cache, maxAge: soon - c.meta.fetched }
    }
    this.schedule(AFTER_RUN)
  }

  setFocused(focused: boolean) {
    this.focused = focused
    if (focused) this.schedule(0)
    else clearTimeout(this.timer)
  }

  /** Settings → Check again. */
  async retry(id: string) {
    const r = this.runners.find((r) => r.adapter.id === id)
    if (!r) return
    r.pausedUntil = 0
    r.failures = 0
    await this.checkOne(r)
    this.schedule(0)
  }

  stop() {
    clearTimeout(this.timer)
    this.db.close()
  }

  private runnerFor(type: string) {
    const r = this.byType.get(type)
    return r && adapterMode(r.adapter, this.modes) === "live" ? r : undefined
  }

  private refreshWatched() {
    const items = this.watchedSessions.size ? this.hooks.list([...this.watchedSessions]) : []
    this.watched = new Map(
      items.filter((i) => this.runnerFor(i.type)).map((i) => [i.id, { id: i.id, type: i.type, data: i.data, last: i.last }]),
    )
    this.schedule(0)
  }

  /** When this resource should be fetched: now if never fetched or mentioned since, else per its cache policy. */
  private dueAt(w: Watched, now: number) {
    const c = this.cache.get(w.id)
    if (!c || (c.cache.refreshOnMention && w.last > c.meta.fetched)) return now
    return nextFetch(c)
  }

  private due(r: Runner, now: number) {
    return [...this.watched.values()]
      .filter((w) => this.byType.get(w.type) === r && this.dueAt(w, now) <= now)
      .sort((a, b) => b.last - a.last)
  }

  /** Sleeps until the soonest adapter has something due and isn't paused. */
  private schedule(delay: number) {
    clearTimeout(this.timer)
    if (!this.focused || !this.watched.size) return
    const now = Date.now()
    let at = Infinity
    for (const w of this.watched.values()) {
      const r = this.runnerFor(w.type)!
      at = Math.min(at, Math.max(this.dueAt(w, now), r.pausedUntil))
    }
    if (at === Infinity) return
    this.timer = setTimeout(() => void this.tick(), Math.min(MAX_TICK, Math.max(delay, at - now, 0)))
  }

  private async tick() {
    const now = Date.now()
    await Promise.all(
      this.runners.map(async (r) => {
        if (r.busy || now < r.pausedUntil || adapterMode(r.adapter, this.modes) !== "live") return
        const batch = this.due(r, now).slice(0, r.adapter.live.batchSize)
        if (!batch.length) return
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
    const result = await r.adapter.live.fetch(batch, { run: runCli })
    const fetched = Date.now()
    const insert = this.db.prepare(
      `INSERT INTO resource_meta (id, meta, max_age, on_mention) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, max_age = excluded.max_age, on_mention = excluded.on_mention`,
    )
    const changed: Record<string, ResourceMeta> = {}
    for (const w of batch) {
      const got = result.items.get(w.id) ?? { meta: { missing: true }, cache: { maxAge: DAY, refreshOnMention: true } }
      const entry: Cached = { meta: { ...got.meta, fetched }, cache: got.cache }
      this.cache.set(w.id, entry)
      const maxAge = Number.isFinite(entry.cache.maxAge) ? entry.cache.maxAge : null
      insert.run(w.id, JSON.stringify(entry.meta), maxAge, entry.cache.refreshOnMention ? 1 : 0)
      changed[w.id] = entry.meta
    }
    this.hooks.onMeta(changed)
    this.setStatus(r, { state: "ok", account: result.account ?? r.status.account })
  }

  private fail(r: Runner, err: unknown) {
    const e = err instanceof AdapterError ? err : new AdapterError(String(err), "network")
    if (e.kind === "no-cli" || e.kind === "logged-out") {
      // Nothing changes until the CLI is set up: Settings has Retry, otherwise try again in 10 min.
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

  private setStatus(r: Runner, status: AdapterStatus) {
    r.status = status
    this.hooks.onStatus()
  }
}
