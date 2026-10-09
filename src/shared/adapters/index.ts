import type { ParsedResource, ResourceAdapter, ResourceType } from "./adapter"
import { github } from "./github"
import { linear } from "./linear"
import { notion } from "./notion"
import { slack } from "./slack"
import { vercel } from "./vercel"

export type { ParsedResource, ResourceAdapter, ResourceType } from "./adapter"

/**
 * Resource adapters, in panel and Settings order. To add one, implement
 * ResourceAdapter (./adapter.ts) in its own file and list it here; to remove
 * one, take it out. `live` is optional: without it, links are collected and
 * shown but nothing is fetched.
 *
 * Adding or changing link types: bump RESOURCES_VERSION, which re-extracts
 * resources from already indexed messages (local, nothing is refetched).
 */
export const ADAPTERS: ResourceAdapter[] = [github, linear, notion, slack, vercel]

export const RESOURCES_VERSION = 2

/** Every link type, in priority order: the first type that parses a URL wins. */
export const RESOURCE_TYPES: ResourceType[] = ADAPTERS.flatMap((a) => a.types)

const ADAPTER_OF = new Map(ADAPTERS.flatMap((a) => a.types.map((t) => [t.id, a] as const)))
export const adapterOf = (typeID: string) => ADAPTER_OF.get(typeID)

const TYPES = new Map(RESOURCE_TYPES.map((t) => [t.id, t]))
export const resourceType = (id: string) => TYPES.get(id)

/** The first type that recognizes the URL, or null. */
export function parseResourceUrl(raw: string): ParsedResource | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  for (const type of RESOURCE_TYPES) {
    const r = type.parse(url)
    if (r) return { type: type.id, key: `${type.id}:${r.identity}`, url: r.url, data: r.data }
  }
  return null
}

// Stops at whitespace, quotes, brackets and markdown/backtick delimiters.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi

/** Every recognized resource in a text, once each (first occurrence wins). */
export function extractResources(text: string): ParsedResource[] {
  const out = new Map<string, ParsedResource>()
  for (const [match] of text.matchAll(URL_RE)) {
    const raw = match.replace(/[.,;:!?*_~]+$/, "")
    const r = parseResourceUrl(raw)
    if (!r) continue
    const seen = out.get(r.key)
    if (seen) Object.assign(seen.data, r.data)
    else out.set(r.key, r)
  }
  return [...out.values()]
}
