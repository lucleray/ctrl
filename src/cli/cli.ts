/**
 * The `ctrl` CLI (docs/CLI.md). Parses argv against the command registry, sends one request to
 * the running app over its unix socket and prints the JSON reply. Runs with node, or with ctrl's
 * Electron as node (bin/ctrl).
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { ALIASES, COMMANDS, GLOBAL_FLAGS, commandByName, type ArgSpec, type CommandSpec } from "../shared/cli/commands"
import { commandHelp, helpJson, nounHelp, overviewHelp, referenceMarkdown, usage } from "../shared/cli/docs"
import {
  CliError,
  EXIT_CODES,
  PROTOCOL_VERSION,
  SOCKET_NAME,
  type CallerContext,
  type CliReply,
  type CliRequest,
} from "../shared/cli/protocol"

declare const __CTRL_VERSION__: string
const VERSION = typeof __CTRL_VERSION__ === "string" ? __CTRL_VERSION__ : "dev"

const APP_SUPPORT = join(homedir(), "Library", "Application Support")
const socketPath = () => process.env.CTRL_SOCKET || join(APP_SUPPORT, "ctrl", SOCKET_NAME)

type Globals = { pretty: boolean; fields?: string[]; timeout: number }

// ---------- output ----------

let globals: Globals = { pretty: false, timeout: 15000 }

const pick = (value: unknown, fields: string[]): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const obj = value as Record<string, unknown>
  return Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]))
}

const applyFields = (data: unknown) => {
  const fields = globals.fields
  if (!fields?.length || !data || typeof data !== "object") return data
  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.items)) {
    return { ...obj, items: obj.items.map((i) => pick(i, fields)) }
  }
  return pick(data, fields)
}

const print = (reply: CliReply) => {
  const out = reply.ok ? { ok: true, data: applyFields(reply.data) } : reply
  process.stdout.write(JSON.stringify(out, null, globals.pretty ? 2 : undefined) + "\n")
}

const fail = (err: CliError): never => {
  print({ ok: false, error: err.body() })
  process.exit(EXIT_CODES[err.code])
}

// ---------- parsing ----------

const allNames = [...COMMANDS.map((c) => c.name), ...ALIASES.map((a) => a.name)]
const nouns = new Set(COMMANDS.map((c) => c.name.split(" ")[0]))

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/** Longest command name the leading words spell, e.g. ["app","update","check"]. */
function findCommand(words: string[]): { spec: CommandSpec; used: number } | undefined {
  for (let n = Math.min(3, words.length); n > 0; n--) {
    const name = words.slice(0, n).join(" ")
    const alias = ALIASES.find((a) => a.name === name)
    const spec = commandByName(alias ? alias.target : name)
    if (spec) return { spec, used: n }
  }
}

let stdinUsed = false
const readStdin = () => {
  if (stdinUsed) throw new CliError("USAGE", "Only one value can be read from stdin (`-`)")
  stdinUsed = true
  return readFileSync(0, "utf8").replace(/\n$/, "")
}

function convert(spec: ArgSpec, raw: string, c: CommandSpec): unknown {
  const value = raw === "-" && spec.type === "string" ? readStdin() : raw
  const bad = (why: string) =>
    new CliError("USAGE", `--${spec.name}: ${why}`, { hint: usage(c) })
  switch (spec.type) {
    case "int": {
      if (!/^-?\d+$/.test(value)) throw bad(`expected an integer, got ${JSON.stringify(value)}`)
      return Number(value)
    }
    case "bool":
      if (value === "true" || value === "1") return true
      if (value === "false" || value === "0") return false
      throw bad(`expected true or false, got ${JSON.stringify(value)}`)
    case "enum":
      if (!spec.values?.includes(value)) throw bad(`expected one of ${spec.values?.join(", ")}, got ${JSON.stringify(value)}`)
      return value
    case "json":
      try {
        return JSON.parse(value)
      } catch {
        throw bad("expected JSON")
      }
    default:
      return value
  }
}

function parse(argv: string[]): { spec: CommandSpec; args: Record<string, unknown>; help: boolean } {
  const words: string[] = []
  let i = 0
  while (i < argv.length && !argv[i].startsWith("-")) words.push(argv[i++])
  const found = findCommand(words)
  const wantsHelp = argv.includes("--help") || argv.includes("-h")
  if (!found) {
    if (words.length === 0) return { spec: commandByName("help")!, args: { command: [] }, help: false }
    if (nouns.has(words[0]) && (wantsHelp || words.length === 1)) {
      return { spec: commandByName("help")!, args: { command: [words[0]] }, help: false }
    }
    if (words[0] === "session" && ["delete", "rm", "remove"].includes(words[1] ?? "")) {
      throw new CliError("USAGE", "The ctrl CLI can't delete sessions, by design: agents archive, people delete", {
        hint: "Archive it instead (reversible): ctrl session archive <session>. The user can delete it from the sidebar",
      })
    }
    const near = [...new Set([...allNames, ...nouns])]
      .map((n) => ({ n, d: distance(n, words.slice(0, n.split(" ").length).join(" ")) }))
      .filter(({ n, d }) => d <= Math.max(2, Math.floor(n.length / 4)))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map(({ n }) => n)
    throw new CliError("USAGE", `Unknown command: ${words.join(" ")}`, {
      hint: near.length ? `Did you mean: ${near.map((n) => `ctrl ${n}`).join(", ")}?` : "Run: ctrl help",
      ...(near.length ? { candidates: near } : {}),
    })
  }
  const { spec } = found
  const rest = [...words.slice(found.used), ...argv.slice(i)]
  const args: Record<string, unknown> = {}
  const positionals: string[] = []
  const flags = new Map(spec.args.filter((a) => !a.positional).map((a) => [a.name, a]))
  const globalFlags = new Map(GLOBAL_FLAGS.map((a) => [a.name, a]))

  for (let j = 0; j < rest.length; j++) {
    const token = rest[j]
    if (token === "--help" || token === "-h") continue
    if (token === "--") {
      positionals.push(...rest.slice(j + 1))
      break
    }
    if (!token.startsWith("--") || token === "-") {
      positionals.push(token)
      continue
    }
    let [name, inline] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    let negated = false
    if (!flags.has(name) && !globalFlags.has(name) && name.startsWith("no-")) {
      const base = name.slice(3)
      if (flags.get(base)?.type === "bool" || globalFlags.get(base)?.type === "bool") {
        name = base
        negated = true
      }
    }
    // A command's own flag wins over a global one with the same name (session wait --timeout).
    const own = flags.get(name)
    const flag = own ?? globalFlags.get(name)
    if (!flag) {
      throw new CliError("USAGE", `Unknown flag --${name} for \`ctrl ${spec.name}\``, { hint: usage(spec) })
    }
    let value: unknown
    if (flag.type === "bool") value = negated ? false : inline === undefined ? true : convert(flag, inline, spec)
    else {
      const raw = inline ?? rest[++j]
      if (raw === undefined) throw new CliError("USAGE", `--${name} needs a value`, { hint: usage(spec) })
      value = convert(flag, raw, spec)
    }
    if (!own) {
      if (name === "pretty") globals.pretty = value as boolean
      if (name === "timeout") globals.timeout = value as number
      if (name === "fields") globals.fields = String(value).split(",").map((f) => f.trim()).filter(Boolean)
      continue
    }
    if (flag.list) ((args[name] ??= []) as unknown[]).push(value)
    else args[name] = value
  }

  const pos = spec.args.filter((a) => a.positional)
  for (const a of pos) {
    if (a.list) {
      if (positionals.length) args[a.name] = positionals.splice(0).map((p) => convert(a, p, spec))
      continue
    }
    const raw = positionals.shift()
    if (raw !== undefined) args[a.name] = convert(a, raw, spec)
  }
  if (positionals.length) {
    throw new CliError("USAGE", `Unexpected argument${positionals.length > 1 ? "s" : ""}: ${positionals.join(" ")}`, {
      hint: usage(spec),
    })
  }
  if (!wantsHelp) {
    for (const a of spec.args) {
      if (args[a.name] === undefined && a.default !== undefined) args[a.name] = a.default
      const missing = args[a.name] === undefined || (a.list && (args[a.name] as unknown[]).length === 0)
      if (a.required && missing) {
        const what = a.positional ? (a.placeholder ?? `<${a.name}>`) : `--${a.name}`
        throw new CliError("USAGE", `Missing ${what} for \`ctrl ${spec.name}\``, { hint: usage(spec) })
      }
    }
  }
  return { spec, args, help: wantsHelp }
}

// ---------- talking to the app ----------

/** Which agent runs this, from what agent harnesses set in their tool shells (docs/CLI.md → Environment). */
const detectAgent = (env = process.env): string | undefined => {
  if (env.AI_AGENT) return env.AI_AGENT
  if (env.CLAUDECODE) return "claude-code"
  if (env.CURSOR_AGENT) return "cursor"
  if (env.CTRL_TERM_ID) return "fx"
  if (env.AGENT && env.AGENT !== "0" && env.AGENT !== "false") return "agent"
  return undefined
}

const caller = (): CallerContext => ({
  agent: detectAgent(),
  termID: process.env.CTRL_TERM_ID || undefined,
  opencodeSessionID: process.env.OPENCODE_SESSION_ID || undefined,
  sessionID: process.env.CTRL_SESSION_ID || undefined,
  cwd: process.cwd(),
})

function notRunning(cause: string) {
  const dev = join(APP_SUPPORT, "ctrl-dev", SOCKET_NAME)
  const hint =
    !process.env.CTRL_SOCKET && existsSync(dev)
      ? `Start it with: ctrl app launch (a dev ctrl is listening on ${dev}: set CTRL_SOCKET to use it)`
      : "Start it with: ctrl app launch"
  return new CliError("APP_NOT_RUNNING", `ctrl isn't running (${cause})`, { hint })
}

/**
 * Sends one request. Streaming commands call onLine per NDJSON line; others resolve with the reply.
 * `timeout` = 0 waits forever.
 */
function request(req: CliRequest, timeout: number, onLine?: (line: string) => void): Promise<CliReply> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath())
    let buf = ""
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer =
      timeout > 0
        ? setTimeout(
            () =>
              done(() => {
                sock.destroy()
                reject(new CliError("TIMEOUT", `ctrl didn't answer within ${timeout}ms`, { hint: "Pass a larger --timeout" }))
              }),
            timeout,
          )
        : undefined
    sock.setEncoding("utf8")
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"))
    sock.on("data", (chunk: string) => {
      buf += chunk
      if (!onLine) return
      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line) continue
        // The first line of a stream is an envelope only when it's an error.
        try {
          const parsed = JSON.parse(line) as CliReply
          if (parsed && "ok" in parsed && parsed.ok === false) return done(() => resolve(parsed))
        } catch {}
        onLine(line)
      }
    })
    sock.on("error", (err: NodeJS.ErrnoException) =>
      done(() => {
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") reject(notRunning(err.code))
        else reject(new CliError("INTERNAL", `Socket error: ${err.message}`))
      }),
    )
    sock.on("end", () =>
      done(() => {
        if (onLine) return resolve({ ok: true, data: null })
        try {
          resolve(JSON.parse(buf) as CliReply)
        } catch {
          reject(new CliError("INTERNAL", "ctrl sent a reply that isn't JSON"))
        }
      }),
    )
  })
}

const call = (command: string, args: Record<string, unknown> = {}, timeout = globals.timeout) =>
  request({ v: PROTOCOL_VERSION, command, args, caller: caller() }, timeout)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const isRunning = () =>
  call("app status", {}, 3000).then(
    (r) => r.ok,
    () => false,
  )

async function launch(wait: boolean) {
  if (await isRunning()) return { launched: false, running: true }
  await new Promise<void>((resolve, reject) =>
    execFile("open", ["-g", "-b", "im.luc.ctrl"], (err) => {
      if (!err) return resolve()
      execFile("open", ["-g", "-a", "ctrl"], (err2) =>
        err2 ? reject(new CliError("NOT_FOUND", "ctrl.app isn't installed", { hint: "Install it: curl -fsSL https://raw.githubusercontent.com/lucleray/ctrl/main/install.sh | sh" })) : resolve(),
      )
    }),
  )
  if (!wait) return { launched: true, running: false }
  for (let i = 0; i < 100; i++) {
    await sleep(300)
    if (await isRunning()) return { launched: true, running: true }
  }
  throw new CliError("TIMEOUT", "ctrl was launched but didn't answer within 30s")
}

// ---------- main ----------

async function main() {
  const { spec, args, help } = parse(process.argv.slice(2))
  if (help) {
    process.stdout.write(commandHelp(spec) + "\n")
    return
  }
  if (spec.name === "help") {
    const words = (args.command as string[] | undefined) ?? []
    if (args.json) {
      const tree = helpJson(VERSION)
      if (words.length) {
        const prefix = words.join(" ")
        tree.commands = tree.commands.filter((c) => c.name === prefix || c.name.startsWith(prefix + " "))
      }
      return print({ ok: true, data: tree })
    }
    if (!words.length) return void process.stdout.write(overviewHelp(VERSION) + "\n")
    const found = findCommand(words)
    if (found && found.used === words.length) return void process.stdout.write(commandHelp(found.spec) + "\n")
    if (nouns.has(words[0]) && words.length === 1) return void process.stdout.write(nounHelp(words[0]) + "\n")
    throw new CliError("USAGE", `No command named ${words.join(" ")}`, { hint: "Run: ctrl help" })
  }
  if (spec.name === "docs") return void process.stdout.write(referenceMarkdown())
  if (spec.name === "app launch") return print({ ok: true, data: await launch(args.wait !== false) })

  const req: CliRequest = { v: PROTOCOL_VERSION, command: spec.name, args, caller: caller() }
  if (spec.stream) {
    const reply = await request(req, 0, (line) => process.stdout.write(line + "\n"))
    if (!reply.ok) fail(new CliError(reply.error.code, reply.error.message, reply.error))
    return
  }
  // Commands that wait on their own get their timeout plus a margin for the reply.
  const ownTimeout = typeof args.timeout === "number" ? args.timeout + 5000 : undefined
  const timeout = ownTimeout ?? globals.timeout
  const reply = await request(req, timeout).catch((err) => {
    if (err instanceof CliError && err.code === "TIMEOUT" && spec.mutates) {
      err.extra.hint = "The app may still have done it: check (e.g. ctrl session list) before retrying, or pass a larger --timeout"
    }
    throw err
  })
  if (!reply.ok) fail(new CliError(reply.error.code, reply.error.message, reply.error))
  print(reply)
}

main().catch((err) => {
  if (err instanceof CliError) fail(err)
  fail(new CliError("INTERNAL", err instanceof Error ? err.message : String(err)))
})
