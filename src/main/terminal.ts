import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { WebSocketServer, type WebSocket } from "ws"
import type { IPty } from "node-pty"

const pty: typeof import("node-pty") = createRequire(import.meta.url)("node-pty")

function findOpencode() {
  const candidates = [
    join(homedir(), ".opencode/bin/opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ]
  return candidates.find((p) => existsSync(p))
}

type Events = {
  onData(data: string): void
  onReset(): void
  onRoute(sessionID: string | null): void
  onBridge(connected: boolean): void
}

/**
 * One long-lived opencode TUI in a pty. Switching sessions is done by asking the
 * bridge plugin (running inside the TUI) to navigate, so it is instant. If the
 * bridge isn't connected we fall back to restarting the TUI with `-s <id>`.
 */
export class Terminal {
  private proc?: IPty
  private bridge?: WebSocket
  private wss?: WebSocketServer
  private bridgeUrl = ""
  private size = { cols: 120, rows: 40 }
  private pendingSession: string | null = null
  private cliOverrides: Record<string, unknown> = {}

  constructor(
    private pluginDir: string,
    private events: Events,
  ) {}

  async init() {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    await new Promise<void>((resolve) => this.wss!.once("listening", () => resolve()))
    const addr = this.wss.address()
    if (typeof addr === "object" && addr) this.bridgeUrl = `ws://127.0.0.1:${addr.port}`

    this.wss.on("connection", (ws) => {
      this.bridge?.close()
      this.bridge = ws
      this.events.onBridge(true)
      ws.on("message", (raw) => {
        let msg: { type: string; sessionID?: string | null }
        try {
          msg = JSON.parse(String(raw))
        } catch {
          return
        }
        if (msg.type === "hello" && this.pendingSession) {
          this.navigate(this.pendingSession)
          this.pendingSession = null
        }
        if (msg.type === "route") this.events.onRoute(msg.sessionID ?? null)
      })
      ws.on("close", () => {
        if (this.bridge !== ws) return
        this.bridge = undefined
        this.events.onBridge(false)
      })
    })
  }

  start(cols: number, rows: number, sessionID?: string) {
    this.size = { cols, rows }
    if (this.proc) return
    this.spawn(sessionID)
  }

  private spawn(sessionID?: string) {
    const bin = findOpencode()
    const args = sessionID ? ["-s", sessionID] : []
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CTRL_BRIDGE_URL: this.bridgeUrl,
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({
        ...this.cliOverrides,
        plugins: [this.pluginDir],
        tabs: { mode: "off" },
      }),
    } as Record<string, string>

    // Fall back to a login shell so PATH is resolved when launched from Finder.
    const [file, argv] = bin
      ? [bin, args]
      : [process.env.SHELL || "/bin/zsh", ["-lc", ["exec opencode", ...args].join(" ")]]

    const proc = pty.spawn(file, argv, {
      name: "xterm-256color",
      cols: this.size.cols,
      rows: this.size.rows,
      cwd: homedir(),
      env,
    })
    this.proc = proc
    proc.onData((d) => this.events.onData(d))
    proc.onExit(() => {
      if (this.proc !== proc) return
      this.proc = undefined
      this.events.onData("\r\n\x1b[2m[opencode exited — select a session to restart]\x1b[0m\r\n")
    })
  }

  /**
   * Inline CLI settings only apply at launch, so changing them restarts the TUI
   * on the same session.
   */
  setCliOverrides(overrides: Record<string, unknown>, currentSessionID: string | null) {
    const changed = JSON.stringify(overrides) !== JSON.stringify(this.cliOverrides)
    this.cliOverrides = overrides
    if (!changed || !this.proc) return
    const proc = this.proc
    this.proc = undefined
    this.bridge?.close()
    proc.kill()
    this.events.onReset()
    this.spawn(currentSessionID ?? undefined)
  }

  open(sessionID: string) {
    if (!this.proc) {
      this.events.onReset()
      this.spawn(sessionID)
      return
    }
    if (this.bridge) {
      this.navigate(sessionID)
      return
    }
    // TUI is still booting: navigate as soon as the bridge says hello.
    this.pendingSession = sessionID
  }

  private navigate(sessionID: string) {
    this.bridge?.send(JSON.stringify({ type: "navigate", sessionID }))
  }

  write(data: string) {
    this.proc?.write(data)
  }

  resize(cols: number, rows: number) {
    this.size = { cols, rows }
    try {
      this.proc?.resize(cols, rows)
    } catch {}
  }

  dispose() {
    this.proc?.kill()
    this.wss?.close()
  }
}
