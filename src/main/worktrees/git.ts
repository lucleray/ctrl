import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export type RunResult = { code: number | null; stdout: string; stderr: string }

/** Git and friends never ask questions here: a prompt would hang a background job. */
const ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }

const GIT_TIMEOUT = 10 * 60_000

/** Runs a program without a shell or a terminal. Never throws: a failure is a non-zero `code`. */
export const run = (command: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? GIT_TIMEOUT, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...ENV } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === 1 ? err.message : "") })
      },
    )
  })

export const git = (cwd: string, args: string[], timeout?: number) => run("git", ["-C", cwd, ...args], { timeout })

/** Like git(), but a failure throws with git's own message. */
export const gitOrThrow = async (cwd: string, args: string[], timeout?: number) => {
  const res = await git(cwd, args, timeout)
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${lastLines(res.stderr || res.stdout)}`)
  return res.stdout.trim()
}

const lastLines = (text: string, lines = 6) => text.trim().split("\n").slice(-lines).join("\n")

const formatMinutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`)

/**
 * Runs a repo's setup command (e.g. `pnpm install --frozen-lockfile`) in a shell, with stdin closed and
 * only the end of its output kept. Never throws.
 */
export const runSetup = (command: string, cwd: string, timeout = 30 * 60_000): Promise<{ ok: boolean; detail: string }> =>
  new Promise((resolve) => {
    // Its own process group, so a timeout kills what it started too (pnpm's workers), not just the shell.
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...ENV } })
    let tail = ""
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000)
    }
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, timeout)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: err.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      // The output's tail says nothing about a kill: it ends wherever the command was.
      if (timedOut) return resolve({ ok: false, detail: `Timed out after ${formatMinutes(timeout)}, killed. Last output:\n${lastLines(tail)}` })
      resolve({ ok: code === 0, detail: code === 0 ? "" : lastLines(tail) || `exited with ${code}` })
    })
  })

/** The setup command a repo most likely wants, from its lockfile; null when nothing is recognized. */
export function suggestSetup(source: string): string | null {
  const has = (file: string) => existsSync(join(source, file))
  if (has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile"
  if (has("yarn.lock")) return has(".yarnrc.yml") ? "yarn install --immutable" : "yarn install --frozen-lockfile"
  if (has("bun.lockb") || has("bun.lock")) return "bun install --frozen-lockfile"
  if (has("package-lock.json")) return "npm ci"
  if (has("Cargo.toml")) return "cargo fetch"
  if (has("go.mod")) return "go mod download"
  return null
}

/** The branch worktrees start from: origin's default branch, else the one checked out, else main. */
export async function detectBaseBranch(source: string): Promise<string> {
  const head = await git(source, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, "")
  for (const name of ["main", "master"]) {
    const res = await git(source, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])
    if (res.code === 0) return name
  }
  const current = await git(source, ["symbolic-ref", "--short", "-q", "HEAD"])
  return (current.code === 0 && current.stdout.trim()) || "main"
}

/** origin/<base> when the remote has it, else the local branch (repos without a remote). */
export async function baseRef(source: string, baseBranch: string): Promise<string> {
  const remote = await git(source, ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`])
  return remote.code === 0 ? `origin/${baseBranch}` : baseBranch
}

/** Branch and commit a worktree is on, with git plumbing only (no working-tree scan). */
export async function branchInfo(path: string): Promise<{ branch: string | null; commit: string | null }> {
  if (!existsSync(path)) return { branch: null, commit: null }
  const [ref, rev] = await Promise.all([
    git(path, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(path, ["rev-parse", "--short", "HEAD"]),
  ])
  return {
    branch: ref.code === 0 ? ref.stdout.trim() || null : null,
    commit: rev.code === 0 ? rev.stdout.trim() || null : null,
  }
}

export type Unsaved = {
  branch: string | null
  /** Uncommitted or untracked files (first few) */
  dirty: string[]
  /** Commits on a branch that no remote has */
  unpushed: number
  /** Commits on a detached HEAD that no branch, remote or tag contains */
  orphans: number
}

/**
 * What recycling a worktree would lose: one `git status`, plus a history walk only when the branch has
 * commits its upstream lacks or a detached HEAD moved off the commit it was warmed at.
 */
export async function unsavedWork(path: string, baseCommit: string | null): Promise<Unsaved> {
  const out: Unsaved = { branch: null, dirty: [], unpushed: 0, orphans: 0 }
  if (!existsSync(path)) return out
  const res = await git(path, ["status", "--porcelain=v2", "--branch"])
  if (res.code !== 0) return out
  let commit: string | null = null
  let hasUpstream = false
  let ahead = 0
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length).trim()
      out.branch = v === "(detached)" ? null : v
    } else if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim()
      commit = oid === "(initial)" ? null : oid
    } else if (line.startsWith("# branch.upstream ")) hasUpstream = true
    else if (line.startsWith("# branch.ab ")) ahead = Number(/\+(\d+)/.exec(line)?.[1] ?? 0)
    else if (line && !line.startsWith("#")) {
      // "? <path>", or a fixed number of fields before the path: 8 (changed), 9 (renamed, then a tab and the old path), 10 (unmerged).
      const fields = line[0] === "2" ? 9 : line[0] === "u" ? 10 : 8
      out.dirty.push(line.startsWith("? ") ? line.slice(2) : line.split("\t")[0].split(" ").slice(fields).join(" "))
    }
  }
  if (out.branch && commit && (!hasUpstream || ahead > 0)) {
    // A missing or stale upstream doesn't mean unpushed: any remote ref holding HEAD does.
    const remote = await git(path, ["for-each-ref", "--count=1", "--contains=HEAD", "--format=%(refname)", "refs/remotes"])
    if (!(remote.code === 0 && remote.stdout.trim())) {
      const count = await git(path, ["rev-list", "--count", "HEAD", "--not", "--remotes"])
      out.unpushed = Math.max(1, Number(count.stdout.trim()) || 0)
    }
  }
  if (!out.branch && commit && !(baseCommit && commit.startsWith(baseCommit))) {
    const count = await git(path, ["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes", "--tags"])
    out.orphans = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0
  }
  return out
}

export const hasUnsaved = (u: Unsaved) => u.dirty.length > 0 || u.unpushed > 0 || u.orphans > 0

/** Pins a detached HEAD's commits under refs/ctrl/rescue/, so they outlive the worktree being recycled. */
export async function writeRescueRef(path: string, id: string): Promise<string | null> {
  const ref = `refs/ctrl/rescue/${id}-${Math.floor(Date.now() / 1000)}`
  const res = await git(path, ["update-ref", ref, "HEAD"])
  return res.code === 0 ? ref : null
}
