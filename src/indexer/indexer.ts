// Full-text indexer for session messages, from both harnesses. Runs in an Electron
// utility process so fetching, file reads, JSON parsing and SQLite writes never
// block the main process (which relays every keystroke and byte of TUI output).
//
// opencode:
//   launch / reconnect ─► reconcile: list root sessions, queue changed ones
//   event stream ───────► queue the session a turn/prompt landed in
//   queue ──────────────► index: fetch messages newer than its watermark, upsert
// fx (no server, files only):
//   launch ─────────────► reconcile: list ~/.fx/sessions (v1 folders + v2's index), queue every session
//   fs watcher / poll ──► queue the session whose log (or index line) changed
//   queue ──────────────► index: read its log from its byte offset (fx only appends)
//
// Work is proportional to what changed, not to how many sessions exist.
import { OpenCode, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { watch } from "node:fs"
import { open, readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { DatabaseSync, StatementSync } from "node:sqlite"
import { extractResources, RESOURCES_VERSION } from "../shared/adapters"
import { FX_PREFIX, type IndexerMessage, type IndexStatus } from "../shared/types"
import { MAX_BODY, openSearchDb } from "../main/search-db"
import { checkFx, fxID } from "../main/fx"
import { isV1Name, isV2Name, parseLogLines, readIndex, SESSIONS_DIR, sessionLog, type IndexEntry } from "../main/fx-store"

type Client = ReturnType<typeof OpenCode.make>
type Message = {
  id: string
  type: string
  time: { created: number; completed?: number }
  text?: string
  content?: { type: string; text?: string }[]
}

const CONCURRENCY = 2
const PAGE = 100
/** Re-read a little before the watermark, in case messages land slightly out of order. */
const MARGIN_MS = 60_000
/** Coalesce bursts of events for one session (a prompt followed quickly by its turn ending). */
const DEBOUNCE_MS = 1500
/** Messages per transaction when re-extracting resources; small enough to keep live indexing responsive. */
const REEXTRACT_CHUNK = 500

/** fx: bytes read per chunk, so a huge first pass doesn't hold everything in memory. */
const FX_CHUNK = 4 * 1024 * 1024
/** fx: how often sessions with a live fx process are checked for new lines (see FxIndexer.poll) */
const FX_POLL_MS = 5000

const post = (msg: IndexerMessage) => process.parentPort.postMessage(msg)
const log = (...args: unknown[]) => console.log("[ctrl indexer]", ...args)

/** Statements both harnesses share. */
function prepare(db: DatabaseSync) {
  return {
      upsertSession: db.prepare(`
        INSERT INTO sessions (id, title, directory, updated) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, directory = excluded.directory, updated = excluded.updated
      `),
      deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
      deleteMessages: db.prepare("DELETE FROM messages WHERE session_id = ?"),
      upsertMessage: db.prepare(`
        INSERT INTO messages (rowid, id, session_id, role, created, body) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body WHERE body != excluded.body
      `),
      upsertResource: db.prepare(`
        INSERT INTO resources (id, type, url, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET url = excluded.url, data = json_patch(resources.data, excluded.data)
      `),
      insertMention: db.prepare("INSERT OR IGNORE INTO resource_mentions VALUES (?, ?, ?, ?, ?)"),
      deleteMessageMentions: db.prepare("DELETE FROM resource_mentions WHERE message_id = ?"),
      deleteSessionMentions: db.prepare("DELETE FROM resource_mentions WHERE session_id = ?"),
  }
}

/**
 * A queue of sessions to index, a few at a time. Both harnesses have one; progress is
 * reported for both together.
 */
abstract class Queue {
  private pending = new Set<string>()
  private running = new Set<string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  total = 0
  done = 0
  protected base: ReturnType<typeof prepare>

  constructor(protected db: DatabaseSync) {
    this.base = prepare(db)
    queues.push(this)
  }

  protected abstract index(id: string): Promise<void>

  get busy() {
    return this.pending.size + this.running.size > 0
  }

  protected debounce(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        this.enqueue(id)
      }, DEBOUNCE_MS),
    )
  }

  protected enqueue(id: string) {
    if (this.pending.has(id)) return
    this.pending.add(id)
    this.total++
    this.pump()
  }

  private pump() {
    while (this.running.size < CONCURRENCY) {
      const id = [...this.pending].find((x) => !this.running.has(x))
      if (!id) break
      this.pending.delete(id)
      this.running.add(id)
      void this.index(id)
        .catch((err) => log(`index ${id} failed`, err))
        .finally(() => {
          this.running.delete(id)
          this.done++
          report()
          this.pump()
        })
    }
    report()
  }

  /** Replaces a message's resource mentions. Returns how many it has. */
  protected indexResources(messageID: string, sessionID: string, role: string, created: number, body: string) {
    this.base.deleteMessageMentions.run(messageID)
    const found = extractResources(body)
    for (const r of found) {
      this.base.upsertResource.run(r.key, r.type, r.url, JSON.stringify(r.data))
      this.base.insertMention.run(messageID, r.key, sessionID, role, created)
    }
    return found.length
  }

  /** Rowids follow message time (see CANDIDATES in search-db): created ms × 1000, bumped on the rare collision. */
  protected insertMessage(messageID: string, sessionID: string, role: string, created: number, body: string) {
    let rowid = created * 1000
    for (let attempt = 0; attempt < 1000; attempt++, rowid++) {
      try {
        this.base.upsertMessage.run(rowid, messageID, sessionID, role, created, body)
        return
      } catch (err) {
        if (!String(err).includes("UNIQUE constraint failed: messages.rowid")) throw err
      }
    }
  }

  protected removeSession(id: string) {
    this.base.deleteSessionMentions.run(id)
    this.base.deleteMessages.run(id)
    this.base.deleteSession.run(id)
  }

  protected tx(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      fn()
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }
}

const queues: Queue[] = []
let lastReport = 0

function report() {
  const busy = queues.some((q) => q.busy)
  const now = Date.now()
  if (busy && now - lastReport < 250) return
  lastReport = now
  if (!busy)
    for (const q of queues) {
      q.total = 0
      q.done = 0
    }
  const done = queues.reduce((n, q) => n + q.done, 0)
  const total = queues.reduce((n, q) => n + q.total, 0)
  post({ type: "status", status: { indexing: busy, done, total } satisfies IndexStatus })
}

/** opencode sessions ("ses_…"), through the opencode service. */
class OpencodeIndexer extends Queue {
  private client!: Client
  /** Sessions whose index must be rebuilt from scratch (revert, edited content). */
  private rebuild = new Set<string>()
  private stmt: Record<string, StatementSync>

  constructor(db: DatabaseSync) {
    super(db)
    this.stmt = {
      upsertSession: db.prepare(`
        INSERT INTO sessions (id, title, directory, updated) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, directory = excluded.directory, updated = excluded.updated
      `),
      rename: db.prepare("UPDATE sessions SET title = ? WHERE id = ?"),
      session: db.prepare("SELECT updated, indexed_updated, watermark FROM sessions WHERE id = ?"),
      // fx sessions have their own indexer (and never an indexed_updated).
      stale: db.prepare(
        `SELECT id FROM sessions WHERE id NOT LIKE '${FX_PREFIX}%' AND (indexed_updated IS NULL OR indexed_updated < updated) ORDER BY updated DESC`,
      ),
      allIDs: db.prepare(`SELECT id FROM sessions WHERE id NOT LIKE '${FX_PREFIX}%'`),
      deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
      deleteMessages: db.prepare("DELETE FROM messages WHERE session_id = ?"),
      upsertMessage: db.prepare(`
        INSERT INTO messages (rowid, id, session_id, role, created, body) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body WHERE body != excluded.body
      `),
      markIndexed: db.prepare("UPDATE sessions SET indexed_updated = ?, watermark = ? WHERE id = ?"),
      upsertResource: db.prepare(`
        INSERT INTO resources (id, type, url, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET url = excluded.url, data = json_patch(resources.data, excluded.data)
      `),
      insertMention: db.prepare("INSERT OR IGNORE INTO resource_mentions VALUES (?, ?, ?, ?, ?)"),
      deleteMessageMentions: db.prepare("DELETE FROM resource_mentions WHERE message_id = ?"),
      deleteSessionMentions: db.prepare("DELETE FROM resource_mentions WHERE session_id = ?"),
      getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      messagesAfter: db.prepare(
        "SELECT rowid, id, session_id, role, created, body FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?",
      ),
      resetWatermark: db.prepare("UPDATE sessions SET watermark = 0, indexed_updated = NULL WHERE id = ?"),
    }
  }

  async start() {
    void this.reextract().catch((err) => log("resource re-extraction failed", err))
    await this.connect()
    void this.listen()
  }

  private async connect() {
    while (true) {
      try {
        const endpoint = await Service.ensure()
        this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        return
      } catch (err) {
        log("opencode not reachable, retrying", err)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }

  /**
   * When the resource types changed (RESOURCES_VERSION), rebuild resources from the stored message text.
   * Local only: no refetching. Chunked, so live indexing keeps going in between.
   */
  private async reextract() {
    const row = this.stmt.getMeta.get("resources_version") as { value: string } | undefined
    if (row?.value === String(RESOURCES_VERSION)) return
    const started = Date.now()
    this.tx(() => {
      this.db.exec("DELETE FROM resource_mentions")
      this.db.exec("DELETE FROM resources")
    })
    let after = 0
    let count = 0
    while (true) {
      const rows = this.stmt.messagesAfter.all(after, REEXTRACT_CHUNK) as {
        rowid: number
        id: string
        session_id: string
        role: string
        created: number
        body: string
      }[]
      if (!rows.length) break
      this.tx(() => {
        for (const r of rows) this.indexResources(r.id, r.session_id, r.role, r.created, r.body)
      })
      after = rows.at(-1)!.rowid
      count += rows.length
      await new Promise((r) => setImmediate(r))
    }
    this.stmt.setMeta.run("resources_version", String(RESOURCES_VERSION))
    log(`re-extracted resources from ${count} messages in ${Date.now() - started}ms`)
    post({ type: "resources", sessionIDs: null })
  }

  /** Mirror the session list, drop deleted sessions, queue everything that changed since its last pass. */
  private async reconcile() {
    const sessions: SessionInfo[] = []
    let res = await this.client.session.list({ parentID: "null", limit: 300 })
    sessions.push(...res.data)
    while (res.cursor.next && res.data.length > 0) {
      res = await this.client.session.list({ cursor: res.cursor.next })
      sessions.push(...res.data)
    }
    const live = new Set<string>()
    this.tx(() => {
      for (const s of sessions) {
        if (s.parentID) continue
        live.add(s.id)
        this.stmt.upsertSession.run(s.id, s.title || "New session", s.location.directory, s.time.updated)
      }
      for (const { id } of this.stmt.allIDs.all() as { id: string }[]) {
        if (!live.has(id)) this.removeSession(id)
      }
    })
    const stale = (this.stmt.stale.all() as { id: string }[]).map((r) => r.id)
    log(`reconciled ${live.size} sessions, ${stale.length} to index`)
    for (const id of stale) this.enqueue(id)
  }

  private async listen() {
    while (true) {
      try {
        const events = this.client.event.subscribe()
        // Subscribe first, then reconcile, so nothing that happens in between is missed.
        void this.reconcile().catch((err) => log("reconcile failed", err))
        for await (const event of events) this.onEvent(event as { type: string; data?: Record<string, unknown> })
      } catch (err) {
        log("event stream failed, retrying", err)
      }
      await new Promise((r) => setTimeout(r, 2000))
      // The service may have been replaced (ctrl restarts it) and moved to a new URL and password.
      await this.connect()
    }
  }

  private onEvent(event: { type: string; data?: Record<string, unknown> }) {
    const id = event.data?.sessionID
    if (typeof id !== "string") return
    switch (event.type) {
      case "session.created": {
        const d = event.data as { parentID?: string; title?: string; location: { directory: string } }
        if (!d.parentID) this.stmt.upsertSession.run(id, d.title || "New session", d.location.directory, Date.now())
        return
      }
      case "session.renamed":
        this.stmt.rename.run(String(event.data!.title), id)
        return
      case "session.deleted":
        this.tx(() => this.removeSession(id))
        return
      case "session.revert.committed":
      case "session.message.content.updated":
        this.rebuild.add(id)
        this.debounce(id)
        return
      case "session.inbox.delivered":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.debounce(id)
        return
    }
  }

  protected async index(id: string) {
    const rebuilt = this.rebuild.delete(id)
    if (rebuilt)
      this.tx(() => {
        this.stmt.deleteMessages.run(id)
        this.stmt.deleteSessionMentions.run(id)
        this.stmt.resetWatermark.run(id)
      })
    const row = this.stmt.session.get(id) as { updated: number; watermark: number } | undefined
    if (!row) return // not a root session we track (subagent, or deleted)
    const since = row.watermark ? row.watermark - MARGIN_MS : 0

    // Newest first, stopping at the watermark: an already-indexed session costs one small request.
    const fresh: Message[] = []
    let res = await this.client.message.list({ sessionID: id, limit: PAGE, order: "desc" })
    while (true) {
      const page = res.data as unknown as Message[]
      let reachedOld = false
      for (const m of page) {
        if (m.time.created < since) reachedOld = true
        else fresh.push(m)
      }
      if (reachedOld || !res.cursor.next || page.length === 0) break
      res = await this.client.message.list({ sessionID: id, cursor: res.cursor.next })
    }

    let watermark = row.watermark
    let oldestIncomplete = Infinity
    const docs: { m: Message; role: string; body: string }[] = []
    for (const m of fresh) {
      watermark = Math.max(watermark, m.time.created)
      if (m.type === "user") {
        if (m.text?.trim()) docs.push({ m, role: "user", body: m.text })
      } else if (m.type === "assistant") {
        // Still streaming: index it on a later pass, once it's complete.
        if (!m.time.completed) {
          oldestIncomplete = Math.min(oldestIncomplete, m.time.created)
          continue
        }
        const body = (m.content ?? [])
          .filter((c) => c.type === "text" && c.text?.trim())
          .map((c) => c.text)
          .join("\n\n")
        if (body) docs.push({ m, role: "assistant", body })
      }
    }
    if (oldestIncomplete !== Infinity) watermark = Math.min(watermark, oldestIncomplete)

    let resources = 0
    this.tx(() => {
      for (const { m, role, body } of docs) {
        const text = body.slice(0, MAX_BODY)
        this.insertMessage(m.id, id, role, m.time.created, text)
        resources += this.indexResources(m.id, id, role, m.time.created, text)
      }
      this.stmt.markIndexed.run(row.updated, watermark, id)
    })
    if (resources || rebuilt) post({ type: "resources", sessionIDs: [id] })
  }

}

/** sessions.watermark for fx rows: which layout `offset` counts bytes of (fx-store.ts). */
const FX_LAYOUT = { v1: 0, v2: 2 } as const
/** v2 logs not touched for this long, and not closed cleanly (fx crashed), stop being polled. */
const FX_LIVE_MAX_AGE_MS = 24 * 3600_000

/** fx sessions ("fx:<id>"), straight from ~/.fx/sessions (both layouts, see src/main/fx-store.ts). */
class FxIndexer extends Queue {
  private stmt: Record<string, StatementSync>
  /** Sessions with a live fx process (v1: owner.live) or that may have one (v2: log not closed), and their log size as of the last pass */
  private live = new Map<string, { pid?: number; size: number }>()
  private fxIndex = new Map<string, IndexEntry>()
  private fxIndexOffset = 0

  constructor(db: DatabaseSync) {
    super(db)
    this.stmt = {
      session: db.prepare("SELECT offset, watermark FROM sessions WHERE id = ?"),
      allIDs: db.prepare(`SELECT id FROM sessions WHERE id LIKE '${FX_PREFIX}%'`),
      setOffset: db.prepare("UPDATE sessions SET offset = ?, watermark = ? WHERE id = ?"),
    }
  }

  async start() {
    // fx is optional: wait for it rather than watching a folder that may never exist.
    while ((await checkFx()).state !== "ok") await new Promise((r) => setTimeout(r, 60_000))
    // Watch first, then reconcile, so nothing that happens in between is missed.
    this.watch()
    setInterval(() => void this.poll(), FX_POLL_MS)
    await this.reconcile().catch((err) => log("fx reconcile failed", err))
  }

  /**
   * fx keeps its logs (and v2's index) open and appends to them, and macOS only reports those writes once
   * the file is closed (when fx quits). So the watcher misses turns while fx runs: check those on a timer.
   */
  private async poll() {
    await this.readFxIndex()
    for (const [id, { pid, size }] of this.live) {
      if (pid !== undefined && !alive(pid)) {
        this.live.delete(id)
        this.debounce(id)
        continue
      }
      const now = await stat(sessionLog(id.slice(FX_PREFIX.length)).file).then((s) => s.size, () => 0)
      if (now !== size) this.debounce(id)
    }
  }

  /** New index lines: the root sessions they're about get indexed (title, folder, or a new session). */
  private async readFxIndex() {
    const r = await readIndex(this.fxIndex, this.fxIndexOffset).catch(() => undefined)
    if (!r) return
    this.fxIndexOffset = r.offset
    for (const id of r.reset ? this.fxIndex.keys() : r.changed) if (this.fxIndex.get(id)?.role !== "child") this.debounce(fxID(id))
  }

  private watch() {
    try {
      watch(SESSIONS_DIR, { recursive: true }, (_event, file) => {
        if (!file) return
        const [first, id, name] = String(file).split("/")
        if (first === "v2") {
          if (id === "index.jsonl") void this.readFxIndex()
          else if (id && isV2Name(id) && (name === "log.jsonl" || name === undefined)) this.debounce(fxID(id))
          return
        }
        if (!isV1Name(first)) return
        if (id === "events.jsonl" || id === "session.json" || id === undefined) this.debounce(fxID(first))
      })
    } catch (err) {
      log("can't watch fx sessions, retrying", err)
      setTimeout(() => this.watch(), 5000)
    }
  }

  /** Drops sessions that no longer exist and queues every session (a no-op when its log didn't grow). */
  private async reconcile() {
    await this.readFxIndex()
    const v1 = (await readdir(SESSIONS_DIR).catch(() => [] as string[])).filter(isV1Name)
    const v2 = [...this.fxIndex.values()].filter((e) => e.role === "root").map((e) => e.id)
    const ids = new Set([...v1, ...v2].map(fxID))
    this.tx(() => {
      for (const { id } of this.stmt.allIDs.all() as { id: string }[]) if (!ids.has(id)) this.removeSession(id)
    })
    log(`reconciling ${ids.size} fx sessions`)
    for (const id of ids) this.enqueue(id)
  }

  /** Title, folder and update time, and who has it open (v1 only), or undefined when it's gone or a subagent. */
  private async meta(raw: string, layout: "v1" | "v2", file: string) {
    const size = (await stat(file)).size
    if (layout === "v2") {
      const entry = this.fxIndex.get(raw)
      if (!entry || entry.role === "child") return undefined
      return { title: entry.title, directory: entry.workspace, updated: entry.updated, size, pid: undefined }
    }
    const dir = join(SESSIONS_DIR, raw)
    const meta = JSON.parse(await readFile(join(dir, "session.json"), "utf8")) as {
      title?: string
      workspace_root?: string
      updated_at_ms?: number
      subagent_child?: boolean
    }
    if (meta.subagent_child) return undefined
    const owner = await readFile(join(dir, "owner.live"), "utf8").then((t) => JSON.parse(t) as { pid?: unknown }, () => undefined)
    const pid = typeof owner?.pid === "number" && alive(owner.pid) ? owner.pid : undefined
    return { title: meta.title, directory: meta.workspace_root ?? "", updated: meta.updated_at_ms ?? 0, size, pid }
  }

  protected async index(id: string) {
    const raw = id.slice(FX_PREFIX.length)
    const { layout, file } = sessionLog(raw)
    let meta: Awaited<ReturnType<FxIndexer["meta"]>>
    try {
      meta = await this.meta(raw, layout, file)
    } catch {
      meta = undefined
    }
    if (!meta) {
      // Gone, never used, or a subagent: forget it.
      this.live.delete(id)
      if (this.stmt.session.get(id)) this.tx(() => this.removeSession(id))
      return
    }
    const { size } = meta
    this.base.upsertSession.run(id, meta.title || "New session", meta.directory, meta.updated)
    const row = this.stmt.session.get(id) as { offset: number; watermark: number }
    let offset = row.offset
    let rebuilt = false
    // The log shrank (rewritten or replaced), or fx converted the session to v2: start over.
    if (size < offset || row.watermark !== FX_LAYOUT[layout]) {
      this.tx(() => {
        this.base.deleteMessages.run(id)
        this.base.deleteSessionMentions.run(id)
      })
      offset = 0
      rebuilt = true
    }
    if (size === offset && !rebuilt) return this.track(id, layout, file, size, meta.pid)

    let resources = 0
    const fh = await open(file, "r")
    try {
      let carry = Buffer.alloc(0)
      while (offset + carry.length < size) {
        const len = Math.min(FX_CHUNK, size - offset - carry.length)
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, offset + carry.length)
        const data = Buffer.concat([carry, buf])
        // Only whole lines: the last one may still be being written.
        const end = data.lastIndexOf(0x0a)
        if (end === -1) {
          carry = data
          continue
        }
        const docs = parseLogLines(layout, data.subarray(0, end).toString("utf8"))
        const consumed = offset + end + 1
        this.tx(() => {
          for (const d of docs) {
            const messageID = `${id}:${d.seq}`
            const text = d.body.slice(0, MAX_BODY)
            this.insertMessage(messageID, id, d.role, d.created, text)
            resources += this.indexResources(messageID, id, d.role, d.created, text)
          }
          this.stmt.setOffset.run(consumed, FX_LAYOUT[layout], id)
        })
        offset = consumed
        carry = data.subarray(end + 1)
        await new Promise((r) => setImmediate(r))
      }
    } finally {
      await fh.close()
    }
    if (resources || rebuilt) post({ type: "resources", sessionIDs: [id] })
    await this.track(id, layout, file, size, meta.pid)
  }

  /**
   * Polls the sessions fx may be appending to. v1: a live owner.live. v2: a log that doesn't end with
   * `closed` (fx's clean exit) and changed recently; fx crashing leaves no `closed`, hence the age limit.
   */
  private async track(id: string, layout: "v1" | "v2", file: string, size: number, pid?: number) {
    if (layout === "v1") {
      if (pid !== undefined) this.live.set(id, { pid, size })
      else this.live.delete(id)
      return
    }
    const st = await stat(file).catch(() => undefined)
    const open = st && Date.now() - st.mtimeMs < FX_LIVE_MAX_AGE_MS && !(await endsClosed(file, size))
    if (open) this.live.set(id, { size })
    else this.live.delete(id)
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A v2 log whose last line is `closed`: fx closed it cleanly, nothing more will be appended until it's reopened. */
async function endsClosed(file: string, size: number) {
  if (!size) return false
  const len = Math.min(size, 512)
  const fh = await open(file, "r")
  try {
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const text = buf.toString("utf8").replace(/\n+$/, "")
    return /"kind":"closed"/.test(text.slice(text.lastIndexOf("\n") + 1))
  } finally {
    await fh.close()
  }
}

process.parentPort.once("message", (e: { data: { type: "start"; dbPath: string } }) => {
  const db = openSearchDb(e.data.dbPath)
  post({ type: "ready" })
  void new OpencodeIndexer(db).start()
  void new FxIndexer(db).start()
})
