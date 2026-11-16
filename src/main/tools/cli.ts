import { spawn } from "node:child_process"
import { CLI_TOOL_EVERY, type CliToolConfig, type ToolItem, type ToolState } from "../../shared/types"
import { fixLabel } from "../../shared/tools"

const CHECK_TIMEOUT_MS = 20_000
/** Logins wait on you in the browser. */
const FIX_TIMEOUT_MS = 5 * 60_000
const TICK_MS = 30_000
/** On window focus: broken checks rerun right away (you may have just fixed them), healthy ones once this old. */
const FOCUS_STALE_MS = 2 * 60_000
const FOCUS_BROKEN_MS = 10_000

type Entry = {
  config: CliToolConfig
  state: ToolState
  detail?: string
  checked?: number
  checking?: Promise<void>
  fixing?: boolean
}

export type ShellResult = { code: number | null; output: string; timedOut: boolean }

/** Quotes a value for /bin/sh. */
export const shq = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

/**
 * Runs a shell command with no terminal: stdin is closed, so a CLI that asks a question fails instead of
 * hanging. The whole process group is killed on timeout.
 */
export const runShell = (command: string, timeout: number, cwd?: string) =>
  new Promise<ShellResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, NO_COLOR: "1", AWS_PAGER: "", GH_PROMPT_DISABLED: "1" },
    })
    let output = ""
    let timedOut = false
    const keep = (chunk: Buffer) => {
      // Only the end matters (the last line explains a failure).
      output = (output + chunk.toString()).slice(-8192)
    }
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {}
    }, timeout)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: null, output: err.message, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })

/** The last line that says something, cut to fit a toast. */
export const lastLine = (output: string, max = 240) => {
  const line =
    output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const resultState = (r: ShellResult, command: string): Pick<Entry, "state" | "detail"> => {
  if (r.timedOut) return { state: "broken", detail: `Timed out after ${CHECK_TIMEOUT_MS / 1000}s` }
  if (r.code === 0) return { state: "ok" }
  if (r.code === 127) return { state: "missing", detail: `${command.split(/\s+/)[0]} isn't installed` }
  return { state: "broken", detail: lastLine(r.output) || `Exited with ${r.code}` }
}

/**
 * CLI checks from Settings → Tools: each runs at launch, every `every` minutes, when Settings opens
 * and when the window gets focus (broken ones right away). Checks are child processes, so main only
 * waits on them; a check already running is shared, never doubled.
 */
export class CliTools {
  private entries = new Map<string, Entry>()
  private timer?: ReturnType<typeof setInterval>

  constructor(private onChange: () => void) {}

  start() {
    this.timer ??= setInterval(() => void this.checkDue(), TICK_MS)
    void this.checkDue()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** New or edited checks run right away; removed ones go. */
  configure(configs: CliToolConfig[]) {
    const ids = new Set(configs.map((c) => c.id))
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id)
    for (const config of configs) {
      const entry = this.entries.get(config.id)
      if (entry && entry.config.check === config.check) entry.config = config
      else this.entries.set(config.id, { config, state: "checking" })
    }
    this.onChange()
    if (this.timer) void this.checkDue()
  }

  config(id: string) {
    return this.entries.get(id)?.config
  }

  items(): ToolItem[] {
    return [...this.entries.values()].map(({ config, state, detail, checked, fixing }) => ({
      id: `cli:${config.id}`,
      kind: "cli",
      name: config.name,
      state,
      ...(detail ? { detail } : {}),
      check: config.check,
      ...(checked ? { checked } : {}),
      fix: config.fix.kind,
      label: fixLabel(config.fix, config.label),
      ...(fixing ? { fixing } : {}),
    }))
  }

  /** Checks these (default: all) now, or only those last checked more than `olderThan` ms ago. */
  check(ids?: string[], olderThan = 0) {
    const now = Date.now()
    return Promise.all(
      [...this.entries.values()]
        .filter((e) => !ids || ids.includes(e.config.id))
        .filter((e) => !e.checked || now - e.checked >= olderThan)
        .map((e) => this.checkOne(e)),
    )
  }

  focused() {
    const now = Date.now()
    for (const e of this.entries.values()) {
      const broken = e.state === "broken" || e.state === "missing"
      if (!e.checked || now - e.checked >= (broken ? FOCUS_BROKEN_MS : FOCUS_STALE_MS)) void this.checkOne(e)
    }
  }

  /** Runs the fix command, then checks again. Resolves to whether the check passes now, with the reason if not. */
  async runFix(id: string): Promise<{ ok: boolean; detail?: string }> {
    const e = this.entries.get(id)
    if (!e || e.config.fix.kind !== "command" || e.fixing) return { ok: false }
    e.fixing = true
    this.onChange()
    const r = await runShell(e.config.fix.command, FIX_TIMEOUT_MS)
    e.fixing = false
    if (this.entries.get(id) !== e) return { ok: false }
    if (r.code !== 0) {
      this.onChange()
      return {
        ok: false,
        detail: r.timedOut ? `Gave up after ${FIX_TIMEOUT_MS / 60_000} minutes` : lastLine(r.output) || `Exited with ${r.code}`,
      }
    }
    await this.checkOne(e)
    return { ok: e.state === "ok", detail: e.detail }
  }

  private checkDue() {
    const now = Date.now()
    return Promise.all(
      [...this.entries.values()]
        .filter((e) => !e.checked || now - e.checked >= (e.config.every ?? CLI_TOOL_EVERY) * 60_000)
        .map((e) => this.checkOne(e)),
    )
  }

  private checkOne(e: Entry) {
    e.checking ??= (async () => {
      const command = e.config.check
      const r = await runShell(command, CHECK_TIMEOUT_MS)
      e.checking = undefined
      // Edited or removed while it ran: the new check owns the entry.
      if (this.entries.get(e.config.id) !== e || e.config.check !== command) return
      Object.assign(e, { detail: undefined }, resultState(r, command), { checked: Date.now() })
      this.onChange()
    })()
    return e.checking
  }
}
