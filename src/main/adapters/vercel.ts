import type { Tone } from "../../shared/types"
import {
  AdapterError,
  chip,
  chips,
  eachLimit,
  every,
  FINAL,
  firstLine,
  HOUR,
  MINUTE,
  missing,
  runCli,
  SECOND,
  type Fetched,
  type MetaRequest,
  type ResourceAdapter,
} from "./adapter"

/** `vercel api` starts an interactive device login when logged out: treat that as logged out. */
const LOGIN_PROMPT = /login flow|oauth\/device|Waiting for authentication/i

type Json = Record<string, any>

/**
 * GET through the CLI. `teamId` is always passed: otherwise the CLI adds your
 * current team, which hides deployments of other teams. An empty teamId means
 * "find it wherever it is" (lookups by host).
 */
async function get(path: string, team: string): Promise<Json | null> {
  const sep = path.includes("?") ? "&" : "?"
  const res = await runCli("vercel", ["api", `${path}${sep}teamId=${encodeURIComponent(team)}`, "--raw"], {
    loginPrompt: LOGIN_PROMPT,
  })
  if (res.code === 0) {
    try {
      return JSON.parse(res.stdout) as Json
    } catch {
      throw new AdapterError("Unexpected output from vercel api", "network")
    }
  }
  // Errors look like "Error: Deployment not found (404)".
  const status = Number(res.stderr.match(/\((\d{3})\)/)?.[1])
  if (status === 403 || status === 404) return null // not there, or not visible to this account
  if (status === 401 || /log ?in|credentials/i.test(res.stderr)) throw new AdapterError("vercel isn't logged in", "logged-out")
  if (status === 429) throw new AdapterError("Vercel rate limit reached", "rate-limited")
  throw new AdapterError(res.stderr.trim().split("\n").pop() || "vercel api failed", "network")
}

const STATES: Record<string, { label: string; tone: Tone }> = {
  READY: { label: "ready", tone: "good" },
  ERROR: { label: "✗ error", tone: "bad" },
  CANCELED: { label: "canceled", tone: "muted" },
  BUILDING: { label: "● building", tone: "warn" },
  INITIALIZING: { label: "● building", tone: "warn" },
  QUEUED: { label: "queued", tone: "warn" },
}
const BUSY = new Set(["BUILDING", "INITIALIZING", "QUEUED"])

const commitMessage = (meta?: Json) => firstLine(meta?.githubCommitMessage || meta?.gitlabCommitMessage)
const branchOf = (meta?: Json): string | undefined => meta?.githubCommitRef || meta?.gitlabCommitRef || undefined

function deployment(d: Json, req: MetaRequest): Fetched {
  const state = STATES[d.readyState]
  const prod = d.target === "production"
  const branch = branchOf(d.meta)
  const id = req.data.host ?? `${req.data.project} · ${req.data.deployment.slice(0, 9)}`
  const meta = {
    title: commitMessage(d.meta),
    subtitle: branch ? `${id} · ${branch}` : id,
    tone: state?.tone,
    chips: chips([prod && chip("prod", "muted", "Production deployment"), state && chip(state.label, state.tone)]),
    details: d.creator?.username ? [`by @${d.creator.username}`] : undefined,
  }
  if (BUSY.has(d.readyState)) return { meta, cache: every(15 * SECOND) }
  // A deployment id never changes once built; a host can be an alias that moves to newer deployments.
  if (!req.data.host) return { meta, cache: FINAL }
  return { meta, cache: every(prod ? HOUR : 6 * HOUR) }
}

function project(p: Json, req: MetaRequest): Fetched {
  const prod = p.targets?.production as Json | undefined
  const state = prod && STATES[prod.readyState]
  return {
    meta: {
      subtitle: p.framework ? `${req.data.team} · ${p.framework}` : req.data.team,
      tone: state?.tone,
      chips: chips([state && chip(state.label, state.tone, "Latest production deployment")]),
      details: prod ? [`Latest production: ${commitMessage(prod.meta) ?? prod.url}`] : undefined,
    },
    cache: every(prod && BUSY.has(prod.readyState) ? 15 * SECOND : 5 * MINUTE),
  }
}

async function fetchOne(req: MetaRequest): Promise<Fetched> {
  const d = req.data
  if (req.type === "vercel-project") {
    const p = await get(`/v9/projects/${encodeURIComponent(d.project)}`, d.team)
    return p ? project(p, req) : missing()
  }
  // A *.vercel.app host, or a dashboard deployment id (the dashboard drops the dpl_ prefix).
  const dep = d.host
    ? await get(`/v13/deployments/${encodeURIComponent(d.host)}`, "")
    : await get(`/v13/deployments/dpl_${encodeURIComponent(d.deployment)}`, d.team)
  return dep ? deployment(dep, req) : missing()
}

let account: string | undefined

/** Deployments and projects. Vercel's API has no batching: one CLI call per resource, 4 at a time. */
export const vercel: ResourceAdapter = {
  id: "vercel",
  name: "Vercel",
  description: "Commit, branch and build state for deployments, latest production deployment for projects",
  types: ["vercel-deployment", "vercel-project"],
  cli: { command: "vercel", install: "npm i -g vercel", login: "vercel login" },
  batchSize: 20,

  async fetch(batch) {
    account ??= (await get("/v2/user", ""))?.user?.username
    const items = new Map<string, Fetched>()
    await eachLimit(batch, 4, async (req) => void items.set(req.id, await fetchOne(req)))
    return { items, account }
  },
}
