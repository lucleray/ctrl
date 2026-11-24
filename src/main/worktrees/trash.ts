import { execFileSync, spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** In a trash folder: the pid of the `rm` emptying it, so a second one never starts on the same files. */
export const DELETER = ".deleting"

/** Past this, a marker no longer holds anything back, whatever its pid turned into. */
const STALE_MS = 6 * 60 * 60_000

/** macOS's background QoS throttles the rm's disk I/O, so it yields to installs and git. */
const TASKPOLICY = "/usr/sbin/taskpolicy"

/** Whether the marker names an `rm` that's still running (a previous ctrl's, or this one's). */
export function deleterAlive(trash: string, now = Date.now()): boolean {
  const marker = join(trash, DELETER)
  try {
    if (now - statSync(marker).mtimeMs > STALE_MS) return false
    const pid = Number(readFileSync(marker, "utf8").trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    // A reused pid isn't ours: only an rm (or taskpolicy before it execs rm) counts.
    const comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim()
    return /(^|\/)(rm|taskpolicy)$/.test(comm)
  } catch {
    return false
  }
}

/**
 * Deletes everything in trash folders with one `rm` per folder at a time, at background I/O priority.
 * Folders trashed while it runs get the next `rm`, started when this one exits. Entries an rm couldn't
 * delete aren't retried right away (that would spin): the next `empty` call picks them up.
 */
export class TrashEmptier {
  private running = new Map<string, Set<string>>()

  constructor(private readonly spawnRm: (paths: string[]) => ReturnType<typeof spawn> = defaultSpawnRm) {}

  empty(trash: string, skip: Set<string> = new Set()) {
    if (this.running.has(trash) || deleterAlive(trash)) return
    let entries: string[]
    try {
      entries = readdirSync(trash).filter((e) => e !== DELETER && !skip.has(e))
    } catch {
      return
    }
    if (!entries.length) {
      rmSync(join(trash, DELETER), { force: true })
      return
    }
    const batch = new Set(entries)
    this.running.set(trash, batch)
    let child: ReturnType<typeof spawn>
    try {
      child = this.spawnRm(entries.map((e) => join(trash, e)))
    } catch {
      this.running.delete(trash)
      return
    }
    if (child.pid) writeFileSync(join(trash, DELETER), String(child.pid))
    let done = false
    const finish = () => {
      if (done) return
      done = true
      this.running.delete(trash)
      rmSync(join(trash, DELETER), { force: true })
      this.empty(trash, batch)
    }
    child.on("error", finish)
    child.on("exit", finish)
    child.unref()
  }

  /** Whether an rm started here is still emptying that folder. */
  busy(trash: string) {
    return this.running.has(trash)
  }
}

function defaultSpawnRm(paths: string[]) {
  const [command, args] = existsSync(TASKPOLICY) ? [TASKPOLICY, ["-b", "rm", "-rf", ...paths]] : ["rm", ["-rf", ...paths]]
  return spawn(command, args, { stdio: "ignore", detached: true })
}
