import "@xterm/xterm/css/xterm.css"
import "./style.css"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes"
import type { RemoteBoardCard, RemoteSnapshot } from "../main/remote"

/**
 * Remote control's web app, served by src/main/remote.ts. Screens are routed by the URL hash so the
 * phone's back gesture works: the session list (#/), the Board (#/board) and one session's terminal (#/s/<id>).
 */

type Session = RemoteSnapshot["sessions"][number]
type Outbound =
  | { t: "open"; id: string; cols: number; rows: number }
  | { t: "input"; data: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "leave" }
  | { t: "board"; on: boolean }
type Inbound =
  | ({ t: "state" } & RemoteSnapshot)
  | { t: "open"; id: string; harness: Session["harness"] }
  | { t: "data"; data: string }
  | { t: "reset" }
  | { t: "error"; message: string }
  | { t: "board"; cards: RemoteBoardCard[] }

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
/** CSI-u shift+enter, the same sequence the desktop sends for ⇧⏎ */
const NEWLINE = "\x1b[13;2u"

let snapshot: RemoteSnapshot = { dark: true, spaces: [], sessions: [] }
let board: RemoteBoardCard[] | null = null
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
    if (onBoard()) send({ t: "board", on: true })
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
  } else if (msg.t === "board") {
    board = msg.cards
    if (onBoard()) render()
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

const onBoard = () => location.hash === "#/board"

window.addEventListener("hashchange", () => route())

function route() {
  const id = routeSession()
  send({ t: "board", on: onBoard() })
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

function homeHeader() {
  const tab = (label: string, href: string, on: boolean) => h("a", { className: `tab${on ? " on" : ""}`, href }, label)
  return h(
    "header",
    {},
    h("span", { className: "brand" }, "ctrl"),
    h("nav", { className: "tabs" }, tab("Sessions", "#/", !onBoard()), tab("Board", "#/board", onBoard())),
    h("span", { className: `conn ${connected ? "on" : ""}` }),
  )
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
    homeHeader(),
    ...(notice ? [h("div", { className: "notice" }, notice)] : []),
    ...(sections.length ? sections : [h("p", { className: "empty" }, connected ? "No sessions" : "Connecting…")]),
  )
}

// ---------- board ----------

const COLUMNS: { id: RemoteBoardCard["stage"]; label: string }[] = [
  { id: "you", label: "Needs you" },
  { id: "waiting", label: "Waiting on others" },
  { id: "moving", label: "In progress" },
  { id: "done", label: "Done" },
]
const DONE_PAGE = 10
let doneShown = DONE_PAGE
/** One space at a time (or all), saved on the phone. "none": sessions outside spaces. */
const boardSpace = () => localStorage.getItem("boardSpace") ?? ""

function boardCard(c: RemoteBoardCard, showSpaces: boolean) {
  const spaces = c.spaces.map((s) => s.name).filter(Boolean)
  return h(
    "div",
    { className: `card stage-${c.stage}` },
    h(
      "a",
      { className: "card-main", href: c.url, target: "_blank", rel: "noreferrer" },
      h(
        "div",
        { className: "card-top" },
        h("span", { className: `tone ${c.tone ?? "muted"}` }),
        h("span", { className: "card-title" }, c.title),
        h("span", { className: "time" }, ago(c.last)),
      ),
      h(
        "div",
        { className: "card-reason" },
        h("span", {}, c.reason),
        h("span", { className: "card-source" }, [c.source, ...(showSpaces && spaces.length ? [spaces[0] + (spaces.length > 1 ? ` +${spaces.length - 1}` : "")] : [])].join(" · ")),
      ),
      ...(c.subtitle || c.chips.length
        ? [
            h(
              "div",
              { className: "card-sub" },
              ...(c.subtitle ? [h("span", { className: "card-subtitle" }, c.subtitle)] : []),
              ...c.chips.map((chip) => h("span", { className: `chip ${chip.tone}` }, chip.text)),
            ),
          ]
        : []),
    ),
    ...(c.sessions.length
      ? [
          h(
            "div",
            { className: "card-sessions" },
            ...c.sessions.map((x) => h("a", { className: "card-session", href: `#/s/${encodeURIComponent(x.id)}` }, "▸ " + (x.title || "Session"))),
          ),
        ]
      : []),
  )
}

function renderBoard() {
  const space = boardSpace()
  const cards = (board ?? []).filter((c) => !space || c.spaces.some((s) => (s.id ?? "none") === space))
  const spaceChip = (id: string, name: string) =>
    h(
      "button",
      {
        className: `filter${space === id ? " on" : ""}`,
        onclick: () => {
          localStorage.setItem("boardSpace", id)
          doneShown = DONE_PAGE
          render()
        },
      },
      name,
    )
  const hasNoSpace = (board ?? []).some((c) => c.spaces.some((s) => s.id === null))
  const filters = h(
    "div",
    { className: "filters" },
    spaceChip("", "All spaces"),
    ...snapshot.spaces.map((sp) => spaceChip(sp.id, sp.name)),
    ...(hasNoSpace ? [spaceChip("none", "No space")] : []),
  )
  const sections = COLUMNS.map((col) => {
    const all = cards.filter((c) => c.stage === col.id)
    const list = col.id === "done" ? all.slice(0, doneShown) : all
    return h(
      "section",
      { className: `board-col stage-${col.id}` },
      h("h2", {}, col.label, h("span", { className: "count" }, String(all.length))),
      ...(all.length ? list.map((c) => boardCard(c, !space)) : [h("p", { className: "col-empty" }, "Nothing here")]),
      ...(all.length > list.length
        ? [
            h(
              "button",
              {
                className: "more",
                onclick: () => {
                  doneShown += DONE_PAGE
                  render()
                },
              },
              "Show more",
            ),
          ]
        : []),
    )
  })
  return h(
    "div",
    { className: "list board" },
    homeHeader(),
    ...(notice ? [h("div", { className: "notice" }, notice)] : []),
    filters,
    ...(board ? sections : [h("p", { className: "empty" }, connected ? "Loading…" : "Connecting…")]),
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
  // Return types a new line (shift+enter, what both TUIs read as "newline"); the send button submits.
  term.onData((data) => send({ t: "input", data: data === "\r" ? NEWLINE : data }))
  // The send button only shows while the keyboard is up (the terminal has focus).
  const screen = sessionEl!
  term.textarea?.addEventListener("focus", () => screen.classList.add("typing"))
  term.textarea?.addEventListener("blur", () => screen.classList.remove("typing"))
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
    h(
      "button",
      {
        className: "send",
        title: "Send",
        // Keep focus in the terminal, so the keyboard stays up.
        onpointerdown: (e: PointerEvent) => e.preventDefault(),
        onclick: () => send({ t: "input", data: "\r" }),
      },
      "↑",
    ),
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
    const next = onBoard() ? renderBoard() : renderList()
    next.dataset.screen = location.hash
    if (listEl) listEl.replaceWith(next)
    else app.append(next)
    // Same screen re-rendered (a push came in): stay where you scrolled to.
    if (listEl?.dataset.screen === next.dataset.screen) next.scrollTop = listEl.scrollTop
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
