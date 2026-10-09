// WORKAROUND: opencode and fx wrap long lines themselves, so a URL split over two
// rows only links its first half. On ⌘-click we look the full URL up in the
// session's own text and only extend it when the next screen row confirms the
// continuation.
//
// Remove once both emit OSC 8 hyperlinks for wrapped URLs
// (https://github.com/anomalyco/opencode/issues/35649): delete this file and
// src/renderer/wrapped-links.ts, then the lines tagged `wrapped-links`.
import type { OpenCode } from "@opencode/client"
import { open, stat } from "node:fs/promises"
import { join } from "node:path"
import { harnessOf } from "../shared/types"
import { rawID, SESSIONS_DIR } from "./fx"

type Client = ReturnType<typeof OpenCode.make>
const URL_RE = /https?:\/\/[^\s"'<>`\\]+/g

type Entry = { updated: number; urls: Promise<string[]> }

/** fx: only the end of the log matters for what's on screen; keeps big sessions cheap. */
const TAIL_BYTES = 4 * 1024 * 1024

export class WrappedLinks {
  private cache = new Map<string, Entry>()

  constructor(
    private client: () => Client | undefined,
    /** Last activity time, used to know when the cached URLs are stale */
    private updatedAt: (sessionID: string) => number | undefined,
  ) {}

  /** Warms the URL list (on link hover) so the click itself is instant. */
  prefetch(sessionID: string) {
    void this.urls(sessionID).catch(() => {})
  }

  /**
   * `url` is what the terminal detected (possibly cut at the row's end), `next`
   * the first word of the following row. Returns the full URL, or `url` as is.
   */
  async resolve(sessionID: string | null, url: string, next: string): Promise<string> {
    if (!sessionID || !next) return url
    let urls: string[]
    try {
      urls = await this.urls(sessionID)
    } catch {
      return url
    }
    const matches = urls.filter((u) => {
      if (u.length <= url.length || !u.startsWith(url)) return false
      const rest = u.slice(url.length)
      return rest.startsWith(next) || next.startsWith(rest)
    })
    // Prefer the longest: a URL wrapped over 3+ rows only shows its middle on `next`.
    return matches.sort((a, b) => b.length - a.length)[0] ?? url
  }

  private urls(sessionID: string): Promise<string[]> {
    const updated = this.updatedAt(sessionID) ?? 0
    const cached = this.cache.get(sessionID)
    if (cached && cached.updated === updated) return cached.urls
    let urls: Promise<string[]>
    if (harnessOf(sessionID) === "fx") {
      urls = fxTail(sessionID).then((text) => {
        const found = new Set<string>()
        // URLs inside JSON strings: undo the escapes that matter for URLs.
        collect(text.replaceAll("\\/", "/").replaceAll("\\u0026", "&"), found)
        return [...found]
      })
    } else {
      const client = this.client()
      if (!client) return Promise.resolve([])
      urls = client.session.context({ sessionID }).then((messages) => {
        const found = new Set<string>()
        collect(messages, found)
        return [...found]
      })
    }
    this.cache.set(sessionID, { updated, urls })
    urls.catch(() => this.cache.delete(sessionID))
    // Only the sessions you're looking at matter; keep the cache small.
    if (this.cache.size > 5) this.cache.delete(this.cache.keys().next().value!)
    return urls
  }
}

function collect(value: unknown, out: Set<string>) {
  if (typeof value === "string") {
    for (const m of value.matchAll(URL_RE)) out.add(m[0].replace(/[.,;:!?)\]}>*_]+$/, ""))
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, out)
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collect(v, out)
  }
}

async function fxTail(sessionID: string) {
  const file = join(SESSIONS_DIR, rawID(sessionID), "events.jsonl")
  const { size } = await stat(file)
  const len = Math.min(size, TAIL_BYTES)
  const fh = await open(file, "r")
  try {
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString("utf8")
  } finally {
    await fh.close()
  }
}
