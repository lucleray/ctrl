// Resource adapters: one per service (GitHub, Slack, Notion…). An adapter
// declares the resource types it recognizes in chat links (URL → canonical
// identity, icon, offline title) and, optionally, how to fetch live details
// for them through the service's own CLI.
//
// This module runs everywhere: the indexer parses links with it, the renderer
// shows icons and titles, the main process fetches. So adapters import nothing
// from Node: `live.fetch` gets a CLI runner from the main process instead.

import type { ResourceMeta, Tone } from "../types"

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Fields parsed from the URL. Parsers omit what the URL doesn't say, so merging keeps what earlier URLs said. */
export type ResourceData = Record<string, string>

export type ParsedResource = {
  type: string
  /** Canonical identity, unique across types: "github-pr:vercel/infra#36612" */
  key: string
  /** Canonical URL to open */
  url: string
  data: ResourceData
}

/** A kind of link, e.g. a GitHub PR. Parsing never makes requests: everything comes from the URL. */
export type ResourceType = {
  id: string
  /** Panel group heading */
  label: string
  /** Icon name in renderer/icons.tsx */
  icon: string
  /** null when the URL isn't this type */
  parse(url: URL): { identity: string; url: string; data: ResourceData } | null
  /** Display without fetching anything */
  describe(data: ResourceData): { title: string; subtitle?: string }
}

/** A resource to fetch: its key, type and the fields its URL gave. */
export type MetaRequest = { id: string; type: string; data: ResourceData }

/**
 * How long live details may be cached. The service caches and refetches
 * accordingly; adapters never cache themselves.
 */
export type CachePolicy = {
  /** Refetch after this long; Infinity = never on a timer */
  maxAge: number
  /**
   * Refetch when the resource is mentioned again after the fetch (a new
   * session shares it, an agent just merged or deployed it). Off for details
   * that can't change anymore.
   */
  refreshOnMention: boolean
}

export type Fetched = { meta: Omit<ResourceMeta, "fetched">; cache: CachePolicy }

export type AdapterResult = {
  /** One entry per requested resource; a resource left out counts as missing */
  items: Map<string, Fetched>
  /** Who the CLI is logged in as, when the response says */
  account?: string
}

export type CliResult = { code: number | null; stdout: string; stderr: string }

/** Runs a CLI without a terminal (src/main/adapters/cli.ts). */
export type RunCli = (command: string, args: string[], opts?: { timeout?: number; loginPrompt?: RegExp }) => Promise<CliResult>

export interface ResourceAdapter {
  id: string
  name: string
  /** What it adds, shown in Settings */
  description: string
  /** Kinds of links it recognizes, in priority order (the first type that parses a URL wins) */
  types: ResourceType[]
  /** Live details. Leave it out to only collect and show links, without fetching anything. */
  live?: {
    /** The CLI whose login it uses, for Settings' setup hints */
    cli: { command: string; install: string; login: string }
    /** Most resources per fetch() call */
    batchSize: number
    fetch(batch: MetaRequest[], ctx: { run: RunCli }): Promise<AdapterResult>
  }
}

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly kind: "no-cli" | "logged-out" | "rate-limited" | "network",
    /** When to try again (rate limits) */
    readonly retryAt?: number,
  ) {
    super(message)
  }
}

// ---------- cache policies ----------

/** Details that won't change again (merged PRs, finished builds) */
export const FINAL: CachePolicy = { maxAge: Infinity, refreshOnMention: false }
/** Details that rarely change: names, titles. Kept until mentioned again. */
export const UNTIL_MENTIONED: CachePolicy = { maxAge: Infinity, refreshOnMention: true }
export const every = (maxAge: number): CachePolicy => ({ maxAge, refreshOnMention: true })

export const missing = (): Fetched => ({ meta: { missing: true }, cache: every(DAY) })

// ---------- display helpers ----------

export type Chip = NonNullable<ResourceMeta["chips"]>[number]
export const chip = (text: string, tone: Tone, title?: string): Chip => ({ text, tone, title })
/** Chips whose condition held: `[cond && chip(...), ...]` */
export const chips = (list: (Chip | false | undefined)[]) => list.filter((c): c is Chip => !!c)

/** First line, trimmed to fit a row. */
export const firstLine = (text: string | undefined, max = 140) => {
  const line = text?.split("\n").find((l) => l.trim())?.trim()
  if (!line) return undefined
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Runs one async job per item, a few at a time (for CLIs without batching). */
export async function eachLimit<T>(items: T[], limit: number, job: (item: T) => Promise<void>) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await job(item)
    }),
  )
}

// ---------- URL helpers ----------

export const host = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, "")
export const segments = (url: URL) =>
  url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })

/** Slug words from a URL segment: "Agent-docs-381e…" → "Agent docs" */
export const slugTitle = (slug: string) => {
  const words = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
