import { execFile } from "node:child_process"
import { timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import { extname, join } from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import type { Stage } from "../shared/adapters/adapter"
import type { Harness, IndexStatus, RemoteStatus, SearchHit, SessionStatus, Tone } from "../shared/types"
import type { ChatPage } from "./remote-chat"
import type { Terminal } from "./terminal"

/** A permission or question waiting on you, shown above the chat's composer */
export type ChatPending = { id: string; kind: "permission" | "question"; detail: string }

/** What the phone's list shows. Kept small: spaces, their sessions and the newest others. */
export type RemoteSnapshot = {
  /** ctrl's appearance, which the TUIs follow too */
  dark: boolean
  spaces: { id: string; name: string }[]
  sessions: {
    id: string
    harness: Harness
    title: string
    status: SessionStatus
    statusDetail?: string
    updated: number
    spaceID: string | null
    directory: string
    /** Session it nests under, like the sidebar's tree */
    parentID?: string
    /** When it was archived (archived sessions only) */
    archived?: number
  }[]
}

/** One Board card, flattened for the phone (src/renderer/Board.tsx draws the desktop one). */
export type RemoteBoardCard = {
  id: string
  url: string
  /** Adapter name: GitHub, Slack, Vercel… */
  source: string
  title: string
  subtitle?: string
  tone?: Tone
  chips: { text: string; tone: Tone }[]
  stage: Stage
  /** Why it's in its column: "CI failed", "Waiting on @vvo"… */
  reason: string
  last: number
  /** Spaces of the sessions mentioning it (id null: no space) */
  spaces: { id: string | null; name: string }[]
  /** Newest two sessions mentioning it */
  sessions: { id: string; title: string }[]
}

/** A message hit from ⌘K's index, with what the phone needs to show sessions it doesn't list */
export type RemoteSearchHit = SearchHit & { spaceID: string | null; archived: boolean; status?: SessionStatus }

type Deps = {
  port: number
  staticDir: string
  token(): string
  snapshot(): RemoteSnapshot
  board(): RemoteBoardCard[]
  /** Fetch live details that are due for these resources (ids) */
  refreshBoard(ids: Set<string>): void
  /** The phone's own opencode TUI, separate from the desktop one so each keeps its own size and session */
  tui: Terminal
  fx: {
    /** The fx terminal for a session, started in the background when it has none */
    open(sessionID: string): Promise<string>
    backlog(termID: string): { data: string; end: number }
    write(termID: string, data: string): void
    resize(termID: string, size: { cols: number; rows: number } | null): void
  }
  /** New session in a space (null: none), with that space's folder, harness and model; returns its id */
  create(spaceID: string | null): Promise<string>
  /** Message search, the same index as the palette (⌘K) */
  search(query: string): { hits: RemoteSearchHit[]; status: IndexStatus }
  /** Archive (children come along, like the sidebar) or unarchive a session */
  setArchived(sessionID: string, on: boolean): void
  /** opencode sessions as a chat (src/main/remote-chat.ts) */
  chat: {
    page(sessionID: string, cursor?: string): Promise<ChatPage>
    send(sessionID: string, text: string): Promise<void>
    stop(sessionID: string): Promise<void>
    reply(sessionID: string, requestID: string, decision: "once" | "always" | "reject"): Promise<void>
    pending(sessionID: string): ChatPending[]
    title(sessionID: string): string | undefined
  }
  /** Why a session can't be opened from the phone, if it can't */
  cantOpen(sessionID: string): string | null
  onStatus(): void
}

type View = { sessionID: string; harness: Harness; termID?: string; cols: number; rows: number }
type Viewer = {
  ws: WebSocket
  view?: View
  seq: number
  board?: boolean
  /** opencode session open in the chat view */
  chat?: string
  /** Last pending list sent, to send only changes */
  pendingJSON?: string
}

type Inbound =
  | { t: "open"; id: string; cols: number; rows: number }
  | { t: "input"; data: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "leave" }
  | { t: "board"; on: boolean }
  | { t: "new"; spaceID: string | null }
  | { t: "archive"; id: string; on: boolean }
  | { t: "search"; q: string; seq: number }
  | { t: "chat"; id: string }
  | { t: "chat-more"; cursor: string }
  | { t: "chat-send"; text: string }
  | { t: "chat-stop" }
  | { t: "chat-reply"; requestID: string; decision: "once" | "always" | "reject" }

const COOKIE = "ctrl_remote"
/** The phone's TUI quits after this long with nobody looking at it, and comes back on the next open. */
const TUI_IDLE_MS = 10 * 60_000
/** Interfaces are checked this often, so Tailscale connecting (or its address changing) is picked up. */
const RECHECK_MS = 15_000
/** While a turn streams, the chat view re-reads the newest messages at most this often. */
const CHAT_THROTTLE_MS = 300
/** Board updates (new mentions, live details landing) are batched this long. */
const BOARD_DEBOUNCE_MS = 500
/** A viewer this far behind (slow network) is dropped; it reconnects and repaints. */
const MAX_BUFFERED = 8 * 1024 * 1024

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
}

/** Tailscale gives each device an address in 100.64.0.0/10 (CGNAT range). */
function tailscaleAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue
      const [x, y] = a.address.split(".").map(Number)
      if (x === 100 && y >= 64 && y <= 127) return a.address
    }
  }
  return null
}

/** This Mac's MagicDNS name (e.g. "mac.tail1234.ts.net"), when the tailscale CLI can tell. */
function magicDNSName(): Promise<string | null> {
  const bins = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
  const tryBin = (i: number): Promise<string | null> =>
    i >= bins.length
      ? Promise.resolve(null)
      : new Promise((resolve) =>
          execFile(bins[i], ["status", "--json", "--self", "--peers=false"], { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve(tryBin(i + 1))
            try {
              const name = JSON.parse(stdout)?.Self?.DNSName
              resolve(typeof name === "string" && name ? name.replace(/\.$/, "") : null)
            } catch {
              resolve(null)
            }
          }),
        )
  return tryBin(0)
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const cookieOf = (req: IncomingMessage) => {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === COOKIE) return v.join("=")
  }
  return ""
}

/**
 * Remote control: a small web app (src/remote) served on this Mac's Tailscale address, so a phone on the
 * same tailnet lists spaces and sessions and drives their terminals.
 *
 * - opencode sessions get their own TUI (started on first open, sized to the phone), so the desktop one
 *   keeps its session and size. Both talk to the same opencode service, so running turns are shared.
 * - fx has one process per session, so the phone mirrors the desktop's pty, resized to the phone while
 *   it's looking.
 * - Access: only the Tailscale interface listens (localhost when there's none), and the URL carries a
 *   token that becomes an HttpOnly cookie on first visit.
 */
export class RemoteServer {
  status: RemoteStatus = { state: "off" }
  private server?: Server
  private wss?: WebSocketServer
  private host: string | null = null
  private viewers = new Set<Viewer>()
  private recheck?: ReturnType<typeof setInterval>
  private idleTimer?: ReturnType<typeof setTimeout>
  private lastSnapshot = ""
  private boardTimer?: ReturnType<typeof setTimeout>
  private lastBoard = ""
  private chatTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private deps: Deps) {}

  async setEnabled(on: boolean) {
    if (on && !this.recheck) {
      this.recheck = setInterval(() => {
        if ((tailscaleAddress() ?? "127.0.0.1") !== this.host) void this.listen()
      }, RECHECK_MS)
      await this.listen()
    } else if (!on && this.recheck) {
      clearInterval(this.recheck)
      this.recheck = undefined
      this.close()
      this.deps.tui.stop()
      this.setStatus({ state: "off" })
    }
  }

  private setStatus(status: RemoteStatus) {
    this.status = status
    this.deps.onStatus()
  }

  private async listen() {
    this.close()
    const host = tailscaleAddress() ?? "127.0.0.1"
    this.host = host
    const server = createServer((req, res) => void this.http(req, res))
    const wss = new WebSocketServer({ noServer: true })
    server.on("upgrade", (req, socket, head) => {
      if (!this.authorized(req) || new URL(req.url ?? "/", "http://x").pathname !== "/ws" || !this.sameOrigin(req)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.connection(ws))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(this.deps.port, host, () => resolve())
      })
    } catch (err) {
      this.setStatus({ state: "error", detail: err instanceof Error ? err.message : String(err) })
      return
    }
    this.server = server
    this.wss = wss
    console.log(`[ctrl] remote control on http://${host}:${this.deps.port}`)
    const token = this.deps.token()
    const url = (h: string) => `http://${h}:${this.deps.port}/?token=${token}`
    const local = host === "127.0.0.1"
    this.setStatus({ state: local ? "local" : "on", urls: [url(host)], port: this.deps.port })
    if (local) return
    const name = await magicDNSName()
    if (name && this.server === server) this.setStatus({ state: "on", urls: [url(name), url(host)], port: this.deps.port })
  }

  private close() {
    for (const v of this.viewers) v.ws.close()
    this.viewers.clear()
    this.wss?.close()
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = undefined
    this.wss = undefined
  }

  private authorized(req: IncomingMessage) {
    const cookie = cookieOf(req)
    return !!cookie && sameSecret(cookie, this.deps.token())
  }

  /** Browsers send Origin on WebSocket upgrades: only the page we served may connect. */
  private sameOrigin(req: IncomingMessage) {
    const origin = req.headers.origin
    if (!origin) return false
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  private async http(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x")
    const given = url.searchParams.get("token")
    const headers: Record<string, string> = {}
    if (given !== null) {
      if (!sameSecret(given, this.deps.token())) return this.deny(res)
      // Into a cookie; the page then takes it out of the address bar. No redirect: a link opened from
      // another app is a cross-site navigation, and browsers hold back fresh cookies along its redirects.
      // Lax, not Strict, for the same reason (Strict cookies skip navigations coming from other apps).
      headers["Set-Cookie"] = `${COOKIE}=${given}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`
    } else if (!this.authorized(req)) return this.deny(res)
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
    if (!/^[\w.-]+$/.test(file)) return this.notFound(res)
    try {
      const body = await readFile(join(this.deps.staticDir, file))
      res.writeHead(200, {
        ...headers,
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      })
      res.end(body)
    } catch {
      this.notFound(res)
    }
  }

  private deny(res: ServerResponse) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Open the link from ctrl → Settings → Remote control.")
  }

  private notFound(res: ServerResponse) {
    res.writeHead(404)
    res.end()
  }

  // ---------- viewers ----------

  private connection(ws: WebSocket) {
    const viewer: Viewer = { ws, seq: 0 }
    this.viewers.add(viewer)
    this.send(viewer, { t: "state", ...this.deps.snapshot() })
    ws.on("message", (raw) => {
      let msg: Inbound
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      void this.message(viewer, msg).catch((err) =>
        this.send(viewer, { t: "error", message: err instanceof Error ? err.message : String(err) }),
      )
    })
    ws.on("close", () => {
      this.leave(viewer)
      this.viewers.delete(viewer)
    })
  }

  private send(viewer: Viewer, msg: unknown) {
    if (viewer.ws.readyState !== viewer.ws.OPEN) return
    if (viewer.ws.bufferedAmount > MAX_BUFFERED) {
      viewer.ws.terminate()
      return
    }
    viewer.ws.send(JSON.stringify(msg))
  }

  private async message(viewer: Viewer, msg: Inbound) {
    if (msg.t === "open") return this.open(viewer, msg.id, size(msg))
    if (msg.t === "leave") return this.leave(viewer)
    if (msg.t === "chat") return this.openChat(viewer, msg.id)
    if (typeof msg.t === "string" && msg.t.startsWith("chat-")) {
      const id = viewer.chat
      if (!id) return
      if (msg.t === "chat-more" && typeof msg.cursor === "string") {
        const page = await this.deps.chat.page(id, msg.cursor)
        if (viewer.chat === id) this.send(viewer, { t: "chat-more", id, ...page })
      } else if (msg.t === "chat-send" && typeof msg.text === "string" && msg.text.trim()) {
        await this.deps.chat.send(id, msg.text)
        this.sessionEvent(id)
      } else if (msg.t === "chat-stop") {
        await this.deps.chat.stop(id)
      } else if (msg.t === "chat-reply" && ["once", "always", "reject"].includes(msg.decision)) {
        await this.deps.chat.reply(id, String(msg.requestID), msg.decision)
      }
      return
    }
    if (msg.t === "new") {
      const id = await this.deps.create(typeof msg.spaceID === "string" ? msg.spaceID : null)
      this.send(viewer, { t: "created", id })
      return
    }
    if (msg.t === "search") {
      if (typeof msg.q !== "string") return
      this.send(viewer, { t: "search", seq: msg.seq, q: msg.q, ...this.deps.search(msg.q.slice(0, 200)) })
      return
    }
    if (msg.t === "archive") {
      if (typeof msg.id === "string") this.deps.setArchived(msg.id, !!msg.on)
      return
    }
    if (msg.t === "board") {
      viewer.board = !!msg.on
      if (!viewer.board) return
      const cards = this.deps.board()
      this.send(viewer, { t: "board", cards })
      this.deps.refreshBoard(new Set(cards.filter((c) => c.stage !== "done").map((c) => c.id)))
      return
    }
    const view = viewer.view
    if (!view) return
    if (msg.t === "input" && typeof msg.data === "string") {
      if (view.harness === "opencode") this.deps.tui.write(msg.data)
      else if (view.termID) this.deps.fx.write(view.termID, msg.data)
    } else if (msg.t === "resize") {
      Object.assign(view, size(msg))
      if (view.harness === "opencode") this.deps.tui.resize(view.cols, view.rows)
      else if (view.termID) this.deps.fx.resize(view.termID, view)
    }
  }

  private async open(viewer: Viewer, sessionID: string, { cols, rows }: { cols: number; rows: number }) {
    if (typeof sessionID !== "string") return
    const problem = this.deps.cantOpen(sessionID)
    if (problem) throw new Error(problem)
    this.leave(viewer)
    const seq = ++viewer.seq
    const harness: Harness = sessionID.startsWith("fx:") ? "fx" : "opencode"
    const view: View = { sessionID, harness, cols, rows }
    if (harness === "opencode") {
      clearTimeout(this.idleTimer)
      viewer.view = view
      this.send(viewer, { t: "open", id: sessionID, harness })
      const tui = this.deps.tui
      if (!tui.running) tui.start(cols, rows, sessionID)
      else {
        tui.resize(cols, rows)
        tui.open(sessionID)
        tui.repaint()
      }
      return
    }
    const termID = await this.deps.fx.open(sessionID)
    // Another open (or a leave) came in while fx was starting.
    if (viewer.seq !== seq) return
    view.termID = termID
    viewer.view = view
    this.send(viewer, { t: "open", id: sessionID, harness })
    this.send(viewer, { t: "data", data: this.deps.fx.backlog(termID).data })
    this.deps.fx.resize(termID, { cols, rows })
  }

  private async openChat(viewer: Viewer, sessionID: string) {
    if (typeof sessionID !== "string") return
    const problem = this.deps.cantOpen(sessionID)
    if (problem) throw new Error(problem)
    this.leave(viewer)
    viewer.chat = sessionID
    const seq = viewer.seq
    const page = await this.deps.chat.page(sessionID)
    if (viewer.seq !== seq || viewer.chat !== sessionID) return
    const pending = this.deps.chat.pending(sessionID)
    viewer.pendingJSON = JSON.stringify(pending)
    this.send(viewer, { t: "chat", id: sessionID, title: this.deps.chat.title(sessionID), ...page, pending })
  }

  /** Something happened in a session (text streamed, a tool ran, a turn ended): refresh phones chatting in it. */
  sessionEvent(sessionID: string) {
    if (this.chatTimers.has(sessionID) || ![...this.viewers].some((v) => v.chat === sessionID)) return
    this.chatTimers.set(
      sessionID,
      setTimeout(async () => {
        this.chatTimers.delete(sessionID)
        const watching = [...this.viewers].filter((v) => v.chat === sessionID)
        if (!watching.length) return
        try {
          const { items } = await this.deps.chat.page(sessionID)
          for (const v of watching) if (v.chat === sessionID) this.send(v, { t: "chat-update", id: sessionID, items })
        } catch (err) {
          console.error("[ctrl] remote chat refresh failed", err)
        }
      }, CHAT_THROTTLE_MS),
    )
  }

  private leave(viewer: Viewer) {
    viewer.chat = undefined
    viewer.pendingJSON = undefined
    const view = viewer.view
    viewer.view = undefined
    viewer.seq++
    if (!view) return
    if (view.harness === "fx" && view.termID) {
      const stillViewed = [...this.viewers].some((v) => v !== viewer && v.view?.termID === view.termID)
      if (!stillViewed) this.deps.fx.resize(view.termID, null)
    }
    if (view.harness === "opencode" && ![...this.viewers].some((v) => v !== viewer && v.view?.harness === "opencode")) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.deps.tui.stop(), TUI_IDLE_MS)
    }
  }

  // ---------- from main ----------

  /** Output of the phone's opencode TUI. */
  tuiData(data: string) {
    for (const v of this.viewers) if (v.view?.harness === "opencode") this.send(v, { t: "data", data })
  }

  tuiReset() {
    for (const v of this.viewers) if (v.view?.harness === "opencode") this.send(v, { t: "reset" })
  }

  fxData(termID: string, data: string) {
    if (!this.viewers.size) return
    for (const v of this.viewers) if (v.view?.termID === termID) this.send(v, { t: "data", data })
  }

  /** Resources or their live details changed: resend the board to phones looking at it. */
  boardChanged() {
    if (![...this.viewers].some((v) => v.board)) return
    clearTimeout(this.boardTimer)
    this.boardTimer = setTimeout(() => {
      const cards = this.deps.board()
      const json = JSON.stringify(cards)
      if (json === this.lastBoard) return
      this.lastBoard = json
      for (const v of this.viewers) if (v.board) this.send(v, { t: "board", cards })
    }, BOARD_DEBOUNCE_MS)
  }

  /** Sessions or spaces may have changed: send the list to phones when it did. */
  changed() {
    if (!this.viewers.size) return
    const snapshot = this.deps.snapshot()
    // Permissions and questions come and go with pushes: phones in a chat get theirs when they change.
    for (const v of this.viewers) {
      if (!v.chat) continue
      const pending = this.deps.chat.pending(v.chat)
      const pjson = JSON.stringify(pending)
      if (pjson === v.pendingJSON) continue
      v.pendingJSON = pjson
      this.send(v, { t: "chat-pending", id: v.chat, pending })
    }
    const json = JSON.stringify(snapshot)
    if (json === this.lastSnapshot) return
    this.lastSnapshot = json
    for (const v of this.viewers) this.send(v, { t: "state", ...snapshot })
  }

  stop() {
    void this.setEnabled(false)
  }
}

const size = (msg: { cols?: unknown; rows?: unknown }) => ({
  cols: Math.max(20, Math.min(500, Math.round(Number(msg.cols) || 80))),
  rows: Math.max(5, Math.min(300, Math.round(Number(msg.rows) || 24))),
})
