import { execFile } from "node:child_process"
import { existsSync, watch, type FSWatcher } from "node:fs"
import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { FX_PREFIX, type FxCheck, type SessionItem, type SessionStatus } from "../shared/types"

/** fx's profile folder; CTRL_FX_HOME is a debug hook for throwaway sessions. */
export const FX_HOME = process.env.CTRL_FX_HOME || join(homedir(), ".fx")
export const SESSIONS_DIR = join(FX_HOME, "sessions")

/** ctrl id ("fx:KvHk…") ↔ fx's own id ("KvHk…"). */
export const fxID = (raw: string) => `${FX_PREFIX}${raw}`
export const rawID = (id: string) => (id.startsWith(FX_PREFIX) ? id.slice(FX_PREFIX.length) : id)

/** Where fx's installer puts it, then PATH (resolved from the login shell at launch). */
export function findFx() {
  const path = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "fx"))
  return [join(homedir(), ".local/bin/fx"), "/opt/homebrew/bin/fx", "/usr/local/bin/fx", ...path].find((p) =>
    existsSync(p),
  )
}

export function checkFx(): Promise<FxCheck> {
  const bin = findFx()
  if (!bin) return Promise.resolve({ state: "missing" })
  return new Promise((resolve) =>
    execFile(bin, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve({ state: "missing" })
      resolve({ state: "ok", version: stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? stdout.trim(), bin })
    }),
  )
}

/** Coalesce a burst of writes to one session (events, session.json, usage) into one re-read. */
const READ_DEBOUNCE_MS = 100
/**
 * fx keeps events.jsonl open and appends to it, and macOS only reports those writes once the file
 * is closed (when fx quits). So sessions with a live fx process are checked on a timer instead:
 * one stat each, and only those few sessions.
 */
const POLL_MS = 2000
/** Tail window for finding the last event; doubles until it holds the start of the last line. */
const TAIL_START = 16 * 1024
const TAIL_MAX = 4 * 1024 * 1024

/** What the last line of events.jsonl says about the turn. */
type TurnState = "none" | "in-turn" | "completed" | "interrupted"

/** Everything we know about one session from its folder. */
export type FxSession = {
  /** fx's own id (no prefix) */
  id: string
  title?: string
  directory: string
  created: number
  updated: number
  /** events.jsonl has content: sessions fx creates on launch stay hidden until used */
  used: boolean
  turn: TurnState
  /** When the last turn ended (completed or interrupted) */
  turnEnded?: number
  /** pid in owner.live, when that process is alive */
  ownerPid?: number
  /** events.jsonl size as of the last read, to notice appends while polling */
  size: number
}

/** Live status of a session open in ctrl, from OSC 7501 reports (see fx-terminals.ts). */
export type LiveStatus = { state: "idle" | "working" | "done" | "blocked" | "error"; msg?: string }

/** Session ids here are ctrl's ("fx:…"). */
type Deps = {
  onChange(): void
  /** OSC 7501 status for a session open in ctrl, if its fx reports one */
  liveStatus(sessionID: string): LiveStatus | undefined
  /** ctrl has an fx process for this pid */
  isOurPid(pid: number): boolean
  /** Session id now owned by one of our processes (after a new session or /new) */
  onOwner(sessionID: string, pid: number): void
  viewedAt(sessionID: string): number | undefined
  titleOverride(sessionID: string): string | undefined
  currentSessionID(): string | null
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Mirrors ~/.fx/sessions. There's no server: one scan on launch, then a
 * recursive fs watcher re-reads just the session folder that changed, so an
 * update costs the same with 50 or 5,000 sessions.
 */
export class FxSessions {
  sessions: SessionItem[] = []
  problem: string | null = null
  private all = new Map<string, FxSession>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private watcher?: FSWatcher
  private poller?: ReturnType<typeof setInterval>
  private rebuildQueued = false

  constructor(private deps: Deps) {}

  /** By ctrl id ("fx:…"). */
  get(id: string) {
    return this.all.get(rawID(id))
  }

  async start() {
    try {
      const ids = await readdir(SESSIONS_DIR)
      await Promise.all(ids.map((id) => this.read(id, false)))
      console.log(`[ctrl] scanned ${this.all.size} fx sessions`)
      this.problem = null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.problem = `Can't read ${SESSIONS_DIR}: ${String(err)}`
    }
    this.rebuild()
    this.watch()
    this.poller ??= setInterval(() => void this.poll(), POLL_MS)
  }

  /** Re-reads sessions with a live fx process whose log grew, or whose process is gone. */
  private async poll() {
    for (const s of this.all.values()) {
      if (s.ownerPid === undefined) continue
      if (!alive(s.ownerPid)) {
        this.readSoon(s.id)
        continue
      }
      const size = await stat(join(SESSIONS_DIR, s.id, "events.jsonl")).then((st) => st.size, () => 0)
      if (size !== s.size) this.readSoon(s.id)
    }
  }

  private watch() {
    try {
      this.watcher = watch(SESSIONS_DIR, { recursive: true }, (_event, file) => {
        if (!file) return
        const id = String(file).split("/")[0]
        // Tool output and command replays don't change anything we show.
        if (/\/(tool-results|logs)\//.test(String(file))) return
        this.readSoon(id)
      })
      this.watcher.on("error", (err) => console.error("[ctrl] fx sessions watcher failed", err))
    } catch {
      // No sessions folder yet: fx creates it on first launch.
      setTimeout(() => void this.start(), 3000)
    }
  }

  /** Re-read one session soon (fx's own id). */
  readSoon(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        void this.read(id, true)
      }, READ_DEBOUNCE_MS),
    )
  }

  private async read(id: string, notify: boolean) {
    const dir = join(SESSIONS_DIR, id)
    try {
      const [meta, events, owner] = await Promise.all([
        readFile(join(dir, "session.json"), "utf8").then(JSON.parse),
        stat(join(dir, "events.jsonl")).catch(() => undefined),
        readFile(join(dir, "owner.live"), "utf8").then(JSON.parse, () => undefined),
      ])
      if (meta.subagent_child) return
      const ownerPid = typeof owner?.pid === "number" && alive(owner.pid) ? owner.pid : undefined
      const tail = events?.size ? await lastEvent(join(dir, "events.jsonl"), events.size) : undefined
      const session: FxSession = {
        id,
        title: typeof meta.title === "string" && meta.title ? meta.title : undefined,
        directory: meta.workspace_root || meta.origin_workspace_root || homedir(),
        created: meta.created_at_ms ?? 0,
        updated: Math.max(meta.updated_at_ms ?? 0, events?.mtimeMs ?? 0),
        used: !!events?.size,
        turn: tail?.turn ?? "none",
        turnEnded: tail?.ended,
        ownerPid,
        size: events?.size ?? 0,
      }
      this.all.set(id, session)
      if (ownerPid && this.deps.isOurPid(ownerPid)) this.deps.onOwner(fxID(id), ownerPid)
    } catch {
      // Deleted, or caught mid-write (the next change event re-reads it).
      if (!this.all.delete(id)) return
    }
    if (notify) this.rebuild()
  }

  /** Coalesces rebuilds (a burst of reads, status reports) into one per tick. */
  rebuild() {
    if (this.rebuildQueued) return
    this.rebuildQueued = true
    queueMicrotask(() => {
      this.rebuildQueued = false
      this.rebuildNow()
    })
  }

  private rebuildNow() {
    this.sessions = [...this.all.values()]
      .filter((s) => s.used || (s.ownerPid !== undefined && this.deps.isOurPid(s.ownerPid)))
      .sort((a, b) => b.updated - a.updated)
      .map((s): SessionItem => {
        const id = fxID(s.id)
        const ours = s.ownerPid !== undefined && this.deps.isOurPid(s.ownerPid)
        return {
          id,
          harness: "fx",
          title: this.deps.titleOverride(id) ?? s.title ?? "New session",
          directory: s.directory,
          updated: s.updated,
          elsewhere: s.ownerPid !== undefined && !ours,
          ...this.statusOf(s, id, ours),
        }
      })
    this.deps.onChange()
  }

  private statusOf(s: FxSession, id: string, ours: boolean): { status: SessionStatus; statusDetail?: string } {
    const current = id === this.deps.currentSessionID()
    const live = ours ? this.deps.liveStatus(id) : undefined
    if (live?.state === "blocked") return { status: "needs-input", statusDetail: live.msg || "Waiting for you" }
    if (live?.state === "working") return { status: "running", statusDetail: "Running" }
    if (live?.state === "error" && !current) return { status: "failed", statusDetail: "Failed" }
    // No OSC 7501 (older fx, or another terminal): a turn that started and didn't end, in a live process, is running.
    if (!live && s.turn === "in-turn" && s.ownerPid !== undefined)
      return { status: "running", statusDetail: ours ? "Running" : "Running in another terminal" }
    const finished = s.turn === "completed" && s.turnEnded !== undefined
    if (finished && !current && s.turnEnded! > (this.deps.viewedAt(id) ?? 0))
      return { status: "unread", statusDetail: "Finished · unread" }
    if (s.ownerPid !== undefined && !ours) return { status: "idle", statusDetail: "Open in another terminal" }
    return { status: "idle" }
  }

  /** When the last turn ended, for marking it read. */
  lastActivity(id: string) {
    const s = this.get(id)
    return s?.turnEnded ?? s?.updated
  }

  /**
   * fx keeps the title in session.json and rewrites it while it runs, so only
   * write when no fx owns the session (callers keep an override meanwhile).
   */
  async writeTitle(id: string, title: string) {
    const file = join(SESSIONS_DIR, rawID(id), "session.json")
    const meta = JSON.parse(await readFile(file, "utf8"))
    meta.title = title
    // Atomic swap so fx never reads a half-written file. fx refuses session files
    // others can read (PrivateStatePermissionsUnsupported), so keep them 0600.
    const tmp = `${file}.ctrl-${process.pid}`
    await writeFile(tmp, JSON.stringify(meta), { mode: 0o600 })
    await rename(tmp, file)
    const s = this.get(id)
    if (s) s.title = title
    this.rebuild()
  }

  forget(id: string) {
    this.all.delete(rawID(id))
    this.rebuild()
  }

  stop() {
    this.watcher?.close()
    clearInterval(this.poller)
    for (const t of this.timers.values()) clearTimeout(t)
  }
}

const EVENT_RE = /"timestamp_ms":(\d+),"event":\{"(\w+)"/

/** Reads the start of the last line of events.jsonl, growing the window for huge lines. */
async function lastEvent(file: string, size: number): Promise<{ turn: TurnState; ended?: number } | undefined> {
  const fh = await open(file, "r")
  try {
    for (let window = TAIL_START; ; window *= 2) {
      const len = Math.min(window, size)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, size - len)
      const text = buf.toString("utf8").replace(/\n+$/, "")
      const nl = text.lastIndexOf("\n")
      if (nl === -1 && len < size && window < TAIL_MAX) continue
      const m = text.slice(nl + 1).match(EVENT_RE)
      if (!m) return undefined
      const at = Number(m[1])
      const kind = m[2]
      if (kind === "turn_completed") return { turn: "completed", ended: at }
      if (kind === "interrupted") return { turn: "interrupted", ended: at }
      if (kind === "context_checkpoint") return { turn: "none" }
      return { turn: "in-turn" }
    }
  } finally {
    await fh.close()
  }
}
