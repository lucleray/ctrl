/**
 * Worktrees (docs/ARCHITECTURE.md → Worktrees): a warm pool of git worktrees per repo, so an agent gets a
 * ready checkout instantly with `ctrl worktree up`. Types shared by main, the CLI handlers and Settings,
 * plus the pool sizing, which is pure so Settings and tests can run it too.
 */

/**
 * ready: warm, waiting to be taken · attached: a session holds it · released: given back, waiting to be
 * recycled or removed · building / resetting / removing: work in progress on it
 */
export type WorktreeStatus = "building" | "ready" | "attached" | "released" | "resetting" | "removing"

export type Worktree = {
  id: string
  /** Source repo path: the repo's identity */
  repo: string
  path: string
  status: WorktreeStatus
  /** Session that holds it (attached), or that it's being built for (building) */
  sessionID: string | null
  /** Commit of the base branch it was last warmed at */
  baseCommit: string | null
  warmedAt: number | null
  attachedAt: number | null
  /** When it entered its current status */
  since: number
  /** Built for a session whose `up` call stopped waiting: that session's next `up` returns it */
  undelivered?: boolean
  /** Its setup command failed (cold builds are handed out anyway, so the agent can fix the install) */
  setupFailed?: boolean
}

export type WorktreeRepoConfig = {
  /** Absolute path of your own checkout: worktrees are created from it */
  source: string
  /** Short alias for `ctrl worktree up <name>`; unset = the folder name */
  name?: string
  baseBranch: string
  /** Shell command run in every new worktree (installs dependencies); null = none */
  setup: string | null
  /** Warm pool size; null = sized from usage */
  warm: number | null
  /** Most worktrees of this repo on disk: warm ones stop being built past it (`up` still works) */
  maxTotal: number
}

export const WORKTREE_DEFAULTS = {
  maxTotal: 30,
}

export type WorktreeEvent =
  /** A worktree was taken. warm: straight from the pool; ms: how long `up` took */
  | { t: number; repo: string; type: "up"; warm: boolean; ms: number }
  /** A worktree was built or recycled in ms */
  | { t: number; repo: string; type: "build" | "reset"; ms: number; ok: boolean }

export type WorktreeJobID = "pool" | "cleanup" | "update"

export type WorktreeJob = {
  /** When it last finished */
  at: number | null
  /** What it did, in one line */
  summary: string | null
}

/** A repo as Settings and `ctrl worktree config` show it. */
export type WorktreeRepoView = WorktreeRepoConfig & {
  /** `name`, else the folder name */
  label: string
  /** Warm pool size in effect */
  target: number
  /** The target comes from usage (warm is null) */
  auto: boolean
  counts: { ready: number; attached: number; building: number; released: number; total: number }
  usage: {
    /** Worktrees taken in the last 7 days */
    taken: number
    /** Share of those that came straight from the pool (0-1); null when none were taken */
    instant: number | null
    /** Median time of recent builds; null before the first one */
    buildMs: number | null
    lastTaken: number | null
  }
  /** Why the last build failed, until one succeeds */
  error?: string
  /** What the update job last did to your checkout, and when */
  updated?: { at: number; result: string }
}

export type WorktreesView = {
  /** Folder worktrees live in */
  root: string
  repos: WorktreeRepoView[]
  jobs: Record<WorktreeJobID, WorktreeJob>
}

/** A worktree as the CLI returns it. */
export type WorktreeView = Worktree & {
  /** Repo label */
  name: string
  /** Checked-out branch right now; null = detached */
  branch: string | null
  commit: string | null
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** How the pool is sized from usage (see poolTarget). */
export const POOL = {
  /** Usage replayed to size the pool */
  window: 7 * DAY,
  /** A repo not used for this long keeps no warm worktree */
  dormant: 30 * DAY,
  /** Share of requests that may miss the pool */
  misses: 0.02,
  /** Warm worktrees built at once per repo */
  parallel: 2,
  /** Assumed build time before the first build is measured */
  buildMs: 2 * MINUTE,
}

/**
 * Replays requests (timestamps, ascending) against a pool of `warm` worktrees refilled `parallel` at a
 * time in `refillMs` each, and counts the ones that find it empty. A miss is a cold build of its own, so
 * it leaves the pool alone.
 */
export function simulateMisses(ups: number[], warm: number, refillMs: number, parallel = POOL.parallel): number {
  let ready = warm
  let queued = 0
  let misses = 0
  /** When each refill in flight completes, ascending */
  const refills: number[] = []
  for (const t of ups) {
    while (refills.length && refills[0] <= t) {
      const done = refills.shift()!
      ready++
      if (queued > 0) {
        queued--
        refills.push(done + refillMs)
      }
    }
    if (ready === 0) {
      misses++
      continue
    }
    ready--
    if (refills.length < parallel) refills.push(t + refillMs)
    else queued++
  }
  return misses
}

/**
 * Warm pool size for a repo, from when its worktrees were taken: the smallest pool that would have
 * served the last 7 days with at most 2% misses, capped at `max` (the repo's cap on worktrees). One for a
 * repo used in the last 30 days but not the last 7, none after that.
 */
export function poolTarget(ups: number[], now: number, refillMs: number, max: number): number {
  if (max <= 0) return 0
  const recent = ups.filter((t) => now - t <= POOL.window).sort((a, b) => a - b)
  if (!recent.length) return ups.some((t) => now - t <= POOL.dormant) ? 1 : 0
  const allowed = Math.floor(recent.length * POOL.misses)
  for (let warm = 1; warm < max; warm++) if (simulateMisses(recent, warm, refillMs) <= allowed) return warm
  return max
}

export const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
