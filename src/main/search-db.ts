import { DatabaseSync } from "node:sqlite"
import type { ResourceItem, SearchHit } from "../shared/types"

// Bump to drop and rebuild the index (schema or extraction changes).
export const INDEX_VERSION = 1

/** Longer messages (pasted logs, huge prompts) are cut: they bloat the index and rarely matter for search. */
export const MAX_BODY = 16_000

/**
 * Queries rank only the newest CANDIDATES matching messages. FTS5 walks the
 * doclist in rowid order and stops early, so a query costs the same with 1k or
 * 1M messages (ranking every match grows linearly: ~200ms at 300k). Rowids are
 * derived from message time to make "newest" meaningful.
 */
const CANDIDATES = 2000

export function openSearchDb(path: string, opts: { readOnly?: boolean } = {}) {
  const db = new DatabaseSync(path, { readOnly: opts.readOnly })
  db.exec("PRAGMA busy_timeout = 2000")
  if (opts.readOnly) return db
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL")
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number }
  if (user_version !== INDEX_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS resource_mentions;
      DROP TABLE IF EXISTS resources;
      DROP TABLE IF EXISTS meta;
    `)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      updated INTEGER NOT NULL,
      -- session.updated as of the last completed index pass; NULL = never indexed
      indexed_updated INTEGER,
      -- messages created before this are indexed (in-progress replies hold it back)
      watermark INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created INTEGER NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      body, content='messages', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2', prefix='2 3'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF body ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
    END;
    -- One row per canonical resource (see src/shared/adapters). data: fields parsed from its URLs.
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      data TEXT NOT NULL
    );
    -- Which messages mention which resource; the session and time are copied in so scope queries skip messages.
    CREATE TABLE IF NOT EXISTS resource_mentions (
      message_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY (message_id, resource_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS mentions_session ON resource_mentions(session_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = ${INDEX_VERSION};
  `)
  return db
}

/** Every word must match, as a prefix ("xter" finds "xterm"). null when there's nothing searchable. */
export function toMatchQuery(query: string) {
  const terms = query
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `"${t.replaceAll('"', '""')}"*`)
  return terms.length && query.trim().length >= 2 ? terms.join(" ") : null
}

// Private-use markers around matches in snippets; the renderer turns them into <mark>.
export const MARK_START = "\uE000"
export const MARK_END = "\uE001"

type Candidate = { rowid: number; session_id: string; score: number }
type Detail = { rowid: number; session_id: string; role: string; created: number; snippet: string; title: string }

export class SearchReader {
  private candidates
  private snippets

  constructor(private db: DatabaseSync) {
    this.candidates = db.prepare(`
      SELECT f.rowid AS rowid, m.session_id AS session_id, f.score AS score
      FROM (
        SELECT rowid, bm25(messages_fts) AS score FROM messages_fts
        WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT ${CANDIDATES}
      ) f JOIN messages m ON m.rowid = f.rowid
    `)
    this.snippets = db.prepare(`
      SELECT messages_fts.rowid AS rowid, m.session_id AS session_id, m.role AS role, m.created AS created,
        snippet(messages_fts, 0, '${MARK_START}', '${MARK_END}', '…', 14) AS snippet,
        COALESCE(s.title, '') AS title
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ? AND messages_fts.rowid IN (SELECT value FROM json_each(?))
    `)
  }

  /** Best-matching message per session, best sessions first. */
  search(query: string, limit: number): SearchHit[] {
    const match = toMatchQuery(query)
    if (!match) return []
    let rows: Candidate[]
    try {
      rows = this.candidates.all(match) as Candidate[]
    } catch {
      return [] // malformed FTS syntax we didn't anticipate: no results beats an error
    }
    // bm25 is negative: lower is better. Keep each session's best message.
    const best = new Map<string, Candidate>()
    for (const row of rows) {
      const prev = best.get(row.session_id)
      if (!prev || row.score < prev.score) best.set(row.session_id, row)
    }
    const top = [...best.values()].sort((a, b) => a.score - b.score).slice(0, limit)
    if (!top.length) return []
    const details = new Map(
      (this.snippets.all(match, JSON.stringify(top.map((r) => r.rowid))) as Detail[]).map((d) => [d.rowid, d]),
    )
    return top.flatMap((r) => {
      const d = details.get(r.rowid)
      if (!d) return []
      return [
        {
          sessionID: d.session_id,
          title: d.title,
          role: d.role === "user" ? "user" : "assistant",
          created: d.created,
          snippet: d.snippet.replace(/\s+/g, " ").trim(),
        } satisfies SearchHit,
      ]
    })
  }
}

/** Most resources a panel query returns; newest mentions first. */
const RESOURCE_LIMIT = 500

type ResourceRow = {
  id: string
  type: string
  url: string
  data: string
  mentions: number
  sessions: number
  first: number
  last: number
  by_user: number
}

export class ResourceReader {
  private query

  constructor(db: DatabaseSync) {
    this.query = db.prepare(`
      SELECT r.id, r.type, r.url, r.data,
        count(*) AS mentions, count(DISTINCT m.session_id) AS sessions,
        min(m.created) AS first, max(m.created) AS last, max(m.role = 'user') AS by_user
      FROM resource_mentions m JOIN resources r ON r.id = m.resource_id
      WHERE m.session_id IN (SELECT value FROM json_each(?))
      GROUP BY r.id
      ORDER BY last DESC
      LIMIT ${RESOURCE_LIMIT}
    `)
  }

  /** Resources mentioned in any of these sessions. Cost grows with their mentions, not with the whole index. */
  list(sessionIDs: string[]): ResourceItem[] {
    if (!sessionIDs.length) return []
    return (this.query.all(JSON.stringify(sessionIDs)) as ResourceRow[]).map((r) => ({
      id: r.id,
      type: r.type,
      url: r.url,
      data: JSON.parse(r.data),
      mentions: r.mentions,
      sessions: r.sessions,
      first: r.first,
      last: r.last,
      sharedByYou: r.by_user === 1,
    }))
  }
}
