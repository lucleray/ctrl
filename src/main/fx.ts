import { execFile } from "node:child_process"
import { existsSync, watch, type FSWatcher } from "node:fs"
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { HarnessSource } from "./harness"
import { FX_PREFIX, type FxCheck, type SessionActivity, type SessionItem, type SessionStatus } from "../shared/types"
import {
  FX_ENV,
  INDEX_FILE,
  isV1Name,
  isV2Name,
  lastTurn,
  readIndex,
  SESSIONS_DIR,
  v1Log,
  v2Dir,
  v2Lock,
  v2Log,
  type IndexEntry,
  type TurnState,
} from "./fx-store"

export { FX_ENV, FX_HOME, SESSIONS_DIR } from "./fx-store"

/** ctrl id ("fx:KvHk…") ↔ fx's own id ("KvHk…"). */
export const fxID = (raw: string) => `${FX_PREFIX}${raw}`
export const rawID = (id: string) => (id.startsWith(FX_PREFIX) ? id.slice(FX_PREFIX.length) : id)

/** Where fx's installer puts it, then PATH (resolved from the login shell at launch). CTRL_FX is a debug hook. */
export function findFx() {
  if (process.env.CTRL_FX) return existsSync(process.env.CTRL_FX) ? process.env.CTRL_FX : undefined
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
 * fx keeps its logs open and appends to them, and macOS only reports those writes once the file is closed
 * (when fx quits). The same goes for v2's index. So live sessions and the index are checked on a timer
 * instead: one stat each, and only those few files.
 */
const POLL_MS = 2000

/** Everything we know about one session from its folder. */
export type FxSession = {
  /** fx's own id (no prefix) */
  id: string
  /** v1: ~/.fx/sessions/<id>/ (fx ≤ 0.0.16) · v2: ~/.fx/sessions/v2/<id>/ (see fx-store.ts) */
  layout: "v1" | "v2"
  title?: string
  directory: string
  created: number
  updated: number
  /** The log has content: v1 sessions fx creates on launch stay hidden until used (v2 creates none until used) */
  used: boolean
  turn: TurnState
  /** When the last turn ended (completed or interrupted) */
  turnEnded?: number
  /** pid of the fx process that has it open: v1's owner.live, v2's lock holder (lsof) */
  ownerPid?: number
  /** log size as of the last read, to notice appends while polling */
  size: number
  /** v1: recovery.json exists, fx is mid-turn (v1 writes a turn to events.jsonl only once it ends) */
  recovery: boolean
}

/** Live status of a session open in ctrl, from OSC 7501 reports (see fx-terminals.ts). */
export type LiveStatus = { state: "idle" | "working" | "done" | "blocked" | "error"; msg?: string }

/** A subagent as `fx sessions --live --json` lists it, with its own subagents. */
export type LiveAgent = { name: string; id: string; state: string; title?: string; agents: LiveAgent[] }
type LiveSession = { id: string; state: string; agents: LiveAgent[] }

/** Session ids here are ctrl's ("fx:…"). */
type Deps = {
  onChange(): void
  /** OSC 7501 status for a session open in ctrl, if its fx reports one */
  liveStatus(sessionID: string): LiveStatus | undefined
  /** ctrl has an fx process for this pid */
  isOurPid(pid: number): boolean
  /** pids of the fx processes ctrl runs */
  ourPids(): number[]
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
 * Mirrors ~/.fx/sessions, both layouts (src/main/fx-store.ts). There's no server: one scan on launch,
 * then a recursive fs watcher re-reads just the session folder that changed, so an update costs the same
 * with 50 or 5,000 sessions.
 *
 * Who has a v2 session open: fx only holds a flock on its `lock` file. `fx sessions --live --json` says
 * which sessions are open (and their subagents), and `lsof` on those few lock files says by which process.
 * Both run off the main thread, only while something may be live (an fx ctrl runs, a session that was
 * live, or the index changed).
 */
export class FxSessions implements HarnessSource {
  readonly harness = "fx" as const
  sessions: SessionItem[] = []
  problem: string | null = null
  private all = new Map<string, FxSession>()
  private index = new Map<string, IndexEntry>()
  private indexOffset = 0
  private indexSize = -1
  /** Root sessions some fx process has open, with their subagents (fx sessions --live) */
  private live = new Map<string, LiveSession>()
  /** pid holding each open v2 session's lock */
  private owners = new Map<string, number>()
  private liveRunning?: Promise<void>
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private watcher?: FSWatcher
  private poller?: ReturnType<typeof setInterval>
  private rebuildQueued = false

  constructor(
    private deps: Deps,
    private bin: () => string | undefined = findFx,
  ) {}

  /** By ctrl id ("fx:…"). */
  get(id: string) {
    return this.all.get(rawID(id))
  }

  async start() {
    try {
      const names = await readdir(SESSIONS_DIR)
      await Promise.all(names.filter(isV1Name).map((id) => this.readV1(id, false)))
      await this.readIndex(false)
      console.log(`[ctrl] scanned ${this.all.size} fx sessions`)
      this.problem = null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.problem = `Can't read ${SESSIONS_DIR}: ${String(err)}`
    }
    this.rebuild()
    this.watch()
    this.poller ??= setInterval(() => void this.poll(), POLL_MS)
    void this.refreshLive()
  }

  /** Re-reads what may have changed without the watcher noticing: the index, live logs, live owners. */
  private async poll() {
    const indexSize = await stat(INDEX_FILE).then((st) => st.size, () => 0)
    const indexChanged = indexSize !== this.indexSize
    if (indexChanged) await this.readIndex(true)
    for (const s of this.all.values()) {
      if (s.ownerPid === undefined) continue
      if (s.layout === "v1") {
        if (!alive(s.ownerPid)) {
          this.readSoon(s.id)
          continue
        }
        const dir = join(SESSIONS_DIR, s.id)
        const size = await stat(join(dir, "events.jsonl")).then((st) => st.size, () => 0)
        if (size !== s.size || existsSync(join(dir, "recovery.json")) !== s.recovery) this.readSoon(s.id)
        continue
      }
      const size = await stat(v2Log(s.id)).then((st) => st.size, () => 0)
      if (size !== s.size) this.readSoon(s.id)
    }
    if (indexChanged || this.live.size || this.deps.ourPids().length) await this.refreshLive()
  }

  /**
   * Which v2 sessions are open, by which process. Shared while one runs. A new owner that is one of
   * ctrl's processes is claimed (a brand-new session got its id, or /new, /resume switched it).
   */
  refreshLive() {
    this.liveRunning ??= this.readLive().finally(() => (this.liveRunning = undefined))
    return this.liveRunning
  }

  private async readLive() {
    const bin = this.bin()
    if (!bin) return
    const json = await run(bin, ["sessions", "--live", "--all", "--json"]).catch(() => undefined)
    if (json === undefined) return
    let listed: LiveSession[]
    try {
      listed = (JSON.parse(json) as { sessions?: LiveSession[] }).sessions ?? []
    } catch {
      return
    }
    const next = new Map(listed.filter((l) => typeof l.id === "string").map((l) => [l.id, { ...l, agents: l.agents ?? [] }]))
    const agentsChanged = JSON.stringify([...next.values()]) !== JSON.stringify([...this.live.values()])
    this.live = next
    // Owners: lsof on the lock files of open sessions, one call.
    const owners = next.size ? await lockOwners([...next.keys()]) : new Map<string, number>()
    this.owners = owners
    let changed = agentsChanged
    for (const s of this.all.values()) {
      if (s.layout !== "v2") continue
      const pid = owners.get(s.id)
      if (pid === s.ownerPid) continue
      s.ownerPid = pid
      changed = true
      // An open session's log is checked on the poll timer; a closed one gets a last read.
      this.readSoon(s.id)
    }
    // Sessions too new to be read yet get their owner once read.
    for (const id of owners.keys()) if (!this.all.has(id)) this.readSoon(id)
    for (const s of this.all.values())
      if (s.layout === "v2" && s.ownerPid !== undefined && this.deps.isOurPid(s.ownerPid)) this.deps.onOwner(fxID(s.id), s.ownerPid)
    if (changed) this.rebuild()
  }

  private watch() {
    try {
      this.watcher = watch(SESSIONS_DIR, { recursive: true }, (_event, file) => {
        if (!file) return
        const parts = String(file).split("/")
        if (parts[0] === "v2") {
          if (parts[1] === "index.jsonl") return void this.readIndex(true)
          if (!parts[1] || !isV2Name(parts[1])) return
          if (parts[2] === "blobs") return
          return this.readSoon(parts[1])
        }
        if (!isV1Name(parts[0])) return
        // Tool output and command replays don't change anything we show.
        if (/\/(tool-results|logs)\//.test(String(file))) return
        this.readSoon(parts[0])
      })
      this.watcher.on("error", (err) => console.error("[ctrl] fx sessions watcher failed", err))
    } catch {
      // No sessions folder yet: fx creates it on first launch.
      setTimeout(() => void this.start(), 3000)
    }
  }

  /** Reads what's new in v2's index, then the sessions it changed. */
  private async readIndex(notify: boolean) {
    const r = await readIndex(this.index, this.indexOffset).catch(() => undefined)
    if (!r) return
    this.indexOffset = r.offset
    this.indexSize = await stat(INDEX_FILE).then((st) => st.size, () => 0)
    const ids = r.reset ? [...this.index.keys(), ...[...this.all.values()].filter((s) => s.layout === "v2").map((s) => s.id)] : r.changed
    await Promise.all([...new Set(ids)].map((id) => this.readV2(id, false)))
    if (notify) this.rebuild()
  }

  /** Re-read one session soon (fx's own id). */
  readSoon(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        void this.read(id)
      }, READ_DEBOUNCE_MS),
    )
  }

  private async read(id: string) {
    // fx converts a v1 session in place (same id): once v2 has it, the v1 folder doesn't count.
    if (this.index.has(id) || existsSync(v2Dir(id))) await this.readV2(id, true)
    else await this.readV1(id, true)
  }

  private async readV2(id: string, notify: boolean) {
    try {
      let entry = this.index.get(id)
      // A session folder shows up before its index line is read (the index changes without fs events).
      if (!entry) {
        await this.readIndex(false)
        entry = this.index.get(id)
      }
      const log = await stat(v2Log(id)).catch(() => undefined)
      if (!entry || !log) throw new Error("gone")
      if (entry.role === "child") return
      const tail = await lastTurn("v2", v2Log(id), log.size)
      const session: FxSession = {
        id,
        layout: "v2",
        title: entry.title,
        directory: entry.workspace || homedir(),
        created: entry.created,
        updated: Math.max(entry.updated, log.mtimeMs),
        used: log.size > 0,
        turn: tail?.turn ?? "none",
        turnEnded: tail?.ended,
        ownerPid: this.owners.get(id),
        size: log.size,
        recovery: false,
      }
      this.all.set(id, session)
    } catch {
      // Deleted (fx moves it to .trash and tombstones the index), or not written yet.
      if (this.all.get(id)?.layout === "v2" && this.all.delete(id) && notify) this.rebuild()
      if (existsSync(join(SESSIONS_DIR, id))) await this.readV1(id, notify)
      return
    }
    if (notify) this.rebuild()
  }

  private async readV1(id: string, notify: boolean) {
    const dir = join(SESSIONS_DIR, id)
    try {
      const [meta, events, owner] = await Promise.all([
        readFile(join(dir, "session.json"), "utf8").then(JSON.parse),
        stat(v1Log(id)).catch(() => undefined),
        readFile(join(dir, "owner.live"), "utf8").then(JSON.parse, () => undefined),
      ])
      if (meta.subagent_child) return
      // Converted to v2 since: that copy wins.
      if (this.all.get(id)?.layout === "v2") return
      const ownerPid = typeof owner?.pid === "number" && alive(owner.pid) ? owner.pid : undefined
      const tail = events?.size ? await lastTurn("v1", v1Log(id), events.size) : undefined
      const recovery = existsSync(join(dir, "recovery.json"))
      const session: FxSession = {
        id,
        layout: "v1",
        title: typeof meta.title === "string" && meta.title ? meta.title : undefined,
        directory: meta.workspace_root || meta.origin_workspace_root || homedir(),
        created: meta.created_at_ms ?? 0,
        updated: Math.max(meta.updated_at_ms ?? 0, events?.mtimeMs ?? 0),
        used: !!events?.size,
        turn: recovery ? "in-turn" : (tail?.turn ?? "none"),
        turnEnded: tail?.ended,
        ownerPid,
        size: events?.size ?? 0,
        recovery,
      }
      this.all.set(id, session)
      if (ownerPid && this.deps.isOurPid(ownerPid)) this.deps.onOwner(fxID(id), ownerPid)
    } catch {
      // Deleted, converted to v2, or caught mid-write (the next change event re-reads it).
      if (this.all.get(id)?.layout !== "v1" || !this.all.delete(id)) return
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
    // No OSC 7501 (another terminal, or an fx too old to send it): a turn in progress in a live process is running.
    if (!live && s.turn === "in-turn" && s.ownerPid !== undefined)
      return { status: "running", statusDetail: ours ? "Running" : "Running in another terminal" }
    const finished = s.turn === "completed" && s.turnEnded !== undefined
    if (finished && !current && s.turnEnded! > (this.deps.viewedAt(id) ?? 0))
      return { status: "unread", statusDetail: "Finished · unread" }
    if (s.ownerPid !== undefined && !ours) return { status: "idle", statusDetail: "Open in another terminal" }
    return { status: "idle" }
  }

  /** Subagents still working in a session (fx has no way to list its background shells). */
  activity(sessionID: string): SessionActivity | undefined {
    const live = this.live.get(rawID(sessionID))
    if (!live) return undefined
    const count = (agents: LiveAgent[]): number =>
      agents.reduce((n, a) => n + (a.state === "working" ? 1 : 0) + count(a.agents ?? []), 0)
    const subagents = count(live.agents)
    return subagents ? { shells: 0, subagents } : undefined
  }

  /** The subagents a live session has, as `fx sessions --live` lists them. */
  agents(sessionID: string): LiveAgent[] {
    return this.live.get(rawID(sessionID))?.agents ?? []
  }

  /** When the last turn ended, for marking it read. */
  lastActivity(id: string) {
    const s = this.get(id)
    return s?.turnEnded ?? s?.updated
  }

  /** The folder to reveal in Finder, and the folders a delete moves to the Trash (a v2 session's subagents too). */
  folders(id: string): string[] {
    const raw = rawID(id)
    const s = this.all.get(raw)
    if (s?.layout !== "v2") return [join(SESSIONS_DIR, raw)]
    const children = [...this.index.values()].filter((e) => e.role === "child" && e.parent === raw).map((e) => v2Dir(e.id))
    return [v2Dir(raw), ...children.filter((d) => existsSync(d))]
  }

  /** v1 keeps the title in session.json; v2 has no file ctrl can safely write (see writeTitle). */
  canWriteTitle(id: string) {
    return this.get(id)?.layout === "v1"
  }

  /**
   * fx keeps the title in session.json and rewrites it while it runs, so only
   * write when no fx owns the session (callers keep an override meanwhile).
   * v2 keeps it in the session's checksummed log: ctrl keeps the override instead.
   */
  async writeTitle(id: string, title: string) {
    if (!this.canWriteTitle(id)) throw new Error("fx keeps this session's title in its log, which only fx writes")
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

function run(bin: string, args: string[]) {
  return new Promise<string>((resolve, reject) =>
    execFile(bin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...FX_ENV } }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  )
}

/** Which process holds each session's lock file (lsof lists every process with it open: fx is the only one). */
async function lockOwners(ids: string[]) {
  const owners = new Map<string, number>()
  if (!ids.length) return owners
  const files = ids.map(v2Lock).filter((f) => existsSync(f))
  if (!files.length) return owners
  // lsof exits 1 when one of the files has no process: the output is still right.
  const out = await new Promise<string>((resolve) =>
    execFile("/usr/sbin/lsof", ["-F", "pn", "--", ...files], { timeout: 10_000 }, (_err, stdout) => resolve(stdout ?? "")),
  )
  let pid = 0
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid) {
      // lsof prints real paths (/private/var/… for /var/…): match the end only.
      const m = line.slice(1).match(/\/v2\/([^/]+)\/lock$/)
      if (m) owners.set(m[1], pid)
    }
  }
  return owners
}
