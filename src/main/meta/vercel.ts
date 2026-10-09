import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ResourceMeta } from "../../shared/types"
import { DAY, HOUR, MINUTE, ProviderError, SECOND, type MetaRequest, type Provider, type ProviderResult } from "./provider"

/** Where `vercel login` keeps its token (macOS, then the XDG location other platforms use). */
const AUTH_FILES = [
  join(homedir(), "Library/Application Support/com.vercel.cli/auth.json"),
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "com.vercel.cli/auth.json"),
]

/** Refresh this long before the CLI's token expires. */
const EXPIRY_MARGIN = 2 * MINUTE
/** Requests in flight at once: Vercel's REST API has no batching. */
const CONCURRENCY = 4

const run = (args: string[]) =>
  new Promise<void>((resolve, reject) =>
    execFile("vercel", args, { timeout: 20_000 }, (err) => {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT")
        reject(new ProviderError("Vercel CLI isn't installed", "no-cli"))
      else resolve() // a failed command still means the CLI exists; the token check below decides
    }),
  )

/**
 * Reuses the Vercel CLI's login. Its OAuth token expires every few hours; any
 * CLI command refreshes it, so when it's (nearly) expired ctrl runs
 * `vercel whoami` and reads the file again instead of handling refresh tokens
 * itself. VERCEL_TOKEN wins, like it does for the CLI.
 */
class VercelToken {
  private token?: Promise<string>

  get(): Promise<string> {
    this.token ??= this.read().catch((err) => {
      this.token = undefined
      throw err
    })
    return this.token
  }

  reset() {
    this.token = undefined
  }

  private async read(): Promise<string> {
    if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN
    let auth = readAuthFile()
    if (!auth.token || (auth.expiresAt && auth.expiresAt * SECOND < Date.now() + EXPIRY_MARGIN)) {
      await run(["whoami"])
      auth = readAuthFile()
    }
    if (!auth.token) throw new ProviderError("The Vercel CLI isn't logged in", "logged-out")
    if (auth.expiresAt && auth.expiresAt * SECOND < Date.now())
      throw new ProviderError("The Vercel CLI's login expired", "logged-out")
    const expires = auth.expiresAt ? auth.expiresAt * SECOND - EXPIRY_MARGIN : Infinity
    // Drop the cached token shortly before it expires, so the next fetch refreshes it.
    if (expires !== Infinity) setTimeout(() => this.reset(), Math.max(0, expires - Date.now())).unref?.()
    return auth.token
  }
}

function readAuthFile(): { token?: string; expiresAt?: number } {
  for (const file of AUTH_FILES) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8"))
      if (typeof json.token === "string") return { token: json.token, expiresAt: json.expiresAt }
    } catch {
      // missing or unreadable: try the next location
    }
  }
  return {}
}

type Json = Record<string, any>

async function get(token: string, path: string): Promise<Json | null> {
  let res: Response
  try {
    res = await fetch(`https://api.vercel.com${path}`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": "ctrl" },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new ProviderError(`Can't reach Vercel: ${err instanceof Error ? err.message : err}`, "network")
  }
  if (res.ok) return (await res.json()) as Json
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"))
    throw new ProviderError("Vercel rate limit reached", "rate-limited", reset ? reset * SECOND : Date.now() + 5 * MINUTE)
  }
  const body = (await res.json().catch(() => ({}))) as Json
  if (res.status === 401 || body.error?.code === "invalidToken" || body.error?.invalidToken)
    throw new ProviderError("Vercel rejected the CLI's token", "logged-out")
  if (res.status === 403 || res.status === 404) return null // not there, or not visible to this account
  throw new ProviderError(`Vercel returned ${res.status}`, "network")
}

const STATES: Record<string, string> = {
  READY: "ready",
  ERROR: "error",
  CANCELED: "canceled",
  BUILDING: "building",
  INITIALIZING: "building",
  QUEUED: "queued",
}

function deployment(d: Json, fetched: number): ResourceMeta {
  const meta = d.meta ?? {}
  return {
    title: meta.githubCommitMessage?.split("\n")[0] || meta.gitlabCommitMessage?.split("\n")[0] || undefined,
    state: STATES[d.readyState] ?? d.readyState?.toLowerCase(),
    target: d.target === "production" ? "production" : "preview",
    branch: meta.githubCommitRef || meta.gitlabCommitRef || undefined,
    author: d.creator?.username,
    fetched,
  }
}

async function fetchOne(token: string, req: MetaRequest, fetched: number): Promise<ResourceMeta> {
  const d = req.data
  const team = d.team ? `?slug=${encodeURIComponent(d.team)}` : ""
  if (req.type === "vercel-project") {
    const p = await get(token, `/v9/projects/${encodeURIComponent(d.project)}${team}`)
    if (!p) return { missing: true, fetched }
    const prod = p.targets?.production as Json | undefined
    return {
      state: prod ? (STATES[prod.readyState] ?? prod.readyState?.toLowerCase()) : undefined,
      title: prod?.meta?.githubCommitMessage?.split("\n")[0] || undefined,
      framework: p.framework ?? undefined,
      fetched,
    }
  }
  // A *.vercel.app host or a dashboard deployment id (the dashboard drops the dpl_ prefix).
  const id = d.host ?? `dpl_${d.deployment}`
  const dep = await get(token, `/v13/deployments/${encodeURIComponent(id)}${d.host ? "" : team}`)
  return dep ? deployment(dep, fetched) : { missing: true, fetched }
}

async function fetchVercel(token: string, batch: MetaRequest[]): Promise<ProviderResult> {
  const metas = new Map<string, ResourceMeta>()
  const fetched = Date.now()
  const queue = [...batch]
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let req = queue.shift(); req; req = queue.shift()) metas.set(req.id, await fetchOne(token, req, fetched))
    }),
  )
  return { metas }
}

const BUSY = new Set(["building", "queued"])

/**
 * Builds move fast (15s while building); finished dashboard deployments never
 * change. A *.vercel.app host can be an alias that moves to newer deployments,
 * and a project's production deployment changes with every deploy.
 */
function ttl(type: string, m: ResourceMeta) {
  if (m.missing) return DAY
  if (m.state && BUSY.has(m.state)) return 15 * SECOND
  if (type === "vercel-project") return 5 * MINUTE
  return type === "vercel-deployment" && m.target === "production" ? HOUR : 6 * HOUR
}

export function vercelProvider(): Provider {
  const token = new VercelToken()
  let account: string | undefined
  return {
    id: "vercel",
    batchSize: 20,
    ttl,
    resetAuth: () => token.reset(),
    async fetch(batch) {
      const attempt = async () => {
        const t = await token.get()
        account ??= (await get(t, "/v2/user"))?.user?.username
        return { ...(await fetchVercel(t, batch)), account }
      }
      try {
        return await attempt()
      } catch (err) {
        // The token may have expired early or been replaced by a new login: re-read it once.
        if (!(err instanceof ProviderError && err.kind === "logged-out")) throw err
        token.reset()
        return attempt()
      }
    },
  }
}
