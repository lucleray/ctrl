import { homedir } from "node:os"
import {
  TOOL_BROKEN,
  type CliToolConfig,
  type DetectedTool,
  type Harness,
  type McpServerConfig,
  type McpServerItem,
  type Toast,
  type ToolHarness,
  type ToolHarnessState,
  type ToolItem,
  type ToolsConfig,
} from "../../shared/types"
import { cliToolID, MCP_STATES } from "../../shared/tools"
import { ToolAlerts, type Alert } from "./alerts"
import { CliTools } from "./cli"
import { ToolsFile } from "./config"
import { detect, type Detection } from "./detect"
import { FxMcp } from "./fx"

/** fx MCP servers: checked when you start using fx, then this often while you do, and on focus once this old. */
const FX_EVERY_MS = 10 * 60_000
const FX_FOCUS_STALE_MS = 2 * 60_000

export type ToolsHost = {
  opencode: {
    /** You use opencode (it's installed and its TUI runs): its MCP servers get checked */
    active(): boolean
    servers(): McpServerItem[]
    configs(): Promise<McpServerConfig[]>
    add(server: McpServerConfig): Promise<void>
    reconnect(name: string): Promise<void>
  }
  fx: {
    installed(): boolean
    /** You have an fx session open: its MCP servers get checked (lazy, nothing runs otherwise) */
    active(): boolean
    bin(): string | undefined
    home: string
  }
  toast(t: Pick<Toast, "icon" | "message">, opts?: { sticky?: boolean; action?: { label: string; run(): void } }): string
  dismissToast(id: string): void
  /** Opens the TUI's new-session screen with this prompt typed in, not sent */
  prefill(prompt: string): void
  openExternal(url: string): void
  changed(): void
}

const RANK: Record<ToolHarnessState, number> = {
  "needs-auth": 6,
  broken: 6,
  missing: 5,
  "not-set-up": 5,
  checking: 3,
  pending: 3,
  ok: 2,
  disabled: 1,
  unused: 0,
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const fixPrompt = (name: string, harness: Harness, state: string, detail?: string) => {
  const error = detail ? `, error: "${oneLine(detail, 300)}"` : ""
  return harness === "fx"
    ? `The "${name}" MCP server is broken in fx (status: ${state}${error}). Diagnose and fix it: ` +
        `\`fx mcp show ${name}\` shows its status and ~/.fx/mcp.json its config. If it only needs sign-in, ` +
        `tell me to run \`fx mcp login ${name}\` instead.`
    : `The "${name}" MCP server is broken in opencode (status: ${state}${error}). ` +
        `Diagnose and fix it: check its entry in my opencode config and \`opencode mcp list\`. ` +
        `If it only needs sign-in, tell me to run /mcps and select it instead.`
}

const cliPrompt = (tool: ToolItem) => {
  const error = tool.detail ? ` with "${oneLine(tool.detail, 300)}"` : ""
  return (
    `ctrl checks the "${tool.name}" CLI with \`${tool.check}\`, and it fails${error}. ` +
    `Diagnose and fix it, usually by logging in again. If the login is interactive and you can't finish it ` +
    `yourself, tell me exactly what to run in my terminal. Run the check again at the end to confirm.`
  )
}

/**
 * Watched tools (docs/ARCHITECTURE.md → Tools): the list in tools.json, what a scan finds, where each
 * MCP server stands in each harness you use, CLI checks, and the toasts and fixes for all of them.
 * Before tools.json exists, opencode's MCP servers are watched as they are.
 */
export class ToolsService {
  readonly file: ToolsFile
  private cli: CliTools
  private fx: FxMcp
  private alerts: ToolAlerts
  private lastScan?: Detection
  private fxWasActive = false
  private timer?: ReturnType<typeof setInterval>

  constructor(
    path: string,
    private host: ToolsHost,
  ) {
    this.file = new ToolsFile(path, () => this.configChanged())
    this.cli = new CliTools(() => this.changed())
    this.fx = new FxMcp(() => host.fx.bin(), homedir(), () => this.changed())
    this.alerts = new ToolAlerts(
      {
        toast: (message, action) => host.toast({ icon: "alert", message }, { sticky: true, action }),
        dismiss: (id) => host.dismissToast(id),
      },
      (id) => void this.fix(id),
    )
    this.cli.configure(this.file.data?.cli ?? [])
  }

  get setUp() {
    return !!this.file.data
  }

  start() {
    this.file.watch()
    this.cli.start()
    this.timer ??= setInterval(() => this.harnessesChanged(), 30_000)
    this.harnessesChanged()
  }

  stop() {
    clearInterval(this.timer)
    this.cli.stop()
    this.file.stop()
  }

  /** Something a tool depends on changed (opencode's MCP statuses, a check finished): re-sync the toasts. */
  changed() {
    this.alerts.sync(this.alertList())
    this.host.changed()
  }

  private configChanged() {
    this.cli.configure(this.file.data?.cli ?? [])
    void this.refreshFx()
    this.changed()
  }

  private fxActive() {
    return this.setUp && this.host.fx.installed() && this.host.fx.active()
  }

  /** Sessions or terminals changed (and every 30s): fx is checked as soon as you start using it. */
  harnessesChanged() {
    const active = this.fxActive()
    if (active && (!this.fxWasActive || Date.now() - this.fx.checked > FX_EVERY_MS)) void this.refreshFx()
    if (active !== this.fxWasActive) {
      this.fxWasActive = active
      this.changed()
    }
  }

  focused() {
    this.cli.focused()
    if (this.fxActive() && Date.now() - this.fx.checked > FX_FOCUS_STALE_MS) void this.refreshFx()
  }

  private wanted() {
    return (this.file.data?.mcp ?? []).map((s) => s.name)
  }

  private refreshFx() {
    return this.fxActive() ? this.fx.refresh(this.wanted()) : Promise.resolve()
  }

  // ---------- state ----------

  private opencodeIn(name: string): ToolHarness {
    if (!this.host.opencode.active()) return { harness: "opencode", state: "unused" }
    const server = this.host.opencode.servers().find((s) => s.name === name)
    if (!server) return { harness: "opencode", state: "not-set-up", label: "Add" }
    const state = MCP_STATES[server.status]
    return {
      harness: "opencode",
      state,
      ...(server.error ? { detail: server.error } : {}),
      ...(state === "broken" || state === "needs-auth" ? { label: "Fix" } : {}),
    }
  }

  private fxIn(name: string): ToolHarness | null {
    if (!this.host.fx.installed()) return null
    if (!this.fxActive()) return { harness: "fx", state: "unused" }
    if (!this.fx.configured) return { harness: "fx", state: "checking" }
    if (!this.fx.configured.has(name)) return { harness: "fx", state: "not-set-up", label: "Add" }
    const status = this.fx.status.get(name) ?? { state: "checking" as const }
    return {
      harness: "fx",
      ...status,
      ...(status.state === "needs-auth" ? { label: "Log in" } : status.state === "broken" ? { label: "Fix" } : {}),
    }
  }

  private mcpItem(name: string, harnesses: ToolHarness[]): ToolItem {
    const worst = harnesses.reduce<ToolHarness | undefined>((w, h) => (!w || RANK[h.state] > RANK[w.state] ? h : w), undefined)
    const state = !worst || worst.state === "unused" ? "disabled" : worst.state === "not-set-up" ? "missing" : worst.state
    const detail = worst?.state === "not-set-up" ? `Not set up in ${worst.harness}` : worst?.detail
    return {
      id: `mcp:${name}`,
      kind: "mcp",
      name,
      state,
      ...(detail ? { detail: harnesses.length > 1 && worst?.state !== "not-set-up" ? `${worst!.harness}: ${detail}` : detail } : {}),
      fix: "session",
      label: worst?.label ?? "Fix",
      harnesses,
    }
  }

  items(): ToolItem[] {
    const data = this.file.data
    const mcp = data
      ? data.mcp.map((s) => this.mcpItem(s.name, [this.opencodeIn(s.name), this.fxIn(s.name)].filter((h): h is ToolHarness => !!h)))
      : this.host.opencode.servers().map((s) => this.mcpItem(s.name, [this.opencodeIn(s.name)]))
    const configs = new Map((data?.cli ?? []).map((c) => [`cli:${c.id}`, c]))
    return [
      ...mcp,
      ...this.cli.items().map((t) => {
        const config = configs.get(t.id)
        return { ...t, ...(config?.key ? {} : { custom: true }), ...(config ? { config } : {}) }
      }),
    ]
  }

  private alertList(): Alert[] {
    const out: Alert[] = []
    const missing: Record<Harness, string[]> = { opencode: [], fx: [] }
    const holdSetup = new Set<Harness>()
    for (const item of this.items()) {
      if (item.kind === "cli") {
        if (TOOL_BROKEN.includes(item.state)) {
          const verb = item.state === "missing" ? "isn't installed" : "stopped working"
          out.push({
            id: item.id,
            key: `${item.state}:${item.detail ?? ""}`,
            message: `“${item.name}” ${verb}${item.detail ? `: ${item.detail}` : ""}`,
            label: item.label,
          })
        } else if (item.state === "checking") out.push({ id: item.id, key: "", message: "", label: "", hold: true })
        continue
      }
      for (const h of item.harnesses ?? []) {
        const id = `${item.id}@${h.harness}`
        if (h.state === "not-set-up") missing[h.harness].push(item.name)
        else if (h.state === "broken" || h.state === "needs-auth") {
          const where = this.setUp ? ` in ${h.harness}` : ""
          const verb = h.state === "needs-auth" ? "needs sign-in" : "is failing"
          out.push({
            id,
            key: `${h.state}:${h.detail ?? ""}`,
            message: `MCP “${item.name}” ${verb}${where}${h.detail ? `: ${h.detail}` : ""}`,
            label: h.label ?? "Fix",
          })
        } else if (h.state === "pending" || h.state === "checking") {
          out.push({ id, key: "", message: "", label: "", hold: true })
          if (h.state === "checking") holdSetup.add(h.harness)
        }
      }
    }
    for (const harness of ["opencode", "fx"] as const) {
      const names = missing[harness]
      if (names.length)
        out.push({
          id: `setup@${harness}`,
          key: names.join(","),
          message:
            names.length === 1
              ? `${harness} doesn't have your MCP server “${names[0]}”`
              : `${harness} is missing ${names.length} of your MCP servers: ${names.join(", ")}`,
          label: "Set up",
        })
      else if (holdSetup.has(harness)) out.push({ id: `setup@${harness}`, key: "", message: "", label: "", hold: true })
    }
    return out
  }

  // ---------- fixes ----------

  /**
   * Runs a fix: `cli:x`, `mcp:x` (its worst harness), `mcp:x@fx`, or `setup@fx` (adds every missing server).
   * Resolves to true when it put a prompt in the TUI, so the caller can bring it on screen.
   */
  async fix(id: string): Promise<boolean> {
    if (id.startsWith("setup@")) return (await this.addTo(id.slice("setup@".length) as Harness)), false
    if (id.startsWith("cli:")) return this.fixCli(id)
    const at = id.lastIndexOf("@")
    const toolID = at > 0 ? id.slice(0, at) : id
    const item = this.items().find((t) => t.id === toolID)
    if (!item) return false
    const h =
      at > 0
        ? item.harnesses?.find((x) => x.harness === id.slice(at + 1))
        : [...(item.harnesses ?? [])].sort((a, b) => RANK[b.state] - RANK[a.state]).find((x) => x.label)
    if (!h) return false
    if (h.state === "not-set-up") return (await this.addTo(h.harness, [item.name])), false
    if (h.harness === "fx" && h.state === "needs-auth") return (await this.fxLogin(item.name)), false
    this.host.prefill(fixPrompt(item.name, h.harness, h.state, h.detail))
    return true
  }

  /** Writes your servers (all missing ones, or these) into a harness's config. */
  private async addTo(harness: Harness, names?: string[]) {
    const want = names ?? this.items().filter((t) => t.harnesses?.some((h) => h.harness === harness && h.state === "not-set-up")).map((t) => t.name)
    const servers = (this.file.data?.mcp ?? []).filter((s) => want.includes(s.name))
    if (!servers.length) return
    const added: string[] = []
    try {
      for (const server of servers) {
        if (harness === "opencode") await this.host.opencode.add(server)
        else await this.fx.add(server)
        added.push(server.name)
      }
    } catch (err) {
      const failed = servers[added.length]?.name
      this.host.toast({ icon: "alert", message: `Couldn't add “${failed}” to ${harness}: ${err instanceof Error ? err.message : err}` })
    }
    if (harness === "fx") await this.refreshFx()
    this.alerts.forget(`setup@${harness}`)
    if (added.length)
      this.host.toast({
        icon: "check",
        message: `Added ${added.length === 1 ? `“${added[0]}”` : `${added.length} MCP servers`} to ${harness}. Servers that need sign-in will say so`,
      })
    this.changed()
  }

  private async fxLogin(name: string) {
    this.host.toast({ icon: "terminal", message: `Running fx mcp login ${name}… finish in your browser` })
    const error = await this.fx.login(name, this.wanted())
    if (this.fx.status.get(name)?.state === "ok") return void this.host.toast({ icon: "check", message: `MCP “${name}” works in fx again` })
    this.alerts.forget(`mcp:${name}@fx`)
    this.changed()
    if (error) this.host.toast({ icon: "alert", message: `fx mcp login ${name} didn't work: ${error}` })
  }

  private fixCli(id: string): boolean {
    const tool = this.items().find((t) => t.id === id)
    const configID = id.slice("cli:".length)
    const fix = this.cli.config(configID)?.fix
    if (!tool || !fix) return false
    if (fix.kind === "session") {
      this.host.prefill(fix.prompt || cliPrompt(tool))
      return true
    }
    if (fix.kind === "url") {
      // You finish in the browser: the check reruns when ctrl gets focus back.
      this.alerts.forget(id)
      this.host.openExternal(fix.url)
      return false
    }
    if (tool.fixing) return false
    this.host.toast({ icon: "terminal", message: `Running ${oneLine(fix.command, 80)}…` })
    void this.cli.runFix(configID).then(({ ok, detail }) => {
      if (ok) return void this.host.toast({ icon: "check", message: `“${tool.name}” works again` })
      this.alerts.forget(id)
      this.changed()
      if (detail) this.host.toast({ icon: "alert", message: `${oneLine(fix.command, 60)} didn't fix “${tool.name}”: ${detail}` })
    })
    return false
  }

  /** Checks a CLI again, or an MCP server everywhere you use it (opencode reconnects it). */
  async check(id: string) {
    if (id.startsWith("cli:")) return void (await this.cli.check([id.slice("cli:".length)]))
    const name = id.replace(/^mcp:/, "")
    const runs: Promise<unknown>[] = [this.refreshFx()]
    if (this.host.opencode.active() && this.host.opencode.servers().some((s) => s.name === name))
      runs.push(this.host.opencode.reconnect(name))
    await Promise.all(runs)
  }

  /** Runs every CLI check now (`ids`: only these config ids). */
  checkCli(ids?: string[]) {
    return this.cli.check(ids).then(() => undefined)
  }

  // ---------- the list ----------

  private config(): ToolsConfig {
    const data = this.file.data
    if (!data) throw new Error("No tools list yet: run a scan first")
    return data
  }

  private save(config: ToolsConfig) {
    this.file.save(config)
    this.configChanged()
  }

  /** Detection, remembered so applyScan() can act on it. Nothing changes until then. */
  async scan(): Promise<DetectedTool[]> {
    const d = await detect({
      opencode: () => this.host.opencode.configs(),
      ...(this.host.fx.installed() ? { fxHome: this.host.fx.home } : {}),
    })
    this.lastScan = d
    const data = this.file.data
    return [
      ...d.mcp.map((m) => ({
        key: `mcp:${m.config.name}`,
        kind: "mcp" as const,
        name: m.config.name,
        description: `in ${m.from.join(" and ")}`,
        watched: !!data?.mcp.some((s) => s.name === m.config.name),
      })),
      ...d.cli.map((c) => ({
        key: c.key,
        kind: "cli" as const,
        name: c.name,
        description: c.check,
        watched: !!data?.cli.some((x) => x.key === c.key),
      })),
    ]
  }

  /**
   * Checked keys of the last scan get watched (your edits to ones already watched are kept), unchecked
   * ones stop being watched. What the scan didn't see stays as it is, so a harness that's down doesn't
   * empty your list, and CLIs you added by hand are never touched.
   */
  applyScan(checked: string[]) {
    const d = this.lastScan
    if (!d) throw new Error("Scan first")
    const keep = new Set(checked)
    const data = this.file.data ?? { version: 1 as const, mcp: [], cli: [] }
    const seenMcp = new Map(d.mcp.map((m) => [m.config.name, m.config]))
    const mcp = data.mcp.filter((s) => !seenMcp.has(s.name) || keep.has(`mcp:${s.name}`))
    for (const [name, config] of seenMcp) if (keep.has(`mcp:${name}`) && !mcp.some((s) => s.name === name)) mcp.push(config)
    const seenCli = new Map(d.cli.map((c) => [c.key, c]))
    const cli = data.cli.filter((c) => !c.key || !seenCli.has(c.key) || keep.has(c.key))
    for (const [key, c] of seenCli) {
      if (!keep.has(key) || cli.some((x) => x.key === key)) continue
      cli.push({ ...c, id: cliToolID(c.id, cli.map((x) => x.id)) })
    }
    this.save({ version: 1, mcp, cli })
  }

  /** Adds (new id) or replaces a CLI check. */
  saveCli(config: CliToolConfig) {
    const data = this.config()
    const exists = data.cli.some((c) => c.id === config.id)
    this.save({ ...data, cli: exists ? data.cli.map((c) => (c.id === config.id ? config : c)) : [...data.cli, config] })
  }

  /** Stops watching it. Returns false when it wasn't in the list. */
  remove(id: string) {
    const data = this.config()
    const next = id.startsWith("mcp:")
      ? { ...data, mcp: data.mcp.filter((s) => `mcp:${s.name}` !== id) }
      : { ...data, cli: data.cli.filter((c) => `cli:${c.id}` !== id) }
    if (next.mcp.length + next.cli.length === data.mcp.length + data.cli.length) return false
    this.save(next)
    return true
  }

  cliConfigs() {
    return this.file.data?.cli ?? []
  }
}
