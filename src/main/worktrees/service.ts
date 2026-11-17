import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import {
  DAY,
  HOUR,
  MINUTE,
  median,
  POOL,
  poolTarget,
  WORKTREE_DEFAULTS,
  type Worktree,
  type WorktreeEvent,
  type WorktreeJob,
  type WorktreeJobID,
  type WorktreeRepoConfig,
  type WorktreeRepoView,
  type WorktreesView,
  type WorktreeView,
} from "../../shared/worktrees"
import {
  baseRef,
  branchInfo,
  detectBaseBranch,
  git,
  gitOrThrow,
  hasUnsaved,
  run,
  runSetup,
  suggestSetup,
  unsavedWork,
  writeRescueRef,
  type Unsaved,
} from "./git"

/** archived / gone (deleted): its worktrees get released · unknown: ctrl can't tell right now, so they stay */
export type SessionState = "active" | "archived" | "gone" | "unknown"

export type WorktreesHost = {
  settings(): {
    /** Folder for worktrees; null = `defaultRoot` */
    root: string | null
    /** Size pools from usage (off: one warm worktree per repo) */
    poolAuto: boolean
    cleanup: boolean
    updateRepos: boolean
  }
  sessionState(sessionID: string): Promise<SessionState>
  /** Something changed. sessionIDs: the sessions whose worktrees changed (their resources reload) */
  changed(sessionIDs: string[]): void
}

export class WorktreeError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "USAGE" | "AMBIGUOUS",
    message: string,
    readonly extra: { hint?: string; candidates?: unknown[] } = {},
  ) {
    super(message)
    this.name = "WorktreeError"
  }
}

type RepoState = WorktreeRepoConfig & {
  /** Added by hand (Settings, `ctrl worktree config`): it keeps one warm worktree for 30 days even if never used */
  addedAt?: number
  /** Why the last build failed, and when (warm builds wait BACKOFF_MS before trying again) */
  error?: string
  failedAt?: number
  /** What the update job last did to the source checkout */
  updated?: { at: number; result: string }
}

type Persisted = {
  version: 1
  repos: Record<string, RepoState>
  worktrees: Worktree[]
  events: WorktreeEvent[]
  jobs: Record<WorktreeJobID, WorktreeJob>
}

/** Who owns a worktree folder: two ctrls (installed, a preview) must never clean up each other's worktrees. */
const OWNER_FILE = ".ctrl-worktrees"
const TRASH = ".trash"

const POOL_EVERY = 10 * MINUTE
const CLEANUP_EVERY = HOUR
const UPDATE_EVERY = HOUR
/** After a session is archived: long enough for the undo toast and a quick unarchive. */
const CLEANUP_AFTER_ARCHIVE = 30_000
/** A warm worktree older than this is brought up to the base branch again. */
const STALE_MS = DAY
/** A folder nothing tracks is only removed once it's this old, so a build in another ctrl isn't caught mid-way. */
const ORPHAN_MS = HOUR
/** After a failed build, warm builds of that repo wait this long. */
const BACKOFF_MS = 30 * MINUTE
/** Warm builds and recycles running at once, over all repos (an `up` that finds the pool empty never waits for a slot). */
const MAX_TASKS = 3
const KEEP_EVENTS_MS = 30 * DAY
const MAX_EVENTS = 5000

const emptyJobs = (): Record<WorktreeJobID, WorktreeJob> => ({
  pool: { at: null, summary: null },
  cleanup: { at: null, summary: null },
  update: { at: null, summary: null },
})

const expand = (path: string, cwd?: string) => {
  const p = path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path
  return isAbsolute(p) ? p : resolve(cwd || homedir(), p)
}

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** Folder name for a repo's worktrees, stable and unique per source path: ~/code/acme-app → "acme-app-3f9c". */
export const repoSlug = (source: string) =>
  `${basename(source) || "repo"}-${createHash("sha1").update(source).digest("hex").slice(0, 4)}`

/**
 * The warm pool of git worktrees (docs/ARCHITECTURE.md → Worktrees). Agents take one with
 * `ctrl worktree up <repo>`; it's attached to their session and released when that session is archived.
 * Everything slow (git, setup commands, deleting folders) runs in child processes, never in main.
 */
export class WorktreeService {
  private data: Persisted
  /** Builds in flight, by worktree id: what an `up` waits on */
  private builds = new Map<string, Promise<void>>()
  /** `up` calls waiting on a build, by worktree id */
  private waiters = new Map<string, number>()
  /** Git commands that touch a repo's refs or worktree registry, one at a time per repo */
  private chains = new Map<string, Promise<unknown>>()
  private fetched = new Map<string, number>()
  private freshChecked = new Map<string, number>()
  /** Warm builds and recycles in flight (MAX_TASKS) */
  private tasks = 0
  /** Branch each worktree was on when last asked (describe) */
  private live = new Map<string, { branch: string | null; commit: string | null }>()
  private running = new Set<WorktreeJobID>()
  private timer?: ReturnType<typeof setInterval>
  private soon?: ReturnType<typeof setTimeout>
  private first?: ReturnType<typeof setTimeout>
  private saveTimer?: ReturnType<typeof setTimeout>
  private cached?: WorktreesView
  private rootOK = new Map<string, boolean>()
  /** Folders a recycle is moving a worktree to, so cleanup never takes one for an untracked folder */
  private moving = new Set<string>()
  /** `prewarm` asked for at least this many warm worktrees, until the pool gets there */
  private floors = new Map<string, number>()
  private stopped = false

  constructor(
    private file: string,
    /** Where worktrees go unless the worktreeRoot setting says otherwise */
    readonly defaultRoot: string,
    private host: WorktreesHost,
  ) {
    let loaded: Partial<Persisted> = {}
    try {
      loaded = JSON.parse(readFileSync(file, "utf8"))
    } catch {}
    this.data = {
      version: 1,
      repos: loaded.repos ?? {},
      worktrees: loaded.worktrees ?? [],
      events: loaded.events ?? [],
      jobs: { ...emptyJobs(), ...loaded.jobs },
    }
  }

  // ---------- lifecycle ----------

  start() {
    this.stopped = false
    void this.recover()
    this.timer ??= setInterval(() => void this.tick(), MINUTE)
    // Not at launch: the first check waits until the app is up.
    this.first = setTimeout(() => void this.tick(), 20_000)
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
    clearTimeout(this.first)
    clearTimeout(this.soon)
    this.timer = undefined
    this.flush()
  }

  /** Work a previous run left half-done: everything runs in this process, so nothing is still working on it. */
  private async recover() {
    for (const wt of [...this.data.worktrees]) {
      if (wt.status === "building") await this.remove(wt)
      else if (wt.status === "resetting") wt.status = "released"
      else if (wt.status === "removing") await this.remove(wt)
    }
    this.touch()
    this.emptyTrash(join(this.root(), TRASH))
  }

  private async tick() {
    if (this.stopped) return
    const now = Date.now()
    const settings = this.host.settings()
    const due = (id: WorktreeJobID, every: number) => now - (this.data.jobs[id].at ?? 0) >= every
    if (due("pool", POOL_EVERY)) await this.runJob("pool")
    if (settings.cleanup && due("cleanup", CLEANUP_EVERY)) await this.runJob("cleanup")
    if (settings.updateRepos && due("update", UPDATE_EVERY)) await this.runJob("update")
  }

  /** Runs a background job now (Settings' "Run now", `ctrl worktree cleanup --apply`). */
  async runJob(id: WorktreeJobID): Promise<string> {
    if (this.running.has(id)) return this.data.jobs[id].summary ?? "Running"
    this.running.add(id)
    let summary: string
    try {
      summary = id === "pool" ? await this.poolJob() : id === "cleanup" ? summarize(await this.cleanup({ apply: true })) : await this.updateJob()
    } catch (err) {
      summary = `Failed: ${err instanceof Error ? err.message : err}`
      console.error(`[ctrl] worktree ${id} job failed`, err)
    } finally {
      this.running.delete(id)
    }
    this.data.jobs[id] = { at: Date.now(), summary }
    this.touch()
    return summary
  }

  /** A worktree setting changed: the folder, pool sizes and jobs follow. */
  settingsChanged() {
    this.rootOK.clear()
    this.cached = undefined
    this.rebalanceAll()
  }

  /** A session was archived: its worktrees go once the undo window has passed (if it's still archived). */
  sessionsArchived() {
    if (!this.host.settings().cleanup) return
    clearTimeout(this.soon)
    this.soon = setTimeout(() => void this.runJob("cleanup"), CLEANUP_AFTER_ARCHIVE)
  }

  // ---------- state ----------

  private save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 100)
  }

  private flush() {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error("[ctrl] couldn't save worktrees", err)
    }
  }

  /** State changed: save, drop the cached view, tell main. */
  private touch(sessionIDs: (string | null)[] = []) {
    this.cached = undefined
    this.save()
    this.host.changed(sessionIDs.filter((id): id is string => !!id))
  }

  private event(e: WorktreeEvent) {
    const cutoff = Date.now() - KEEP_EVENTS_MS
    this.data.events = [...this.data.events.filter((x) => x.t >= cutoff), e].slice(-MAX_EVENTS)
  }

  private of(source: string) {
    return this.data.worktrees.filter((w) => w.repo === source)
  }

  private label(repo: WorktreeRepoConfig) {
    return repo.name || basename(repo.source)
  }

  /**
   * Folder worktrees are created in. A folder another ctrl already uses (a preview started from a copy of
   * your settings) is never shared: this ctrl falls back to its own default, so neither cleans up the other's.
   */
  root(): string {
    const configured = this.host.settings().root
    const root = configured ? expand(configured) : this.defaultRoot
    return this.owns(root) ? root : this.defaultRoot
  }

  private owns(root: string) {
    const known = this.rootOK.get(root)
    if (known !== undefined) return known
    let ok = true
    try {
      mkdirSync(root, { recursive: true })
      const marker = join(root, OWNER_FILE)
      if (existsSync(marker)) ok = readFileSync(marker, "utf8").trim() === this.file
      else {
        writeFileSync(marker, `${this.file}\n`)
        // Spotlight has nothing to find in checkouts and node_modules, and indexing them is expensive.
        writeFileSync(join(root, ".metadata_never_index"), "")
      }
    } catch (err) {
      console.error(`[ctrl] can't use ${root} for worktrees`, err)
      ok = root === this.defaultRoot
    }
    if (!ok) console.warn(`[ctrl] ${root} belongs to another ctrl: using ${this.defaultRoot} for worktrees`)
    this.rootOK.set(root, ok)
    return ok
  }

  // ---------- repos ----------

  /** A path (anywhere inside a repo, even one of its worktrees) or the name of a configured repo → its source checkout. */
  private async resolveSource(token: string, cwd?: string): Promise<{ source: string; repo?: RepoState }> {
    const pathLike = token.includes("/") || token.startsWith("~") || token.startsWith(".")
    if (!pathLike) {
      const repos = Object.values(this.data.repos)
      const named = repos.filter((r) => r.name === token)
      const matches = named.length ? named : repos.filter((r) => basename(r.source) === token)
      if (matches.length === 1) return { source: matches[0].source, repo: matches[0] }
      if (matches.length > 1)
        throw new WorktreeError("AMBIGUOUS", `${matches.length} repos are called "${token}"`, {
          hint: "Pass the repo's path instead",
          candidates: matches.map((r) => r.source),
        })
      // A bare folder name in the caller's folder still works as a path.
      if (!existsSync(expand(token, cwd)))
        throw new WorktreeError("NOT_FOUND", `No repo called "${token}"`, {
          hint: "Pass the path of a git checkout, e.g. ctrl worktree up ~/code/acme-app",
          candidates: repos.map((r) => this.label(r)),
        })
    }
    const path = real(expand(token, cwd))
    const known = this.data.repos[path]
    if (known) return { source: path, repo: known }
    if (!existsSync(path)) throw new WorktreeError("NOT_FOUND", `No folder at ${path}`)
    const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    if (common.code !== 0) throw new WorktreeError("USAGE", `${path} isn't a git repo`)
    const gitDir = real(common.stdout.trim())
    if (basename(gitDir) !== ".git") throw new WorktreeError("USAGE", `${path} is a bare repo: worktrees need a checkout to start from`)
    const source = dirname(gitDir)
    return { source, repo: this.data.repos[source] }
  }

  /** The repo for a token, registered with detected settings the first time it's seen (`added`: by hand). */
  private async ensureRepo(token: string, cwd?: string, added = false): Promise<RepoState> {
    const { source, repo } = await this.resolveSource(token, cwd)
    if (repo) return repo
    const created: RepoState = {
      source,
      baseBranch: await detectBaseBranch(source),
      setup: suggestSetup(source),
      warm: null,
      maxTotal: WORKTREE_DEFAULTS.maxTotal,
      ...(added ? { addedAt: Date.now() } : {}),
    }
    this.data.repos[source] = created
    this.touch()
    return created
  }

  /** Adds a repo or changes its settings. */
  async configure(
    token: string,
    patch: { name?: string | null; baseBranch?: string; setup?: string | null; warm?: number | null; maxTotal?: number },
    cwd?: string,
  ): Promise<{ repo: WorktreeRepoView; changed: boolean }> {
    const isNew = !(await this.resolveSource(token, cwd)).repo
    const repo = await this.ensureRepo(token, cwd, true)
    const before = isNew ? "" : JSON.stringify(repo)
    if (patch.name !== undefined) {
      const name = patch.name?.trim()
      if (name && Object.values(this.data.repos).some((r) => r !== repo && r.name === name))
        throw new WorktreeError("CONFLICT", `Another repo is already called "${name}"`)
      if (name) repo.name = name
      else delete repo.name
    }
    if (patch.baseBranch !== undefined) {
      const branch = patch.baseBranch.trim()
      const ok = await git(repo.source, ["rev-parse", "--verify", "--quiet", await baseRef(repo.source, branch)])
      if (!branch || ok.code !== 0) throw new WorktreeError("NOT_FOUND", `${repo.source} has no branch ${branch}`)
      repo.baseBranch = branch
    }
    if (patch.setup !== undefined) repo.setup = patch.setup?.trim() || null
    if (patch.warm !== undefined) repo.warm = patch.warm === null ? null : Math.max(0, Math.min(50, Math.round(patch.warm)))
    if (patch.maxTotal !== undefined) repo.maxTotal = Math.max(1, Math.min(200, Math.round(patch.maxTotal)))
    const changed = JSON.stringify(repo) !== before
    if (changed) {
      // A new setup command or branch deserves a fresh try.
      delete repo.error
      delete repo.failedAt
      this.touch()
      this.rebalance(repo.source)
    }
    return { repo: this.repoView(repo), changed }
  }

  /** Stops managing a repo: its idle worktrees are removed. Refused while a session holds one. */
  async forget(token: string, cwd?: string): Promise<{ source: string; removed: number }> {
    const { source, repo } = await this.resolveSource(token, cwd)
    if (!repo) throw new WorktreeError("NOT_FOUND", `${source} isn't a repo ctrl manages`, { hint: "ctrl worktree config" })
    const held = this.of(source).filter((w) => w.status === "attached" || (w.status === "building" && w.sessionID))
    if (held.length)
      throw new WorktreeError("CONFLICT", `${plural(held.length, "session")} still hold${held.length === 1 ? "s" : ""} a worktree of ${this.label(repo)}`, {
        hint: "ctrl worktree list --all, then ctrl worktree down <id>",
        candidates: held.map((w) => ({ id: w.id, sessionID: w.sessionID, path: w.path })),
      })
    delete this.data.repos[source]
    const idle = this.of(source)
    this.touch()
    await Promise.all(idle.map((w) => this.remove(w)))
    return { source, removed: idle.length }
  }

  // ---------- pool sizing ----------

  private buildMs(source: string): number | null {
    const builds = this.data.events.filter((e) => e.repo === source && e.type === "build" && e.ok).slice(-10)
    return median(builds.map((e) => e.ms))
  }

  private target(repo: RepoState): number {
    if (repo.warm !== null) return repo.warm
    if (!this.host.settings().poolAuto) return 1
    const ups = this.data.events.filter((e) => e.repo === repo.source && e.type === "up").map((e) => e.t)
    const now = Date.now()
    // Added by hand: one stays warm for its first 30 days, used or not.
    const floor = repo.addedAt && now - repo.addedAt <= POOL.dormant ? 1 : 0
    return Math.max(poolTarget(ups, now, this.buildMs(repo.source) ?? POOL.buildMs, repo.maxTotal), floor)
  }

  // ---------- git, serialized per repo ----------

  private withGit<T>(source: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(source) ?? Promise.resolve()).then(fn, fn)
    this.chains.set(
      source,
      next.catch(() => {}),
    )
    return next
  }

  /** Fetches the base branch, at most once a minute per repo. Best effort: offline builds use what's there. */
  private async fetch(repo: RepoState) {
    const fresh = () => Date.now() - (this.fetched.get(repo.source) ?? 0) < MINUTE
    if (fresh()) return
    await this.withGit(repo.source, async () => {
      if (fresh()) return
      await git(repo.source, ["fetch", "origin", repo.baseBranch, "--quiet"], 5 * MINUTE)
      this.fetched.set(repo.source, Date.now())
    })
  }

  // ---------- building, recycling, removing ----------

  private newWorktree(repo: RepoState, sessionID: string | null): Worktree {
    const id = randomBytes(4).toString("hex").slice(0, 6)
    const wt: Worktree = {
      id,
      repo: repo.source,
      path: join(this.root(), repoSlug(repo.source), id),
      status: "building",
      sessionID,
      baseCommit: null,
      warmedAt: null,
      attachedAt: null,
      since: Date.now(),
      ...(sessionID ? { undelivered: true } : {}),
    }
    this.data.worktrees.push(wt)
    return wt
  }

  /** Starts building a worktree: for the pool, or for a session that found it empty. */
  private startBuild(repo: RepoState, sessionID: string | null, skipSetup = false): Worktree {
    const wt = this.newWorktree(repo, sessionID)
    const pooled = !sessionID
    if (pooled) this.tasks++
    const work = this.build(repo, wt, skipSetup).finally(() => {
      this.builds.delete(wt.id)
      if (pooled) this.tasks--
      this.rebalanceAll()
    })
    this.builds.set(wt.id, work)
    // Warm builds have nobody waiting: their failure is kept on the repo instead.
    work.catch(() => {})
    this.touch()
    return wt
  }

  private async build(repo: RepoState, wt: Worktree, skipSetup: boolean) {
    const started = Date.now()
    try {
      await this.fetch(repo)
      const ref = await baseRef(repo.source, repo.baseBranch)
      mkdirSync(dirname(wt.path), { recursive: true })
      await this.withGit(repo.source, () => gitOrThrow(repo.source, ["worktree", "add", "--detach", wt.path, ref]))
      wt.baseCommit = (await gitOrThrow(wt.path, ["rev-parse", "HEAD"])).slice(0, 12)
      if (repo.setup && !skipSetup) {
        const setup = await runSetup(repo.setup, wt.path)
        if (!setup.ok) {
          const message = `Setup failed: ${repo.setup}\n${setup.detail}`
          // A session waiting for it still gets the checkout, and can fix the install itself.
          if (!wt.sessionID) throw new Error(message)
          wt.setupFailed = true
          repo.error = message
        }
      }
    } catch (err) {
      repo.error = err instanceof Error ? err.message : String(err)
      repo.failedAt = Date.now()
      this.event({ t: Date.now(), repo: repo.source, type: "build", ms: Date.now() - started, ok: false })
      await this.remove(wt)
      throw err
    }
    if (!wt.setupFailed) {
      delete repo.error
      delete repo.failedAt
    }
    const now = Date.now()
    this.event({ t: now, repo: repo.source, type: "build", ms: now - started, ok: !wt.setupFailed })
    wt.warmedAt = now
    wt.since = now
    // Its session may have been archived while it was built: then it joins the pool.
    if (wt.sessionID) {
      wt.status = "attached"
      wt.attachedAt = now
    } else {
      wt.status = "ready"
      delete wt.undelivered
    }
    this.touch([wt.sessionID])
  }

  /**
   * Brings a worktree back to the base branch and runs setup again, keeping its dependencies. A released
   * one also moves to a new folder, so nothing that remembers its old path can touch it once another
   * session has it.
   */
  private startReset(repo: RepoState, wt: Worktree, rename: boolean) {
    wt.status = "resetting"
    wt.since = Date.now()
    this.tasks++
    void this.reset(repo, wt, rename)
      .catch(() => {})
      .finally(() => {
        this.tasks--
        this.rebalanceAll()
      })
    this.touch()
  }

  private async reset(repo: RepoState, wt: Worktree, rename: boolean) {
    const started = Date.now()
    try {
      await this.fetch(repo)
      const ref = await baseRef(repo.source, repo.baseBranch)
      await gitOrThrow(wt.path, ["checkout", "--detach", "--force", ref])
      await gitOrThrow(wt.path, ["reset", "--hard", ref])
      // Untracked files go, ignored ones (node_modules) stay.
      await gitOrThrow(wt.path, ["clean", "-fd"])
      if (rename) {
        const id = randomBytes(4).toString("hex").slice(0, 6)
        const path = join(dirname(wt.path), id)
        this.moving.add(path)
        try {
          await this.withGit(repo.source, () => gitOrThrow(repo.source, ["worktree", "move", wt.path, path]))
          this.live.delete(wt.id)
          wt.id = id
          wt.path = path
        } finally {
          this.moving.delete(path)
        }
      }
      if (repo.setup) {
        const setup = await runSetup(repo.setup, wt.path)
        if (!setup.ok) throw new Error(`Setup failed: ${repo.setup}\n${setup.detail}`)
      }
      wt.baseCommit = (await gitOrThrow(wt.path, ["rev-parse", "HEAD"])).slice(0, 12)
    } catch (err) {
      repo.error = err instanceof Error ? err.message : String(err)
      repo.failedAt = Date.now()
      this.event({ t: Date.now(), repo: repo.source, type: "reset", ms: Date.now() - started, ok: false })
      await this.remove(wt)
      throw err
    }
    delete repo.error
    delete repo.failedAt
    const now = Date.now()
    this.event({ t: now, repo: repo.source, type: "reset", ms: now - started, ok: true })
    Object.assign(wt, { status: "ready", sessionID: null, attachedAt: null, warmedAt: now, since: now })
    delete wt.undelivered
    delete wt.setupFailed
    this.touch()
  }

  /** Takes a worktree off disk and out of git's registry. Returns once it's gone from both (deleting the files continues behind). */
  private async remove(wt: Worktree) {
    const holder = wt.sessionID
    wt.status = "removing"
    wt.since = Date.now()
    this.cached = undefined
    await this.trash(wt.path)
    if (existsSync(wt.repo)) await this.withGit(wt.repo, () => git(wt.repo, ["worktree", "prune"]))
    this.data.worktrees = this.data.worktrees.filter((w) => w !== wt)
    this.live.delete(wt.id)
    this.touch([holder])
  }

  /**
   * Deleting a checkout with node_modules takes minutes, so the folder is renamed into a trash folder next
   * to it (instant, same volume) and deleted from there by a child process.
   */
  private async trash(path: string) {
    if (!existsSync(path)) return
    const trash = join(dirname(dirname(path)), TRASH)
    try {
      mkdirSync(trash, { recursive: true })
      renameSync(path, join(trash, `${basename(path)}-${Date.now().toString(36)}`))
      this.emptyTrash(trash)
    } catch {
      await run("rm", ["-rf", path], { timeout: 30 * MINUTE })
    }
  }

  private emptyTrash(trash: string) {
    let entries: string[]
    try {
      entries = readdirSync(trash)
    } catch {
      return
    }
    if (!entries.length) return
    const child = spawn("rm", ["-rf", ...entries.map((e) => join(trash, e))], { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  }

  // ---------- the pool ----------

  /**
   * Moves a repo's pool toward its target, a step at a time: removes released worktrees it has no room
   * for, recycles or builds warm ones, and drops warm ones past the target once they're a day old.
   * Returns right away: the work it starts calls it again when it ends.
   */
  rebalance(source: string) {
    const repo = this.data.repos[source]
    if (!repo || this.stopped) return
    const now = Date.now()
    for (let guard = 0; guard < 200; guard++) {
      const all = this.of(source)
      const ready = all.filter((w) => w.status === "ready")
      const inflight = all.filter((w) => (w.status === "building" && !w.sessionID) || w.status === "resetting").length
      const total = all.filter((w) => w.status !== "removing").length
      const released = all.filter((w) => w.status === "released")
      const floor = this.floors.get(source) ?? 0
      if (floor && ready.length >= floor) this.floors.delete(source)
      const target = Math.max(this.target(repo), floor)
      const warm = ready.length + inflight
      if (released.length && (total > repo.maxTotal || warm >= target)) {
        void this.remove(released[0])
        continue
      }
      if (warm < target) {
        if (inflight >= POOL.parallel || this.tasks >= MAX_TASKS) return
        if (repo.failedAt && now - repo.failedAt < BACKOFF_MS) return
        if (released.length) {
          this.startReset(repo, released[0], true)
          continue
        }
        if (total >= repo.maxTotal) return
        this.startBuild(repo, null)
        continue
      }
      const surplus = warm > target ? ready.filter((w) => now - (w.warmedAt ?? 0) > STALE_MS).sort((a, b) => (a.warmedAt ?? 0) - (b.warmedAt ?? 0))[0] : undefined
      if (surplus) {
        void this.remove(surplus)
        continue
      }
      return
    }
  }

  private rebalanceAll() {
    for (const source of Object.keys(this.data.repos)) this.rebalance(source)
  }

  /** Every 10 minutes: every pool at its target, and one warm worktree per repo refreshed when the base branch moved on. */
  private async poolJob(): Promise<string> {
    this.rebalanceAll()
    const now = Date.now()
    let refreshed = 0
    for (const repo of Object.values(this.data.repos)) {
      const stale = this.of(repo.source)
        .filter((w) => w.status === "ready" && now - (w.warmedAt ?? 0) > STALE_MS)
        .sort((a, b) => (a.warmedAt ?? 0) - (b.warmedAt ?? 0))
      const busy = this.of(repo.source).some((w) => w.status === "resetting" || (w.status === "building" && !w.sessionID))
      if (!stale.length || busy || this.tasks >= MAX_TASKS) continue
      if (now - (this.freshChecked.get(repo.source) ?? 0) < HOUR) continue
      this.freshChecked.set(repo.source, now)
      await this.fetch(repo)
      const head = await git(repo.source, ["rev-parse", await baseRef(repo.source, repo.baseBranch)])
      if (head.code !== 0) continue
      const wt = stale.find((w) => !w.baseCommit || !head.stdout.trim().startsWith(w.baseCommit))
      // Still ready: the fetch took a moment, and an `up` may have taken it meanwhile.
      if (!wt || wt.status !== "ready") continue
      this.startReset(repo, wt, false)
      refreshed++
    }
    const wts = this.data.worktrees
    const count = (status: Worktree["status"][]) => wts.filter((w) => status.includes(w.status)).length
    const building = count(["building", "resetting"])
    return [
      `${count(["ready"])} warm`,
      `${count(["attached"])} in use`,
      building ? `${building} being built` : "",
      refreshed ? `${plural(refreshed, "warm worktree")} refreshed` : "",
    ]
      .filter(Boolean)
      .join(", ")
  }

  // ---------- up / down ----------

  /**
   * A ready worktree for a session: from the pool, else built now. A build outlives the call that asked
   * for it, so when that call gives up (a tool timeout), the session's next `up` waits on the same build
   * or gets its result, instead of starting another.
   */
  async up(
    token: string,
    sessionID: string,
    /** alive: whether the caller is still there to get the reply (unset = yes) */
    opts: { skipSetup?: boolean; cwd?: string; alive?: () => boolean } = {},
  ): Promise<{ worktree: Worktree; cold: boolean }> {
    const started = Date.now()
    const repo = await this.ensureRepo(token, opts.cwd)
    const mine = (w: Worktree) => w.repo === repo.source && w.sessionID === sessionID && !!w.undelivered && !this.waiters.get(w.id)
    let wt = this.data.worktrees.find((w) => mine(w) && (w.status === "building" || w.status === "attached"))
    let cold = !!wt
    if (!wt) {
      wt = this.data.worktrees.find((w) => w.repo === repo.source && w.status === "ready" && existsSync(w.path))
      if (wt) {
        Object.assign(wt, { status: "attached", sessionID, attachedAt: started, since: started })
        this.touch([sessionID])
      }
    }
    if (!wt) {
      cold = true
      wt = this.startBuild(repo, sessionID, opts.skipSetup)
    }
    if (wt.status === "building") {
      const id = wt.id
      this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1)
      try {
        await this.builds.get(id)
      } finally {
        this.waiters.set(id, (this.waiters.get(id) ?? 1) - 1)
      }
    }
    // Nobody left to hand it to: it stays marked for this session's next `up`.
    if (opts.alive?.() !== false) delete wt.undelivered
    this.event({ t: Date.now(), repo: repo.source, type: "up", warm: !cold, ms: Date.now() - started })
    this.touch()
    this.rebalance(repo.source)
    return { worktree: wt, cold }
  }

  /** By id, by path (the worktree's folder or anything inside it), or the one the caller's folder is in. */
  find(selector: string | undefined, cwd?: string): Worktree {
    if (selector) {
      const byID = this.data.worktrees.find((w) => w.id === selector)
      if (byID) return byID
    }
    const path = real(expand(selector ?? cwd ?? "", cwd))
    const inside = (w: Worktree) => {
      const root = real(w.path)
      return path === root || path.startsWith(root + sep)
    }
    const byPath = this.data.worktrees.find(inside)
    if (byPath) return byPath
    if (!selector)
      throw new WorktreeError("NOT_FOUND", `${path} isn't inside a worktree`, { hint: "Pass its id or path: ctrl worktree list" })
    throw new WorktreeError("NOT_FOUND", `No worktree ${selector}`, { hint: "ctrl worktree list --all shows ids and paths" })
  }

  /**
   * Gives a worktree back to the pool. Recycling resets it to the base branch, so this refuses when that
   * would lose work (uncommitted files, commits no remote has) unless `force`; detached commits get a
   * rescue ref first.
   */
  async down(wt: Worktree, opts: { force?: boolean } = {}): Promise<{ branch: string | null; forced: boolean; rescueRef: string | null }> {
    if (wt.status !== "attached")
      throw new WorktreeError("CONFLICT", `Worktree ${wt.id} isn't held by a session (${wt.status})`, { hint: "ctrl worktree list --all" })
    const unsaved = await unsavedWork(wt.path, wt.baseCommit)
    if (!opts.force && hasUnsaved(unsaved)) throw new WorktreeError("CONFLICT", `Worktree ${wt.id} has ${describeUnsaved(unsaved)}`, { hint: unsavedHint(unsaved, wt) })
    const rescueRef = unsaved.orphans > 0 ? await writeRescueRef(wt.path, wt.id) : null
    await this.release(wt)
    return { branch: unsaved.branch, forced: !!opts.force && hasUnsaved(unsaved), rescueRef }
  }

  private async release(wt: Worktree) {
    const holder = wt.sessionID
    Object.assign(wt, { status: "released", sessionID: null, attachedAt: null, since: Date.now() })
    delete wt.undelivered
    this.touch([holder])
    // So the branch it was on can be checked out elsewhere right away.
    if (existsSync(wt.path)) await git(wt.path, ["checkout", "--detach"])
    this.rebalance(wt.repo)
  }

  /**
   * Releases every worktree a session holds, without the unsaved-work check: archiving or deleting the
   * session is the signal. Branches stay in the repo, and detached commits get a rescue ref.
   */
  async releaseSession(sessionID: string): Promise<Worktree[]> {
    const held = this.data.worktrees.filter((w) => w.sessionID === sessionID)
    for (const wt of held) {
      // Still being built for it: it joins the pool when done.
      if (wt.status === "building") wt.sessionID = null
      else if (wt.status === "attached") await this.forceRelease(wt)
    }
    return held
  }

  private async forceRelease(wt: Worktree) {
    if (existsSync(wt.path)) {
      const [branch, head] = await Promise.all([git(wt.path, ["symbolic-ref", "-q", "HEAD"]), git(wt.path, ["rev-parse", "HEAD"])])
      const moved = head.code === 0 && !(wt.baseCommit && head.stdout.trim().startsWith(wt.baseCommit))
      if (branch.code !== 0 && moved) {
        const lost = await git(wt.path, ["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes", "--tags"])
        if (Number(lost.stdout.trim()) > 0) await writeRescueRef(wt.path, wt.id)
      }
    }
    await this.release(wt)
  }

  /** Runs the update job now: fetches the repos in use and fast-forwards your checkouts where it's safe. */
  update() {
    return this.runJob("update")
  }

  /** Builds warm worktrees now, at least `count` (default: the repo's pool size, and never less than one). */
  async prewarm(token: string, count?: number, cwd?: string): Promise<WorktreeRepoView> {
    const repo = await this.ensureRepo(token, cwd)
    delete repo.failedAt
    this.floors.set(repo.source, Math.max(1, Math.min(50, count ?? this.target(repo))))
    this.rebalance(repo.source)
    return this.repoView(repo)
  }

  // ---------- cleanup ----------

  /**
   * What fell through the cracks: worktrees whose session is archived or deleted (released), entries whose
   * folder is gone (dropped), folders in the worktree folder that nothing tracks (removed). Only looks
   * inside this ctrl's own folder, and never at a session it can't see the state of.
   */
  async cleanup({ apply }: { apply: boolean }): Promise<CleanupResult> {
    const result: CleanupResult = { released: [], dropped: [], removed: [] }
    const states = new Map<string, SessionState>()
    for (const wt of [...this.data.worktrees]) {
      if (wt.status === "attached" && wt.sessionID) {
        if (!states.has(wt.sessionID)) states.set(wt.sessionID, await this.host.sessionState(wt.sessionID))
        const state = states.get(wt.sessionID)
        if (state !== "archived" && state !== "gone") continue
        result.released.push({ id: wt.id, path: wt.path, sessionID: wt.sessionID, reason: state === "archived" ? "session archived" : "session deleted" })
        if (apply) await this.forceRelease(wt)
      } else if ((wt.status === "ready" || wt.status === "attached" || wt.status === "released") && !existsSync(wt.path)) {
        result.dropped.push({ id: wt.id, path: wt.path })
        if (apply) await this.remove(wt)
      }
    }
    const root = this.root()
    const tracked = new Set([...this.data.worktrees.map((w) => w.path), ...this.moving])
    const now = Date.now()
    const repos = new Set<string>()
    for (const slug of safeList(root)) {
      if (slug.startsWith(".")) continue
      for (const name of safeList(join(root, slug))) {
        const path = join(root, slug, name)
        if (name.startsWith(".") || tracked.has(path)) continue
        let age = 0
        try {
          const stat = statSync(path)
          if (!stat.isDirectory()) continue
          age = now - stat.mtimeMs
        } catch {
          continue
        }
        if (age < ORPHAN_MS) continue
        result.removed.push(path)
        if (!apply) continue
        const repo = repoOfWorktree(path)
        if (repo) repos.add(repo)
        await this.trash(path)
      }
    }
    if (apply) {
      for (const repo of repos) if (existsSync(repo)) await this.withGit(repo, () => git(repo, ["worktree", "prune"]))
      this.emptyTrash(join(root, TRASH))
      this.rebalanceAll()
    }
    return result
  }

  // ---------- keeping your checkouts up to date ----------

  /**
   * Every hour, when turned on: fetches each repo used in the last 30 days and fast-forwards your own
   * checkout, but only when it's on the base branch with nothing uncommitted. Never merges, never installs.
   */
  private async updateJob(): Promise<string> {
    const now = Date.now()
    const used = new Set(this.data.events.filter((e) => e.type === "up" && now - e.t < POOL.dormant).map((e) => e.repo))
    let updated = 0
    let current = 0
    const skipped: string[] = []
    for (const repo of Object.values(this.data.repos)) {
      if (!used.has(repo.source) || !existsSync(repo.source)) continue
      const result = await this.updateSource(repo)
      repo.updated = { at: Date.now(), result }
      if (result.startsWith("Updated")) updated++
      else if (result === "Up to date") current++
      else skipped.push(`${this.label(repo)} (${result.toLowerCase()})`)
    }
    return [
      updated ? `${updated} updated` : "",
      current ? `${current} already up to date` : "",
      skipped.length ? `skipped ${skipped.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(", ") || "No repo used in the last 30 days"
  }

  private async updateSource(repo: RepoState): Promise<string> {
    const fetched = await this.withGit(repo.source, () => git(repo.source, ["fetch", "origin", repo.baseBranch, "--quiet"], 5 * MINUTE))
    if (fetched.code !== 0) return "Couldn't fetch"
    this.fetched.set(repo.source, Date.now())
    const branch = (await git(repo.source, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim()
    if (branch !== repo.baseBranch) return branch ? `On ${branch}` : "Detached"
    const dirty = await git(repo.source, ["status", "--porcelain", "--untracked-files=no"])
    if (dirty.code !== 0 || dirty.stdout.trim()) return "Has uncommitted changes"
    const before = (await git(repo.source, ["rev-parse", "HEAD"])).stdout.trim()
    const merged = await this.withGit(repo.source, () => git(repo.source, ["merge", "--ff-only", "--quiet", `origin/${repo.baseBranch}`]))
    if (merged.code !== 0) return "Can't fast-forward"
    const after = (await git(repo.source, ["rev-parse", "HEAD"])).stdout.trim()
    return after === before ? "Up to date" : `Updated to ${after.slice(0, 8)}`
  }

  // ---------- views ----------

  private repoView(repo: RepoState): WorktreeRepoView {
    const now = Date.now()
    const all = this.of(repo.source)
    const count = (...status: Worktree["status"][]) => all.filter((w) => status.includes(w.status)).length
    const ups = this.data.events.filter((e): e is Extract<WorktreeEvent, { type: "up" }> => e.repo === repo.source && e.type === "up")
    const recent = ups.filter((e) => now - e.t <= POOL.window)
    return {
      source: repo.source,
      ...(repo.name ? { name: repo.name } : {}),
      baseBranch: repo.baseBranch,
      setup: repo.setup,
      warm: repo.warm,
      maxTotal: repo.maxTotal,
      label: this.label(repo),
      target: this.target(repo),
      auto: repo.warm === null,
      counts: {
        ready: count("ready"),
        attached: count("attached"),
        building: count("building", "resetting"),
        released: count("released"),
        total: all.filter((w) => w.status !== "removing").length,
      },
      usage: {
        taken: recent.length,
        instant: recent.length ? recent.filter((e) => e.warm).length / recent.length : null,
        buildMs: this.buildMs(repo.source),
        lastTaken: ups.length ? ups[ups.length - 1].t : null,
      },
      ...(repo.error ? { error: repo.error } : {}),
      ...(repo.updated ? { updated: repo.updated } : {}),
    }
  }

  /** For Settings and `ctrl worktree config`: repos most recently used first. Cached until something changes. */
  view(): WorktreesView {
    this.cached ??= {
      root: this.root(),
      repos: Object.values(this.data.repos)
        .map((r) => this.repoView(r))
        .sort((a, b) => (b.usage.lastTaken ?? 0) - (a.usage.lastTaken ?? 0) || a.label.localeCompare(b.label)),
      jobs: this.data.jobs,
    }
    return this.cached
  }

  async repo(token: string, cwd?: string): Promise<WorktreeRepoView> {
    const { source, repo } = await this.resolveSource(token, cwd)
    if (!repo) throw new WorktreeError("NOT_FOUND", `${source} isn't a repo ctrl manages yet`, { hint: `ctrl worktree up ${source} registers it` })
    return this.repoView(repo)
  }

  all(): Worktree[] {
    return this.data.worktrees
  }

  /** Worktrees a session holds, or that are being built for it. */
  ofSession(sessionID: string): Worktree[] {
    return this.data.worktrees.filter((w) => w.sessionID === sessionID && (w.status === "attached" || w.status === "building"))
  }

  name(wt: Worktree) {
    const repo = this.data.repos[wt.repo]
    return repo ? this.label(repo) : basename(wt.repo)
  }

  /** With the branch it's on right now, read from git. */
  async describe(wt: Worktree): Promise<WorktreeView> {
    const live = wt.status === "building" ? { branch: null, commit: null } : await branchInfo(wt.path)
    this.live.set(wt.id, live)
    return { ...wt, name: this.name(wt), branch: live.branch, commit: live.commit }
  }

  /** The last branch read for a worktree, without asking git (the resources panel's first paint). */
  knownBranch(wt: Worktree) {
    return this.live.get(wt.id)?.branch ?? null
  }
}

export type CleanupResult = {
  released: { id: string; path: string; sessionID: string; reason: string }[]
  dropped: { id: string; path: string }[]
  removed: string[]
}

const summarize = (r: CleanupResult) =>
  [
    r.released.length ? `released ${plural(r.released.length, "worktree")} of archived or deleted sessions` : "",
    r.dropped.length ? `dropped ${r.dropped.length} whose folder was gone` : "",
    r.removed.length ? `removed ${plural(r.removed.length, "folder")} nothing tracked` : "",
  ]
    .filter(Boolean)
    .join(", ") || "Nothing to clean up"

const safeList = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The repo a worktree folder belongs to, from its `.git` file ("gitdir: <repo>/.git/worktrees/<name>"). */
const repoOfWorktree = (path: string): string | null => {
  try {
    const m = /^gitdir: (.+)\/\.git\/worktrees\/[^/]+\s*$/m.exec(readFileSync(join(path, ".git"), "utf8"))
    return m ? m[1] : null
  } catch {
    return null
  }
}

const describeUnsaved = (u: Unsaved) =>
  [
    u.dirty.length ? `${plural(u.dirty.length, "uncommitted file")} (${u.dirty.slice(0, 5).join(", ")}${u.dirty.length > 5 ? ", …" : ""})` : "",
    u.unpushed ? `${plural(u.unpushed, "commit")} on ${u.branch} that no remote has` : "",
    u.orphans ? `${plural(u.orphans, "commit")} on a detached HEAD that no branch contains` : "",
  ]
    .filter(Boolean)
    .join(" and ")

const unsavedHint = (u: Unsaved, wt: Worktree) =>
  u.orphans
    ? `Save them on a branch (git -C ${wt.path} switch -c <branch> && git push -u origin <branch>), or pass --force (a rescue ref keeps them)`
    : `Commit and push first, or pass --force to discard: recycling resets the worktree to its base branch`
