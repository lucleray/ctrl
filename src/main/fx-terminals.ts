import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import type { IPty } from "node-pty"
import type { TermInfo } from "../shared/types"
import { childEnv } from "./child-env"
import { findFx, FX_ENV, rawID, type LiveStatus } from "./fx"

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

/** A chat session's `fx acp` process (src/main/fx-chat.ts), standing in for a pty: no screen, only a process. */
export type ChatProc = { pid: number; kill(): void }

type Term = {
  id: string
  proc: IPty | ChatProc
  /** terminal: fx in a pty · chat: fx acp, drawn by the chat view (the pane itself shows nothing) */
  view: "terminal" | "chat"
  /** How it was started, to restart it in place */
  opts: SpawnOptions
  /** fx exited with this code; the pane stays so you can read why, Enter restarts it */
  exited?: number
  /** ctrl id ("fx:…") */
  sessionID: string | null
  /**
   * sessionID is a placeholder (src/main/unstarted.ts): a new session fx hasn't given an id yet. Its space,
   * parent and draft are kept under the placeholder until fx reports the real id (claim).
   */
  placeholder?: boolean
  status?: LiveStatus
  backlog: string[]
  backlogSize: number
  /** Characters output so far */
  total: number
  /** Start of an OSC 7501 report cut off at the end of the last chunk */
  carry: string
  lastUsed: number
  /** When it last printed anything, to tell when a fresh fx is ready for input */
  lastOutput: number
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

/** `fx --resume <id>` (fx 0.0.17 removed `fx resume --id`; `--resume` works in older ones too). */
const resumeArgs = (sessionID: string) => ["--resume", rawID(sessionID)]

type SpawnOptions = { cwd: string; args: string[]; env: Record<string, string> }

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
 *
 * Chat sessions (src/main/fx-chat.ts) have a pane here too, with their `fx acp` process in place of a pty
 * (`openChat`), so what's built on panes (the current session, restoring at launch, ⌃1–9, status and pids
 * for the sidebar, the cap on live processes) treats them like terminal ones.
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
    return [...this.terms.values()].map((t) => ({
      id: t.id,
      harness: "fx" as const,
      sessionID: t.sessionID,
      exited: t.exited,
      ...(t.view === "chat" ? { view: "chat" as const } : {}),
    }))
  }

  /**
   * A chat session's pane, for the `fx acp` process FxChat started for it: made, or the one it has, and shown
   * unless `background`. A pane whose process exited gets the new one.
   */
  openChat(sessionID: string, proc: ChatProc, cwd: string, background: boolean) {
    const existing = this.bySession(sessionID)
    if (existing) {
      existing.proc = proc
      existing.exited = undefined
      existing.status = undefined
      existing.view = "chat"
      this.events.onChange()
      return background ? existing.id : this.activate(existing.id)
    }
    const id = `fx_${++this.seq}`
    this.terms.set(id, {
      id,
      proc,
      view: "chat",
      opts: { cwd, args: [], env: {} },
      sessionID,
      backlog: [],
      backlogSize: 0,
      total: 0,
      carry: "",
      lastOutput: 0,
      lastUsed: background ? Date.now() - 3_600_000 : Date.now(),
    })
    if (!background) this.activeID = id
    this.trim()
    this.events.onChange()
    return id
  }

  /** A chat session's status, from its process (FxChat), like OSC 7501 for a pty. */
  setStatus(sessionID: string, status: LiveStatus | undefined) {
    const term = this.bySession(sessionID)
    if (!term || term.view !== "chat") return
    term.status = status
    this.events.onStatus(sessionID)
  }

  /** A chat session's process is gone: its pane stays, and opening the session starts another. */
  chatExited(sessionID: string, code: number | null) {
    const term = this.bySession(sessionID)
    if (!term || term.view !== "chat" || term.exited !== undefined) return
    term.exited = code ?? 0
    term.status = undefined
    this.events.onExit(term.id, sessionID, term.exited)
    this.events.onChange()
  }

  bySession(sessionID: string) {
    return [...this.terms.values()].find((t) => t.sessionID === sessionID)
  }

  active() {
    return this.activeID ? this.terms.get(this.activeID) : undefined
  }

  /** pids of the fx processes running now */
  pids() {
    return [...this.terms.values()].filter((t) => t.exited === undefined).map((t) => t.proc.pid)
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
    const placeholder = !!term.placeholder
    term.sessionID = sessionID
    term.placeholder = false
    // The status belonged to the previous session.
    term.status = undefined
    this.events.onChange()
    return { termID: term.id, previous, placeholder }
  }

  /**
   * Shows the pty for this session, starting `fx --resume <id>` when none has it open.
   * `background`: start it without showing it (restoring sessions at launch). `prompt`: arguments sent as its
   * first prompt when it starts (not when it's already running).
   */
  open(sessionID: string, opts: Omit<SpawnOptions, "args">, background = false, prompt: string[] = []) {
    const existing = this.bySession(sessionID)
    if (existing?.view === "chat") throw new Error("This session runs as a chat")
    if (existing?.exited !== undefined) this.restart(existing.id)
    if (existing) return background ? existing.id : this.activate(existing.id)
    return this.spawn({ ...opts, args: [...resumeArgs(sessionID), ...prompt] }, sessionID, background)
  }

  /** Sessions with a pane, most recently used first. */
  openSessions() {
    return [...this.terms.values()]
      .filter((t) => t.sessionID)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map((t) => t.sessionID!)
  }

  /**
   * Starts a fresh fx; its session id arrives later through claim(). `show`: put it on screen. `placeholder`:
   * the id the session goes by until then (src/main/unstarted.ts).
   */
  create(opts: SpawnOptions, show = true, placeholder?: string) {
    const previous = this.activeID
    const id = this.spawn(opts, placeholder ?? null)
    if (placeholder) this.terms.get(id)!.placeholder = true
    if (!show) {
      this.activeID = previous
      this.events.onChange()
    }
    return id
  }

  /** The session fx reported for a terminal (null: none yet; undefined: no such terminal). */
  sessionOf(termID: string) {
    const term = this.terms.get(termID)
    return term ? (term.placeholder ? null : term.sessionID) : undefined
  }

  /**
   * Resolves once fx has started and gone quiet, so typed input isn't lost while it boots.
   * Gives up (and resolves anyway) after `max` ms.
   */
  async ready(termID: string, max = 8000) {
    const started = Date.now()
    while (Date.now() - started < max) {
      const term = this.terms.get(termID)
      if (!term || term.exited !== undefined) throw new Error("fx isn't running")
      if (term.total > 0 && Date.now() - term.lastOutput > 500) return
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  private spawn(opts: SpawnOptions, sessionID: string | null, background = false) {
    const id = `fx_${++this.seq}`
    const term: Term = {
      id,
      proc: undefined as unknown as IPty,
      view: "terminal",
      opts,
      sessionID,
      backlog: [],
      backlogSize: 0,
      total: 0,
      carry: "",
      lastOutput: 0,
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
      ...childEnv({ CTRL_TERM_ID: term.id }),
      ...FX_ENV,
      ...term.opts.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "ctrl",
      // fx checks for upgrades itself; never let one restart it under us.
      FX_AUTO_UPGRADE: "0",
      // ctrl plays its own sounds (or none when they're off), so fx's would double up.
      FX_SOUND: "off",
    } as Record<string, string>
    // First start: as asked (a prompt included). A restart resumes a known session without resending its prompt;
    // a new one that never got an id starts fresh again.
    const args = !term.proc ? term.opts.args : term.sessionID && !term.placeholder ? resumeArgs(term.sessionID) : term.opts.args
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
    if (!term || term.exited === undefined || term.view === "chat") return
    this.data(term, "\x1bc")
    this.start(term)
    this.events.onChange()
  }

  private data(term: Term, data: string) {
    term.backlog.push(data)
    term.backlogSize += data.length
    term.total += data.length
    term.lastOutput = Date.now()
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
    if (!term || term.view === "chat") return
    term.lastUsed = Date.now()
    if (term.exited === undefined) (term.proc as IPty).write(data)
    else if (data === "\r") this.restart(id)
  }

  /** Tells every fx the terminal's color scheme changed (DSR 997, fx enables mode 2031 for it). */
  colorScheme(dark: boolean) {
    for (const t of this.terms.values()) if (t.exited === undefined && t.view !== "chat") (t.proc as IPty).write(`\x1b[?997;${dark ? 1 : 2}n`)
  }

  resize(cols: number, rows: number) {
    if (cols === this.size.cols && rows === this.size.rows) return
    this.size = { cols, rows }
    for (const t of this.terms.values()) {
      if (t.exited !== undefined || t.view === "chat") continue
      try {
        ;(t.proc as IPty).resize(cols, rows)
      } catch {}
    }
  }

  dispose() {
    for (const t of this.terms.values()) if (t.exited === undefined) t.proc.kill()
    this.terms.clear()
  }
}
