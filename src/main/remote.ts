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

/** A permission or question waiting on you, shown above the chat's composer */
export type ChatPending =
  | { id: string; kind: "permission"; detail: string }
  /** fields: the form opencode asks (src/remote/client.ts draws them and answers with chat-answer) */
  | { id: string; kind: "question"; detail: string; title: string; fields: FormField[] }

/** One field of an opencode question form, as opencode describes it (@opencode/client's FormField) */
export type FormField = {
  key: string
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  when?: { key: string; op: "eq" | "neq"; value: unknown }[]
  options?: { value: string; label: string; description?: string }[]
  custom?: boolean
  placeholder?: string
  default?: unknown
  url?: string
  minItems?: number
  maxItems?: number
}

export type FormAnswer = Record<string, string | number | boolean | string[]>

/** What the phone's list shows. Kept small: spaces, their sessions and the newest others. */
export type RemoteSnapshot = {
  /** ctrl's appearance, which the phone follows */
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
  /** New session in a space (null: none), with that space's folder, harness and model; returns its id.
   *  With parentID: a child of that session instead (its space, folder and harness). */
  create(spaceID: string | null, parentID?: string): Promise<string>
  rename(sessionID: string, title: string): Promise<void>
  /** Into a space (null: none), children along; unarchives it, like the sidebar's Move to */
  move(sessionID: string, spaceID: string | null): void
  detach(sessionID: string): void
  /** Message search, the same index as the palette (⌘K) */
  search(query: string): { hits: RemoteSearchHit[]; status: IndexStatus }
  /** Archive (children come along, like the sidebar) or unarchive a session */
  setArchived(sessionID: string, on: boolean): void
  /** opencode sessions as a chat (src/main/remote-chat.ts) */
  chat: {
    page(sessionID: string, cursor?: string): Promise<ChatPage>
    /** images: data: URLs (see cleanImages) */
    send(sessionID: string, text: string, images: string[]): Promise<void>
    /** An image attached to a message you sent */
    image(sessionID: string, messageID: string, index: number): Promise<{ mime: string; body: Buffer } | null>
    stop(sessionID: string): Promise<void>
    reply(sessionID: string, requestID: string, decision: "once" | "always" | "reject"): Promise<void>
    /** Answer a question form (answer null: dismiss it) */
    answer(sessionID: string, formID: string, answer: FormAnswer | null): Promise<void>
    pending(sessionID: string): ChatPending[]
    title(sessionID: string): string | undefined
  }
  /** Why a session can't be opened from the phone, if it can't */
  cantOpen(sessionID: string): string | null
  onStatus(): void
}

type Viewer = {
  ws: WebSocket
  seq: number
  board?: boolean
  /** opencode session open in the chat view */
  chat?: string
  /** Last pending list sent, to send only changes */
  pendingJSON?: string
}

type Inbound =
  | { t: "leave" }
  | { t: "board"; on: boolean }
  | { t: "new"; spaceID: string | null; parentID?: string }
  | { t: "archive"; id: string; on: boolean }
  | { t: "rename"; id: string; title: string }
  | { t: "move"; id: string; spaceID: string | null }
  | { t: "detach"; id: string }
  | { t: "search"; q: string; seq: number }
  | { t: "chat"; id: string }
  | { t: "chat-more"; cursor: string }
  | { t: "chat-send"; text: string; images?: string[] }
  | { t: "chat-stop" }
  | { t: "chat-reply"; requestID: string; decision: "once" | "always" | "reject" }
  | { t: "chat-answer"; formID: string; answer: FormAnswer | null }

const COOKIE = "ctrl_remote"
/** Photos per message, and the size of each once base64'd (the phone shrinks them well below this). */
const MAX_IMAGES = 6
const MAX_IMAGE_CHARS = 12_000_000
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/

/** The images a phone attached to a message: data: URLs of formats models read, size-capped. */
function cleanImages(images: unknown): string[] {
  if (!Array.isArray(images)) return []
  return images
    .filter((i): i is string => typeof i === "string" && i.length <= MAX_IMAGE_CHARS && IMAGE_URL.test(i))
    .slice(0, MAX_IMAGES)
}
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
 * same tailnet lists spaces and sessions and chats in opencode ones (src/main/remote-chat.ts). fx sessions
 * are listed but open on the Mac only.
 *
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
    const image = url.pathname.match(/^\/file\/([\w-]+)\/([\w-]+)\/(\d{1,2})$/)
    if (image) return this.image(res, image[1], image[2], Number(image[3]))
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

  private async image(res: ServerResponse, sessionID: string, messageID: string, index: number) {
    const found = await this.deps.chat.image(sessionID, messageID, index).catch(() => null)
    if (!found) return this.notFound(res)
    // A sent message never changes: the phone keeps it.
    res.writeHead(200, { "Content-Type": found.mime, "Cache-Control": "private, max-age=31536000, immutable" })
    res.end(found.body)
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
    if (msg.t === "leave") return this.leave(viewer)
    if (msg.t === "chat") return this.openChat(viewer, msg.id)
    if (typeof msg.t === "string" && msg.t.startsWith("chat-")) {
      const id = viewer.chat
      if (!id) return
      if (msg.t === "chat-more" && typeof msg.cursor === "string") {
        const page = await this.deps.chat.page(id, msg.cursor)
        if (viewer.chat === id) this.send(viewer, { t: "chat-more", id, ...page })
      } else if (msg.t === "chat-send" && typeof msg.text === "string") {
        const images = cleanImages(msg.images)
        if (!msg.text.trim() && !images.length) return
        await this.deps.chat.send(id, msg.text, images)
        this.sessionEvent(id)
      } else if (msg.t === "chat-stop") {
        await this.deps.chat.stop(id)
      } else if (msg.t === "chat-reply" && ["once", "always", "reject"].includes(msg.decision)) {
        await this.deps.chat.reply(id, String(msg.requestID), msg.decision)
      } else if (msg.t === "chat-answer" && typeof msg.formID === "string") {
        await this.deps.chat.answer(id, msg.formID, cleanAnswer(msg.answer))
      }
      return
    }
    if (msg.t === "new") {
      const parentID = typeof msg.parentID === "string" ? msg.parentID : undefined
      const id = await this.deps.create(typeof msg.spaceID === "string" ? msg.spaceID : null, parentID)
      this.send(viewer, { t: "created", id })
      return
    }
    if (msg.t === "search") {
      if (typeof msg.q !== "string") return
      this.send(viewer, { t: "search", seq: msg.seq, q: msg.q, ...this.deps.search(msg.q.slice(0, 200)) })
      return
    }
    if (msg.t === "rename") {
      if (typeof msg.id === "string" && typeof msg.title === "string" && msg.title.trim())
        await this.deps.rename(msg.id, msg.title.trim().slice(0, 300))
      return
    }
    if (msg.t === "move") {
      if (typeof msg.id === "string") this.deps.move(msg.id, typeof msg.spaceID === "string" ? msg.spaceID : null)
      return
    }
    if (msg.t === "detach") {
      if (typeof msg.id === "string") this.deps.detach(msg.id)
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
  }

  private async openChat(viewer: Viewer, sessionID: string) {
    if (typeof sessionID !== "string") return
    const problem = this.deps.cantOpen(sessionID)
    if (problem) throw new Error(problem)
    if (sessionID.startsWith("fx:")) throw new Error("fx sessions open on your Mac")
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
    viewer.seq++
  }

  // ---------- from main ----------

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

/** Only what a form answer can hold (strings, numbers, booleans, lists of strings); null dismisses. */
function cleanAnswer(raw: unknown): FormAnswer | null {
  if (!raw || typeof raw !== "object") return null
  const out: FormAnswer = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v.slice(0, 10_000)
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v
    else if (typeof v === "boolean") out[k] = v
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string").slice(0, 100)
  }
  return out
}
