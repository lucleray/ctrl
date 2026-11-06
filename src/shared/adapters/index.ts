import type { ResourceMeta } from "../types"
import type { AdapterMode, ParsedResource, Placement, ResourceAdapter, ResourceType, StageContext } from "./adapter"
import { github } from "./github"
import { linear } from "./linear"
import { notion } from "./notion"
import { sessionRefUrl, sessions } from "./sessions"
import { slack } from "./slack"
import { vercel } from "./vercel"

export type { ParsedResource, Placement, ResourceAdapter, ResourceType, Stage, StageContext } from "./adapter"

/**
 * Resource adapters, in panel and Settings order. To add one, implement
 * ResourceAdapter (./adapter.ts) in its own file and list it here; to remove
 * one, take it out. `live` is optional: without it, links are collected and
 * shown but nothing is fetched.
 *
 * Adding or changing link types: bump RESOURCES_VERSION, which re-extracts
 * resources from already indexed messages (local, nothing is refetched).
 */
export const ADAPTERS: ResourceAdapter[] = [sessions, github, linear, notion, slack, vercel]

export const RESOURCES_VERSION = 3

/** Every link type, in priority order: the first type that parses a URL wins. */
export const RESOURCE_TYPES: ResourceType[] = ADAPTERS.flatMap((a) => a.types)

const ADAPTER_OF = new Map(ADAPTERS.flatMap((a) => a.types.map((t) => [t.id, a] as const)))
export const adapterOf = (typeID: string) => ADAPTER_OF.get(typeID)

/** An adapter's mode per Settings: live details by default when it has them, never live without. */
export function adapterMode(adapter: ResourceAdapter, modes: Record<string, AdapterMode>): AdapterMode {
  const mode = modes[adapter.id] ?? (adapter.live ? "live" : "links")
  return mode === "live" && !adapter.live ? "links" : mode
}

const TYPES = new Map(RESOURCE_TYPES.map((t) => [t.id, t]))
export const resourceType = (id: string) => TYPES.get(id)

/** Sorted by their type's rank (open PRs before merged ones), keeping the given order otherwise. */
export function byRank<T extends { type: string; meta?: ResourceMeta }>(items: T[]): T[] {
  const rank = (i: T) => TYPES.get(i.type)?.rank?.(i.meta) ?? 0
  return [...items].sort((a, b) => rank(a) - rank(b))
}

/** Board column for a resource, or null when its type stays off the board (repos, docs, channels…). */
export function boardPlacement(item: { type: string; meta?: ResourceMeta; last: number }, ctx: StageContext): Placement | null {
  return TYPES.get(item.type)?.stage?.(item, ctx) ?? null
}

/** The first type that recognizes the URL, or null. */
export function parseResourceUrl(raw: string): ParsedResource | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ctrl:") return null
  for (const type of RESOURCE_TYPES) {
    const r = type.parse(url)
    if (r) return { type: type.id, key: `${type.id}:${r.identity}`, url: r.url, data: r.data }
  }
  return null
}

// Stops at whitespace, quotes, brackets and markdown/backtick delimiters.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi

// `@session[Title](id)` / `session[Title](id)`, see sessionMention() in src/renderer/ReferenceDrop.tsx.
const SESSION_RE = /@?session\[([^\]\n]*)\]\((ses_[A-Za-z0-9]+|fx:[A-Za-z0-9_-]+)\)/g

/** Every recognized resource in a text, once each (first occurrence wins). */
export function extractResources(text: string): ParsedResource[] {
  const out = new Map<string, ParsedResource>()
  const add = (r: ParsedResource | null) => {
    if (!r) return
    const seen = out.get(r.key)
    if (seen) Object.assign(seen.data, r.data)
    else out.set(r.key, r)
  }
  for (const [, title, id] of text.matchAll(SESSION_RE)) {
    const url = new URL(sessionRefUrl(id))
    if (title.trim()) url.searchParams.set("title", title.trim())
    add(parseResourceUrl(url.href))
  }
  for (const [match] of text.matchAll(URL_RE)) add(parseResourceUrl(match.replace(/[.,;:!?*_~]+$/, "")))
  return [...out.values()]
}
