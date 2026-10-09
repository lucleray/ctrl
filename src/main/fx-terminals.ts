import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import type { IPty } from "node-pty"
import type { TermInfo } from "../shared/types"
import { findFx, rawID, type LiveStatus } from "./fx"

const pty: typeof import("node-pty") = createRequire(import.meta.url)("node-pty")

/**
 * Output kept per terminal so a (re)mounted xterm can catch up. fx renders
 * inline and keeps the transcript in scrollback, so this is the only copy of
 * what's on screen. Bounded: old output falls off the front.
 */
const BACKLOG_MAX = 4 * 1024 * 1024
/** fx processes kept alive at once; the least recently used idle ones are closed past this. */
export const MAX_LIVE = 12

const OSC_7501 = "\x1b]7501;"

type Term = {
  id: string
  proc: IPty
  /** How it was started, to restart it in place */
  opts: SpawnOptions
  /** fx exited with this code; the pane stays so you can read why, Enter restarts it */
  exited?: number
  /** ctrl id ("fx:…") */
  sessionID: string | null
  /** Space a brand-new session joins once fx reports its id */
  spaceID?: string | null
  status?: LiveStatus
  backlog: string[]
  backlogSize: number
  /** Characters output so far */
  total: number
  /** Start of an OSC 7501 report cut off at the end of the last chunk */
  carry: string
  lastUsed: number
}

type Events = {
  /** `end`: characters this terminal has output so far, including `data` (see backlog()) */
  onData(termID: string, data: string, end: number): void
  /** Terms or their sessions changed */
  onChange(): void
  /** A pty's fx reported a new program status (OSC 7501) */
  onStatus(sessionID: string): void
  /** fx exited; `sessionID` is what it had open */
  onExit(termID: string, sessionID: string | null, code: number): void
}

type SpawnOptions = { cwd: string; args: string[]; env: Record<string, string>; spaceID?: string | null }

/** Parses `state=working:app=fx:msg=…` (base64 msg) per the Program Status Protocol. */
function parseStatus(body: string): LiveStatus | "clear" | undefined {
  const pairs = new Map<string, string>()
  for (const pair of body.split(":")) {
    const i = pair.indexOf("=")
    if (i > 0) pairs.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
  if (pairs.has("id")) return undefined // child records: fx only reports on the root
  const state = pairs.get("state")
  if (state === "clear") return "clear"
  if (state !== "idle" && state !== "working" && state !== "done" && state !== "blocked" && state !== "error") return
  let msg: string | undefined
  try {
    const raw = pairs.get("msg")
    if (raw) msg = Buffer.from(raw, "base64").toString("utf8")
  } catch {}
  return { state, msg }
}

/**
 * One fx process per open session, each in its own pty. fx has no server or
 * plugin API to switch sessions in place, so switching shows another pty
 * instead, and the processes stay alive so their scrollback and running turns
 * survive switching back and forth. Session ids are ctrl's ("fx:…").
 */
export class FxTerminals {
  private terms = new Map<string, Term>()
  /** Last known terminal area size; new processes start at it so fx doesn't reflow right away */
  size = { cols: 120, rows: 40 }
  private seq = 0
  /** The fx terminal on screen; null when none is (nothing open, or an opencode session) */
  activeID: string | null = null

  constructor(private events: Events) {}

  list(): TermInfo[] {
    return [...this.terms.values()].map((t) => ({ id: t.id, harness: "fx" as const, sessionID: t.sessionID, exited: t.exited }))
  }

  bySession(sessionID: string) {
    return [...this.terms.values()].find((t) => t.sessionID === sessionID)
  }

  active() {
    return this.activeID ? this.terms.get(this.activeID) : undefined
  }

  isOurPid(pid: number) {
    return [...this.terms.values()].some((t) => t.exited === undefined && t.proc.pid === pid)
  }

  status(sessionID: string) {
    return this.bySession(sessionID)?.status
  }

  /** fx owns `sessionID` from process `pid`: a new session got its id, or /new, /resume switched it. */
  claim(sessionID: string, pid: number) {
    const term = [...this.terms.values()].find((t) => t.exited === undefined && t.proc.pid === pid)
    if (!term || term.sessionID === sessionID) return undefined
    const previous = term.sessionID
    term.sessionID = sessionID
    // The status belonged to the previous session.
    term.status = undefined
    this.events.onChange()
    return { termID: term.id, previous, spaceID: term.spaceID }
  }

  /**
   * Shows the pty for this session, starting `fx resume <id>` when none has it open.
   * `background`: start it without showing it (restoring sessions at launch).
   */
  open(sessionID: string, opts: Omit<SpawnOptions, "args">, background = false) {
    const existing = this.bySession(sessionID)
    if (existing?.exited !== undefined) this.restart(existing.id)
    if (existing) return background ? existing.id : this.activate(existing.id)
    return this.spawn({ ...opts, args: ["resume", "--id", rawID(sessionID)] }, sessionID, background)
  }

  /** Sessions with a pane, most recently used first. */
  openSessions() {
    return [...this.terms.values()]
      .filter((t) => t.sessionID)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map((t) => t.sessionID!)
  }

  /** Starts a fresh fx; its session id arrives later through claim(). */
  create(opts: SpawnOptions) {
    return this.spawn(opts, null)
  }

  private spawn(opts: SpawnOptions, sessionID: string | null, background = false) {
    const id = `fx_${++this.seq}`
    const term: Term = {
      id,
      proc: undefined as unknown as IPty,
      opts,
      sessionID,
      spaceID: opts.spaceID,
      backlog: [],
      backlogSize: 0,
      total: 0,
      carry: "",
      // Restored in the background: older than anything you've touched, in restore order.
      lastUsed: background ? Date.now() - 3_600_000 : Date.now(),
    }
    this.terms.set(id, term)
    this.start(term)
    if (!background) this.activeID = id
    this.trim()
    this.events.onChange()
    return id
  }

  /** Starts (or restarts) fx for a terminal. */
  private start(term: Term) {
    const bin = findFx()
    const env = {
      ...process.env,
      ...term.opts.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "ctrl",
      // fx checks for upgrades itself; never let one restart it under us.
      FX_AUTO_UPGRADE: "0",
    } as Record<string, string>
    // A known session resumes; a new one that never got an id starts fresh again.
    const args = term.sessionID ? ["resume", "--id", rawID(term.sessionID)] : term.opts.args
    // Fall back to a login shell so PATH is resolved when fx lives somewhere unusual.
    const quote = (a: string) => `'${a.replaceAll("'", "'\\''")}'`
    const [file, argv] = bin
      ? [bin, args]
      : [process.env.SHELL || "/bin/zsh", ["-lc", ["exec fx", ...args.map(quote)].join(" ")]]
    const cwd = existsSync(term.opts.cwd) ? term.opts.cwd : homedir()
    const proc = pty.spawn(file, argv, { name: "xterm-256color", cols: this.size.cols, rows: this.size.rows, cwd, env })
    term.proc = proc
    term.exited = undefined
    term.status = undefined
    proc.onData((data) => this.data(term, data))
    proc.onExit(({ exitCode }) => {
      if (this.terms.get(term.id) !== term || term.proc !== proc) return
      term.exited = exitCode
      term.status = undefined
      // fx resets the screen on exit, so its last words stay readable below.
      this.data(term, `\r\n\x1b[2m[fx exited${exitCode ? ` with code ${exitCode}` : ""} · press Enter to restart]\x1b[0m\r\n`)
      this.events.onExit(term.id, term.sessionID, exitCode)
      this.events.onChange()
    })
  }

  restart(id: string) {
    const term = this.terms.get(id)
    if (!term || term.exited === undefined) return
    this.data(term, "\x1bc")
    this.start(term)
    this.events.onChange()
  }

  private data(term: Term, data: string) {
    term.backlog.push(data)
    term.backlogSize += data.length
    term.total += data.length
    while (term.backlogSize > BACKLOG_MAX && term.backlog.length > 1) term.backlogSize -= term.backlog.shift()!.length
    this.scanStatus(term, data)
    this.events.onData(term.id, data, term.total)
  }

  private scanStatus(term: Term, data: string) {
    const text = term.carry + data
    term.carry = ""
    if (!text.includes("\x1b]7501")) return
    let changed = false
    let from = 0
    while (true) {
      const start = text.indexOf(OSC_7501, from)
      if (start === -1) break
      const body = start + OSC_7501.length
      const st = text.slice(body).search(/\x07|\x1b\\/)
      if (st === -1) {
        // Cut off mid-report; reports are at most 4 KB.
        if (text.length - start < 4096) term.carry = text.slice(start)
        break
      }
      const parsed = parseStatus(text.slice(body, body + st))
      if (parsed === "clear") term.status = undefined
      else if (parsed) term.status = parsed
      changed ||= parsed !== undefined
      from = body + st
    }
    if (changed && term.sessionID) this.events.onStatus(term.sessionID)
  }

  activate(id: string) {
    const term = this.terms.get(id)
    if (!term) return null
    term.lastUsed = Date.now()
    this.activeID = id
    this.events.onChange()
    return id
  }

  /** Nothing on screen (e.g. the current session was archived). */
  deactivate() {
    this.activeID = null
    this.events.onChange()
  }

  /** Closes the least recently used idle processes past MAX_LIVE. Never one that's working or waiting. */
  private trim() {
    const idle = [...this.terms.values()]
      .filter((t) => t.id !== this.activeID && t.status?.state !== "working" && t.status?.state !== "blocked")
      // Exited panes go first, then the least recently used.
      .sort((a, b) => Number(b.exited !== undefined) - Number(a.exited !== undefined) || a.lastUsed - b.lastUsed)
    for (let n = this.terms.size - MAX_LIVE; n > 0 && idle.length; n--) this.close(idle.shift()!.id)
  }

  /** Stops fx and drops its pane. */
  close(id: string) {
    const term = this.terms.get(id)
    if (!term) return
    this.terms.delete(id)
    if (this.activeID === id) this.activeID = null
    if (term.exited === undefined) {
      term.proc.kill()
      this.events.onExit(id, term.sessionID, 0)
    }
    this.events.onChange()
  }

  closeSession(sessionID: string) {
    const term = this.bySession(sessionID)
    if (term) this.close(term.id)
  }

  /** Output so far (bounded) and where it ends, so live chunks already in it can be skipped. */
  backlog(id: string) {
    const term = this.terms.get(id)
    return { data: term?.backlog.join("") ?? "", end: term?.total ?? 0 }
  }

  write(id: string, data: string) {
    const term = this.terms.get(id)
    if (!term) return
    term.lastUsed = Date.now()
    if (term.exited === undefined) term.proc.write(data)
    else if (data === "\r") this.restart(id)
  }

  /** Tells every fx the terminal's color scheme changed (DSR 997, fx enables mode 2031 for it). */
  colorScheme(dark: boolean) {
    for (const t of this.terms.values()) if (t.exited === undefined) t.proc.write(`\x1b[?997;${dark ? 1 : 2}n`)
  }

  resize(cols: number, rows: number) {
    if (cols === this.size.cols && rows === this.size.rows) return
    this.size = { cols, rows }
    for (const t of this.terms.values()) {
      if (t.exited !== undefined) continue
      try {
        t.proc.resize(cols, rows)
      } catch {}
    }
  }

  dispose() {
    for (const t of this.terms.values()) if (t.exited === undefined) t.proc.kill()
    this.terms.clear()
  }
}
