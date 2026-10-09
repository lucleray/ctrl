// Full-text indexer for session messages, from both harnesses. Runs in an Electron
// utility process so fetching, file reads, JSON parsing and SQLite writes never
// block the main process (which relays every keystroke and byte of TUI output).
//
// opencode:
//   launch / reconnect ─► reconcile: list root sessions, queue changed ones
//   event stream ───────► queue the session a turn/prompt landed in
//   queue ──────────────► index: fetch messages newer than its watermark, upsert
// fx (no server, files only):
//   launch ─────────────► reconcile: list ~/.fx/sessions, queue every session
//   fs watcher ─────────► queue the session whose events.jsonl changed
//   queue ──────────────► index: read events.jsonl from its byte offset (fx only appends)
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
import { checkFx, fxID, SESSIONS_DIR } from "../main/fx"

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
    while (true) {
      try {
        const endpoint = await Service.ensure()
        this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        break
      } catch (err) {
        log("opencode not reachable, retrying", err)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    void this.listen()
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

type FxEvent = { seq?: number; timestamp_ms?: number; event?: Record<string, { text?: unknown } | undefined> }

/** fx sessions ("fx:<id>"), straight from ~/.fx/sessions. */
class FxIndexer extends Queue {
  private stmt: Record<string, StatementSync>

  constructor(db: DatabaseSync) {
    super(db)
    this.stmt = {
      session: db.prepare("SELECT offset FROM sessions WHERE id = ?"),
      allIDs: db.prepare(`SELECT id FROM sessions WHERE id LIKE '${FX_PREFIX}%'`),
      setOffset: db.prepare("UPDATE sessions SET offset = ? WHERE id = ?"),
    }
  }

  async start() {
    // fx is optional: wait for it rather than watching a folder that may never exist.
    while ((await checkFx()).state !== "ok") await new Promise((r) => setTimeout(r, 60_000))
    // Watch first, then reconcile, so nothing that happens in between is missed.
    this.watch()
    await this.reconcile().catch((err) => log("fx reconcile failed", err))
  }

  private watch() {
    try {
      watch(SESSIONS_DIR, { recursive: true }, (_event, file) => {
        if (!file) return
        const [id, name] = String(file).split("/")
        if (name === "events.jsonl" || name === "session.json" || name === undefined) this.debounce(fxID(id))
      })
    } catch (err) {
      log("can't watch fx sessions, retrying", err)
      setTimeout(() => this.watch(), 5000)
    }
  }

  /** Drops sessions that no longer exist and queues every session (a no-op when its log didn't grow). */
  private async reconcile() {
    const ids = new Set((await readdir(SESSIONS_DIR).catch(() => [] as string[])).map(fxID))
    this.tx(() => {
      for (const { id } of this.stmt.allIDs.all() as { id: string }[]) if (!ids.has(id)) this.removeSession(id)
    })
    log(`reconciling ${ids.size} fx sessions`)
    for (const id of ids) this.enqueue(id)
  }

  protected async index(id: string) {
    const dir = join(SESSIONS_DIR, id.slice(FX_PREFIX.length))
    let meta: { title?: string; workspace_root?: string; updated_at_ms?: number; subagent_child?: boolean }
    let size: number
    try {
      meta = JSON.parse(await readFile(join(dir, "session.json"), "utf8"))
      size = (await stat(join(dir, "events.jsonl"))).size
    } catch {
      // Gone (or never used): forget it.
      if (this.stmt.session.get(id)) this.tx(() => this.removeSession(id))
      return
    }
    if (meta.subagent_child) return
    this.base.upsertSession.run(id, meta.title || "New session", meta.workspace_root ?? "", meta.updated_at_ms ?? 0)
    let offset = (this.stmt.session.get(id) as { offset: number }).offset
    let rebuilt = false
    if (size < offset) {
      // The log shrank (rewritten or replaced): start over.
      this.tx(() => {
        this.base.deleteMessages.run(id)
        this.base.deleteSessionMentions.run(id)
      })
      offset = 0
      rebuilt = true
    }
    if (size === offset && !rebuilt) return

    let resources = 0
    const fh = await open(join(dir, "events.jsonl"), "r")
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
        const docs = parseFxLines(data.subarray(0, end).toString("utf8"))
        const consumed = offset + end + 1
        this.tx(() => {
          for (const d of docs) {
            const messageID = `${id}:${d.seq}`
            const text = d.body.slice(0, MAX_BODY)
            this.insertMessage(messageID, id, d.role, d.created, text)
            resources += this.indexResources(messageID, id, d.role, d.created, text)
          }
          this.stmt.setOffset.run(consumed, id)
        })
        offset = consumed
        carry = data.subarray(end + 1)
        await new Promise((r) => setImmediate(r))
      }
    } finally {
      await fh.close()
    }
    if (resources || rebuilt) post({ type: "resources", sessionIDs: [id] })
  }
}

/** Your prompts (and steering) and the assistant's text; tool calls and results are skipped. */
function parseFxLines(text: string) {
  const docs: { seq: number; role: "user" | "assistant"; created: number; body: string }[] = []
  for (const line of text.split("\n")) {
    // Cheap prefilter: most lines are tool calls/results.
    if (!/"event":\{"(user|assistant|steering)"/.test(line.slice(0, 200))) continue
    let e: FxEvent
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const [kind, payload] = Object.entries(e.event ?? {})[0] ?? []
    const body = typeof payload?.text === "string" ? payload.text.trim() : ""
    if (!body || typeof e.seq !== "number") continue
    docs.push({ seq: e.seq, role: kind === "assistant" ? "assistant" : "user", created: e.timestamp_ms ?? 0, body })
  }
  return docs
}

process.parentPort.once("message", (e: { data: { type: "start"; dbPath: string } }) => {
  const db = openSearchDb(e.data.dbPath)
  post({ type: "ready" })
  void new OpencodeIndexer(db).start()
  void new FxIndexer(db).start()
})
