import "@xterm/xterm/css/xterm.css"
import "./style.css"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes"
import type { RemoteSnapshot } from "../main/remote"

/**
 * Remote control's web app, served by src/main/remote.ts. Two screens, routed by the URL hash so the
 * phone's back gesture works: the list (#/) and one session's terminal (#/s/<id>).
 */

type Session = RemoteSnapshot["sessions"][number]
type Outbound =
  | { t: "open"; id: string; cols: number; rows: number }
  | { t: "input"; data: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "leave" }
type Inbound =
  | ({ t: "state" } & RemoteSnapshot)
  | { t: "open"; id: string; harness: Session["harness"] }
  | { t: "data"; data: string }
  | { t: "reset" }
  | { t: "error"; message: string }

const PALETTES = {
  opencode: {
    light: { background: "#eff1f5", foreground: "#4c4f69", cursor: "#4c4f69" },
    dark: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#cdd6f4" },
  },
  fx: {
    light: { background: "#ffffff", foreground: "#1f1f1f", cursor: "#1f1f1f" },
    dark: { background: "#1c1c1b", foreground: "#e9e9e7", cursor: "#e9e9e7" },
  },
}

const FONT = { min: 8, max: 20, default: 12 }

let snapshot: RemoteSnapshot = { dark: true, spaces: [], sessions: [] }
let connected = false
let ws: WebSocket | undefined
let retry = 0
let notice = ""

const app = document.getElementById("app")!
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) => {
  const el = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K]
  el.append(...kids)
  return el
}

// ---------- connection ----------

const send = (msg: Outbound) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function connect() {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`)
  ws = socket
  socket.onopen = () => {
    retry = 0
    connected = true
    notice = ""
    render()
    // Back on the session we were looking at.
    const id = routeSession()
    if (id && term) openOnServer(id)
  }
  socket.onmessage = (event) => {
    let msg: Inbound
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return
    }
    receive(msg)
  }
  socket.onclose = () => {
    if (ws !== socket) return
    connected = false
    render()
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++))
  }
}

function receive(msg: Inbound) {
  if (msg.t === "state") {
    const { t: _, ...rest } = msg
    snapshot = rest
    document.documentElement.classList.toggle("dark", snapshot.dark)
    if (term) {
      term.options.theme = palette()
      const host = sessionEl?.querySelector<HTMLElement>(".term")
      if (host) host.style.background = palette().background
    }
    render()
  } else if (msg.t === "open") {
    term?.reset()
  } else if (msg.t === "reset") {
    term?.reset()
  } else if (msg.t === "data") {
    term?.write(msg.data)
  } else if (msg.t === "error") {
    notice = msg.message
    render()
  }
}

// When the phone sleeps the socket can die silently: reconnect as soon as the page is back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws?.readyState !== WebSocket.OPEN) {
    ws?.close()
    connect()
  }
})

// ---------- routing ----------

const routeSession = () => {
  const m = location.hash.match(/^#\/s\/(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

window.addEventListener("hashchange", () => route())

function route() {
  const id = routeSession()
  if (id) showSession(id)
  else showList()
}

// ---------- list ----------

let listEl: HTMLElement | undefined

function showList() {
  if (term) closeTerm()
  send({ t: "leave" })
  render()
}

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function statusEl(s: Session) {
  if (s.status === "running") return h("span", { className: "spinner" })
  if (s.status === "idle") return h("span", { className: "time" }, ago(s.updated))
  return h("span", { className: `dot ${s.status}` })
}

function row(s: Session) {
  const a = h(
    "a",
    { className: "row", href: `#/s/${encodeURIComponent(s.id)}` },
    h("span", { className: "title" }, s.title || "Untitled"),
    ...(s.harness === "fx" ? [h("span", { className: "tag" }, "fx")] : []),
    statusEl(s),
  )
  if (s.statusDetail) a.title = s.statusDetail
  return a
}

function renderList() {
  const groups: [string, Session[]][] = snapshot.spaces.map((sp) => [sp.name, snapshot.sessions.filter((s) => s.spaceID === sp.id)])
  groups.push(["Recents", snapshot.sessions.filter((s) => !s.spaceID)])
  const sections = groups
    .filter(([, list]) => list.length)
    .map(([name, list]) => h("section", {}, h("h2", {}, name), ...list.map(row)))
  return h(
    "div",
    { className: "list" },
    h("header", {}, h("span", { className: "brand" }, "ctrl"), h("span", { className: `conn ${connected ? "on" : ""}` })),
    ...(notice ? [h("div", { className: "notice" }, notice)] : []),
    ...(sections.length ? sections : [h("p", { className: "empty" }, connected ? "No sessions" : "Connecting…")]),
  )
}

// ---------- session ----------

let term: Terminal | undefined
let fit: FitAddon | undefined
let sessionEl: HTMLElement | undefined
let resizeObs: ResizeObserver | undefined
let harness: Session["harness"] = "opencode"

const fontSize = () => Number(localStorage.getItem("fontSize")) || FONT.default
const palette = () => PALETTES[harness][snapshot.dark ? "dark" : "light"]

function openOnServer(id: string) {
  if (!term) return
  send({ t: "open", id, cols: term.cols, rows: term.rows })
}

function showSession(id: string) {
  const session = snapshot.sessions.find((s) => s.id === id)
  harness = session?.harness ?? (id.startsWith("fx:") ? "fx" : "opencode")
  if (term) closeTerm()
  notice = ""
  render()
  const host = sessionEl!.querySelector<HTMLElement>(".term")!
  host.style.background = palette().background
  term = new Terminal({
    fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
    fontSize: fontSize(),
    lineHeight: 1.1,
    allowProposedApi: true,
    cursorBlink: false,
    scrollback: harness === "fx" ? 5000 : 0,
    theme: palette(),
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new UnicodeGraphemesAddon())
  term.open(host)
  fit.fit()
  term.onData((data) => send({ t: "input", data }))
  term.onResize(({ cols, rows }) => send({ t: "resize", cols, rows }))
  resizeObs = new ResizeObserver(() => fit?.fit())
  resizeObs.observe(host)
  touchScroll(host, term)
  openOnServer(id)
}

function closeTerm() {
  resizeObs?.disconnect()
  term?.dispose()
  term = undefined
  fit = undefined
}

/**
 * Touch: a tap focuses the terminal (soft keyboard up). Full-screen TUIs track the mouse, so xterm doesn't
 * scroll them on touch: vertical swipes become wheel events (SGR mouse) the TUI understands. Inline output
 * (fx) keeps xterm's own scrollback.
 */
function touchScroll(host: HTMLElement, t: Terminal) {
  let lastY: number | null = null
  let startY = 0
  let acc = 0
  let moved = false
  host.addEventListener(
    "touchstart",
    (e) => {
      lastY = startY = e.touches[0].clientY
      acc = 0
      moved = false
    },
    { passive: true },
  )
  host.addEventListener(
    "touchmove",
    (e) => {
      if (lastY === null) return
      const y = e.touches[0].clientY
      if (Math.abs(y - startY) > 8) moved = true
      if (t.modes.mouseTrackingMode === "none") return
      e.preventDefault()
      e.stopPropagation()
      acc += y - lastY
      lastY = y
      const step = 18
      const col = Math.floor(t.cols / 2)
      const line = Math.floor(t.rows / 2)
      while (Math.abs(acc) >= step) {
        const up = acc > 0
        send({ t: "input", data: `\x1b[<${up ? 64 : 65};${col};${line}M` })
        acc += up ? -step : step
      }
    },
    { passive: false, capture: true },
  )
  // A tap (not a swipe) puts you in the terminal: the soft keyboard comes up and typing goes to the TUI.
  host.addEventListener(
    "touchend",
    () => {
      lastY = null
      if (!moved) t.focus()
    },
    { passive: true },
  )
}

function setFont(delta: number) {
  const size = Math.min(FONT.max, Math.max(FONT.min, fontSize() + delta))
  localStorage.setItem("fontSize", String(size))
  if (term) {
    term.options.fontSize = size
    fit?.fit()
  }
}

function renderSession(id: string) {
  const session = snapshot.sessions.find((s) => s.id === id)
  const title = h("span", { className: "title" }, session?.title || "Session")
  const back = h("a", { className: "back", href: "#/" }, "‹")
  const minus = h("button", { className: "icon", onclick: () => setFont(-1) }, "A−")
  const plus = h("button", { className: "icon", onclick: () => setFont(1) }, "A+")
  return h(
    "div",
    { className: "session" },
    h("header", {}, back, title, h("span", { className: `conn ${connected ? "on" : ""}` }), minus, plus),
    ...(notice ? [h("div", { className: "notice" }, notice)] : []),
    h("div", { className: "term" }),
  )
}

// ---------- render ----------

/**
 * The list re-renders from scratch (it's small). The session screen is built once per session so the
 * terminal and the half-typed message survive state pushes; only its header updates.
 */
function render() {
  const id = routeSession()
  if (!id) {
    sessionEl?.remove()
    sessionEl = undefined
    const next = renderList()
    if (listEl) listEl.replaceWith(next)
    else app.append(next)
    listEl = next
    return
  }
  listEl?.remove()
  listEl = undefined
  if (!sessionEl || sessionEl.dataset.id !== id) {
    sessionEl?.remove()
    sessionEl = renderSession(id)
    sessionEl.dataset.id = id
    app.append(sessionEl)
    return
  }
  const session = snapshot.sessions.find((s) => s.id === id)
  sessionEl.querySelector(".title")!.textContent = session?.title || "Session"
  sessionEl.querySelector(".conn")!.className = `conn ${connected ? "on" : ""}`
  const old = sessionEl.querySelector(".notice")
  if (notice && !old) sessionEl.querySelector("header")!.after(h("div", { className: "notice" }, notice))
  else if (old && !notice) old.remove()
  else if (old) old.textContent = notice
}

// The soft keyboard shrinks the visual viewport but not the layout one on iOS: size the app to what's visible.
const fitViewport = () => {
  const vv = window.visualViewport
  if (!vv) return
  document.documentElement.style.setProperty("--vh", `${vv.height}px`)
  window.scrollTo(0, 0)
}
window.visualViewport?.addEventListener("resize", fitViewport)
fitViewport()

setInterval(() => {
  if (!routeSession()) render()
}, 30_000)

// The token is in a cookie now: keep it out of the address bar, history and screenshots.
if (location.search) history.replaceState(null, "", `/${location.hash}`)

connect()
route()
