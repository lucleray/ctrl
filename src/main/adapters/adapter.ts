import { spawn } from "node:child_process"
import type { ResourceMeta, Tone } from "../../shared/types"

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** A resource to fetch: its key, type and the fields its URL gave (src/shared/resources.ts). */
export type MetaRequest = { id: string; type: string; data: Record<string, string> }

/**
 * How long details may be cached. The service caches and refetches
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

/**
 * Live details for some resource types, fetched through a service's own CLI so
 * ctrl never handles tokens. Register adapters in ./index.ts.
 */
export interface ResourceAdapter {
  id: string
  name: string
  /** What it adds, shown in Settings */
  description: string
  /** Resource types it handles (ids from src/shared/resources.ts) */
  types: string[]
  /** The CLI it runs, for Settings' setup hints */
  cli: { command: string; install: string; login: string }
  /** Most resources per fetch() call */
  batchSize: number
  fetch(batch: MetaRequest[]): Promise<AdapterResult>
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

/** Details that won't change again (merged PRs, finished builds) */
export const FINAL: CachePolicy = { maxAge: Infinity, refreshOnMention: false }
/** Details that rarely change: names, titles. Kept until mentioned again. */
export const UNTIL_MENTIONED: CachePolicy = { maxAge: Infinity, refreshOnMention: true }
export const every = (maxAge: number): CachePolicy => ({ maxAge, refreshOnMention: true })

export const missing = (): Fetched => ({ meta: { missing: true }, cache: { maxAge: DAY, refreshOnMention: true } })

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

export type CliResult = { code: number | null; stdout: string; stderr: string }

/**
 * Runs a CLI without a terminal. A missing CLI becomes a "no-cli" error, and
 * output matching `loginPrompt` (a CLI starting an interactive login) kills it
 * and becomes "logged-out" instead of hanging.
 */
export function runCli(
  command: string,
  args: string[],
  opts: { timeout?: number; loginPrompt?: RegExp } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new AdapterError(`${command} timed out`, "network")))
    }, opts.timeout ?? 30_000)
    const watch = (chunk: Buffer, into: "stdout" | "stderr") => {
      const text = chunk.toString()
      if (into === "stdout") stdout += text
      else stderr += text
      if (opts.loginPrompt?.test(text)) {
        child.kill()
        finish(() => reject(new AdapterError(`${command} isn't logged in`, "logged-out")))
      }
    }
    child.stdout.on("data", (c: Buffer) => watch(c, "stdout"))
    child.stderr.on("data", (c: Buffer) => watch(c, "stderr"))
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? new AdapterError(`${command} isn't installed`, "no-cli")
            : new AdapterError(`${command} failed: ${err.message}`, "network"),
        ),
      ),
    )
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })))
  })
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
