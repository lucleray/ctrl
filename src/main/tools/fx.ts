import type { McpServerConfig, ToolState } from "../../shared/types"
import { lastLine, runShell, shq } from "./cli"

const LIST_TIMEOUT_MS = 15_000
/** `fx mcp show` connects to the server. */
const SHOW_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 5 * 60_000

export type FxServerStatus = { state: ToolState; detail?: string }

/**
 * fx's MCP servers. fx has no service and no events, so this asks its CLI: `fx mcp list --json` (never
 * connects) says which servers fx has, `fx mcp show NAME --json` connects to one and says whether it works
 * (status "needs_login" when it wants you to sign in; exit 0 when fine). Only refreshed while you use fx.
 */
export class FxMcp {
  /** Servers in fx's profile config; null until the first refresh */
  configured: Set<string> | null = null
  status = new Map<string, FxServerStatus>()
  checked = 0
  private refreshing?: Promise<void>

  constructor(
    private bin: () => string | undefined,
    private home: string,
    private onChange: () => void,
  ) {}

  private run(args: string, timeout: number) {
    const bin = this.bin()
    if (!bin) return Promise.resolve({ code: 127, output: "fx isn't installed", timedOut: false })
    // From ~, so project servers of whatever folder ctrl started in don't count.
    return runShell(`${shq(bin)} ${args}`, timeout, this.home)
  }

  /** Re-reads fx's servers, then checks the ones in `wanted` (your list). A refresh in flight is shared. */
  refresh(wanted: string[]) {
    this.refreshing ??= (async () => {
      try {
        const list = await this.run("mcp list --json", LIST_TIMEOUT_MS)
        if (list.code !== 0) throw new Error(lastLine(list.output) || `fx mcp list exited with ${list.code}`)
        const servers = (JSON.parse(list.output).servers ?? []) as { name: string; source?: string }[]
        this.configured = new Set(servers.filter((s) => !s.source || s.source === "profile").map((s) => s.name))
        for (const name of this.status.keys()) if (!this.configured.has(name)) this.status.delete(name)
        this.onChange()
        const names = wanted.filter((n) => this.configured!.has(n))
        // A few at a time: each one connects to its server.
        for (let i = 0; i < names.length; i += 3)
          await Promise.all(names.slice(i, i + 3).map((name) => this.show(name)))
      } catch (err) {
        console.error("[ctrl] fx mcp", err)
      } finally {
        this.checked = Date.now()
        this.refreshing = undefined
        this.onChange()
      }
    })()
    return this.refreshing
  }

  private async show(name: string) {
    const r = await this.run(`mcp show ${shq(name)} --json`, SHOW_TIMEOUT_MS)
    let info: { status?: string; error?: string | null } = {}
    try {
      info = JSON.parse(r.output)
    } catch {}
    const status: FxServerStatus =
      info.status === "needs_login"
        ? { state: "needs-auth" }
        : r.code === 0
          ? { state: "ok" }
          : { state: "broken", detail: info.error || (r.timedOut ? "Timed out" : lastLine(r.output)) || info.status || `Exited with ${r.code}` }
    this.status.set(name, status)
    this.onChange()
  }

  /** `fx mcp add` (refresh afterwards). Throws with fx's message when it fails. */
  async add(server: McpServerConfig) {
    const args =
      server.type === "remote"
        ? [
            ...Object.entries(server.headers ?? {}).map(([k, v]) => `--header ${shq(`${k}=${v}`)}`),
            shq(server.name),
            shq(server.url),
          ]
        : [
            ...Object.entries(server.env ?? {}).map(([k, v]) => `--env ${shq(`${k}=${v}`)}`),
            shq(server.name),
            "--",
            ...server.command.map(shq),
          ]
    const r = await this.run(`mcp add ${args.join(" ")}`, LIST_TIMEOUT_MS)
    if (r.code !== 0) throw new Error(lastLine(r.output) || `fx mcp add exited with ${r.code}`)
  }

  /** `fx mcp login NAME` opens the browser and waits for you. Resolves to its error when it fails. */
  async login(name: string, wanted: string[]): Promise<string | undefined> {
    const r = await this.run(`mcp login ${shq(name)}`, LOGIN_TIMEOUT_MS)
    await this.refresh(wanted)
    if (r.code === 0) return undefined
    return r.timedOut ? "Gave up after 5 minutes" : lastLine(r.output) || `Exited with ${r.code}`
  }
}
