import { parseResourceUrl, resourceType, type ParsedResource } from "../shared/adapters"

/** Resource keys to look up for what's on screen. */
export type Lookup = {
  /** Exact resources (a PR, a thread, a Notion page) */
  exact: string[]
  /** Key prefixes of related resources: a Slack channel also matches the threads in it */
  related: string[]
  /** key → how to name it in a row */
  names: Map<string, string>
}

const name = (r: Pick<ParsedResource, "type" | "data">) => resourceType(r.type)?.describe(r.data).title ?? r.type

/** Turns the helper's URLs into resource keys, with the adapters the indexer uses (same canonical keys). */
export function lookupFor(urls: string[]): Lookup {
  const out: Lookup = { exact: [], related: [], names: new Map() }
  for (const url of urls) {
    const r = parseResourceUrl(url)
    if (!r || out.exact.includes(r.key)) continue
    out.exact.push(r.key)
    out.names.set(r.key, name(r))
    if (r.type === "slack-channel") out.related.push(`slack-thread:${r.data.channel}/`)
  }
  return out
}

/** Row label for a key found through a prefix, e.g. a thread in the channel on screen. */
export function relatedName(key: string): string {
  const [type] = key.split(":", 1)
  if (type === "slack-thread") {
    const [, rest] = key.split(":", 2)
    const [channel, ts] = rest.split("/")
    return name({ type, data: { channel, ts, workspace: "" } })
  }
  return key
}
