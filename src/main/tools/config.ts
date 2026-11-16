import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"
import type { CliToolConfig, McpServerConfig, ToolFix, ToolsConfig } from "../../shared/types"

const isStringMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && Object.values(v).every((x) => typeof x === "string")

const mcpEntry = (v: Record<string, unknown>): McpServerConfig | null => {
  if (typeof v.name !== "string" || !v.name) return null
  if (v.type === "remote" && typeof v.url === "string")
    return { name: v.name, type: "remote", url: v.url, ...(isStringMap(v.headers) ? { headers: v.headers } : {}) }
  if (v.type === "local" && Array.isArray(v.command) && v.command.length && v.command.every((c) => typeof c === "string"))
    return { name: v.name, type: "local", command: v.command, ...(isStringMap(v.env) ? { env: v.env } : {}) }
  return null
}

const fixEntry = (v: unknown): ToolFix | null => {
  const f = v as Record<string, unknown> | null
  if (f?.kind === "command" && typeof f.command === "string" && f.command) return { kind: "command", command: f.command }
  if (f?.kind === "url" && typeof f.url === "string" && /^https?:\/\//.test(f.url)) return { kind: "url", url: f.url }
  if (f?.kind === "session") return { kind: "session", ...(typeof f.prompt === "string" && f.prompt ? { prompt: f.prompt } : {}) }
  return null
}

const cliEntry = (v: Record<string, unknown>): CliToolConfig | null => {
  const fix = fixEntry(v.fix)
  if (typeof v.id !== "string" || !v.id || typeof v.name !== "string" || typeof v.check !== "string" || !v.check || !fix)
    return null
  return {
    id: v.id,
    ...(typeof v.key === "string" && v.key ? { key: v.key } : {}),
    name: v.name,
    check: v.check,
    fix,
    ...(typeof v.label === "string" && v.label ? { label: v.label } : {}),
    ...(typeof v.every === "number" && v.every >= 1 ? { every: Math.round(v.every) } : {}),
  }
}

/** Keeps the entries that make sense, so a hand edit with one typo doesn't drop the whole list. */
export const parseTools = (text: string): ToolsConfig => {
  const raw = JSON.parse(text) as { mcp?: unknown; cli?: unknown }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [])
  const keep = <T,>(items: (T | null)[], what: string) => {
    const dropped = items.filter((x) => !x).length
    if (dropped) console.warn(`[ctrl] tools.json: ignored ${dropped} ${what} entr${dropped === 1 ? "y" : "ies"} it can't read`)
    return items.filter((x): x is T => !!x)
  }
  return {
    version: 1,
    mcp: keep(list(raw.mcp).map(mcpEntry), "mcp"),
    cli: keep(list(raw.cli).map(cliEntry), "cli"),
  }
}

/**
 * The tools config file (~/.config/ctrl/tools.json). `data` is null until the first scan writes it.
 * Hand edits are picked up: the folder is watched and the file re-read when it changes.
 */
export class ToolsFile {
  data: ToolsConfig | null
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private written?: string

  constructor(
    readonly path: string,
    private onChange: () => void,
  ) {
    this.data = this.read()
  }

  private read(): ToolsConfig | null {
    if (!existsSync(this.path)) return null
    try {
      return parseTools(readFileSync(this.path, "utf8"))
    } catch (err) {
      // A half-saved hand edit: keep what we had until it parses again.
      console.error(`[ctrl] can't read ${this.path}`, err)
      return this.data ?? null
    }
  }

  save(config: ToolsConfig) {
    const text = `${JSON.stringify(config, null, 2)}\n`
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    // Commands and env can hold secrets: owner only, like the harnesses' own configs.
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, this.path)
    this.written = text
    this.data = config
  }

  watch() {
    if (this.watcher) return
    mkdirSync(dirname(this.path), { recursive: true })
    this.watcher = watch(dirname(this.path), (_event, file) => {
      if (file && file !== basename(this.path)) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.reload(), 200)
    })
  }

  private reload() {
    let text: string | null = null
    try {
      text = readFileSync(this.path, "utf8")
    } catch {}
    // Our own save echoing back.
    if (text !== null && text === this.written) return
    const next = this.read()
    if (JSON.stringify(next) === JSON.stringify(this.data)) return
    this.data = next
    this.onChange()
  }

  stop() {
    clearTimeout(this.timer)
    this.watcher?.close()
    this.watcher = undefined
  }
}
