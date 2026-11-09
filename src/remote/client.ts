import "@xterm/xterm/css/xterm.css"
import "./style.css"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes"
import MarkdownIt from "markdown-it"
import type { ChatPending, RemoteBoardCard, RemoteSearchHit, RemoteSnapshot } from "../main/remote"
import type { ChatItem } from "../main/remote-chat"

/**
 * Remote control's web app, served by src/main/remote.ts. Screens are routed by the URL hash so the
 * phone's back gesture works: the session list (#/), the Board (#/board), an opencode session as a chat
 * (#/s/<id>) and any session's terminal (#/t/<id>; fx sessions only have that one).
 */

type Session = RemoteSnapshot["sessions"][number]
type Outbound =
  | { t: "open"; id: string; cols: number; rows: number }
  | { t: "input"; data: string }
  | { t: "resize"; cols: number; rows: number }
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
  | { t: "chat-send"; text: string }
  | { t: "chat-stop" }
  | { t: "chat-reply"; requestID: string; decision: "once" | "always" | "reject" }
type Inbound =
  | ({ t: "state" } & RemoteSnapshot)
  | { t: "open"; id: string; harness: Session["harness"] }
  | { t: "data"; data: string }
  | { t: "reset" }
  | { t: "error"; message: string }
  | { t: "board"; cards: RemoteBoardCard[] }
  | { t: "created"; id: string }
  | { t: "search"; seq: number; q: string; hits: RemoteSearchHit[]; status: { indexing: boolean } }
  | { t: "chat"; id: string; title?: string; items: ChatItem[]; cursor: string | null; pending: ChatPending[] }
  | { t: "chat-more"; id: string; items: ChatItem[]; cursor: string | null }
  | { t: "chat-update"; id: string; items: ChatItem[] }
  | { t: "chat-pending"; id: string; pending: ChatPending[] }

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
/** Section whose new session is being created ("" = Recents), to show it's working */
let creating: string | null = null
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
    const chatID = routeChat()
    if (chatID) send({ t: "chat", id: chatID })
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
  } else if (msg.t.startsWith("chat")) {
    chatReceive(msg as ChatInbound)
  } else if (msg.t === "search") {
    searchReceive(msg)
  } else if (msg.t === "created") {
    creating = null
    location.hash = sessionHref(msg.id)
  } else if (msg.t === "error") {
    creating = null
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

/** Terminal screen's session */
const routeSession = () => {
  const m = location.hash.match(/^#\/t\/(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

/** Chat screen's session */
const routeChat = () => {
  const m = location.hash.match(/^#\/s\/(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

const isFx = (id: string) => id.startsWith("fx:")
/** Where tapping a session goes: the chat for opencode, the terminal for fx (no chat for it yet). */
const sessionHref = (id: string) => `#/${isFx(id) ? "t" : "s"}/${encodeURIComponent(id)}`

const onBoard = () => location.hash === "#/board"

window.addEventListener("hashchange", () => route())

function route() {
  const chatID = routeChat()
  if (chatID && isFx(chatID)) {
    location.replace(`#/t/${encodeURIComponent(chatID)}`)
    return
  }
  const id = routeSession()
  send({ t: "board", on: onBoard() })
  if (chatID) showChat(chatID)
  else if (id) showSession(id)
  else showList()
}

// ---------- list ----------

let listEl: HTMLElement | undefined

function showList() {
  if (term) closeTerm()
  chat = undefined
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

const STATUS_RANK: Record<Session["status"], number> = { "needs-input": 4, running: 3, failed: 2, unread: 1, idle: 0 }

/** Most urgent status among sessions, rolled up into a folded space or parent (like the sidebar). */
const topStatus = (list: Session[]) => {
  let top: Session | undefined
  for (const s of list) if (s.status !== "idle" && (!top || STATUS_RANK[s.status] > STATUS_RANK[top.status])) top = s
  return top
}

function statusEl(s: Session, status = s.status) {
  // Archived sessions only flag what's live (running, needs you), like the sidebar.
  const quiet = status === "idle" || (s.archived && (status === "unread" || status === "failed"))
  if (status === "running") return h("span", { className: "spinner" })
  if (quiet) return h("span", { className: "time" }, ago(s.updated))
  return h("span", { className: `dot ${status}` })
}

const ICONS: Record<string, string> = {
  folder: '<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  "folder-open": '<path d="M2.5 12.5v-8a1 1 0 0 1 1-1h3l1.5 1.5h4a1 1 0 0 1 1 1v1"/><path d="M2.5 12.5l1.6-4.3a1 1 0 0 1 .9-.7h8.6a.6.6 0 0 1 .6.8l-1.4 3.6a1 1 0 0 1-.9.6z"/>',
  "chevron-right": '<path d="M6 4l4 4-4 4"/>',
  "chevron-down": '<path d="M4 6l4 4 4-4"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  dots: '<circle cx="3.5" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="12.5" cy="8" r=".6" fill="currentColor"/>',
  compose: '<path d="M7.5 3.5h-3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-3"/><path d="M11.3 2.9a1.3 1.3 0 0 1 1.8 1.8L8.5 9.3l-2.3.5.5-2.3z"/>',
}

const icon = (name: string) => {
  const el = h("span", { className: "ico" })
  el.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
  return el
}

// ---------- folding (saved on the phone) ----------

/** Spaces, Recents and Archived start folded (open the one you want). Keys: space:<id>, recents, archived, s:<id> (children). */
const FOLD_DEFAULTS: Record<string, boolean> = { recents: true, archived: true }
const foldDefault = (key: string) => FOLD_DEFAULTS[key] ?? key.startsWith("space:")
const folds: Record<string, boolean> = (() => {
  try {
    return JSON.parse(localStorage.getItem("folds") ?? "{}")
  } catch {
    return {}
  }
})()
const isFolded = (key: string) => folds[key] ?? foldDefault(key)
const toggleFold = (key: string) => {
  folds[key] = !isFolded(key)
  localStorage.setItem("folds", JSON.stringify(folds))
  render()
}

const PAGE_SIZE = 10
/** Rows shown in Recents / Archived (Show more adds a page) */
const shown: Record<string, number> = {}

// ---------- swipe to archive ----------

/** Row swiped open to show its Archive button */
let swiped: string | null = null
/** A swipe in progress holds back list re-renders (state pushes), which would drop the row under your finger */
let swiping = false
let renderHeld = false
const ACTION_W = 88

function closeSwiped(except?: HTMLElement) {
  swiped = null
  for (const el of document.querySelectorAll<HTMLElement>(".swipe .row")) {
    if (el === except) continue
    el.style.transition = "transform 0.18s ease-out"
    el.style.transform = ""
    setTimeout(() => el.parentElement?.classList.remove("revealed"), 180)
  }
}

function swipeable(s: Session, link: HTMLElement) {
  const archived = !!s.archived
  const action = h(
    "button",
    {
      className: `swipe-action${archived ? " unarchive" : ""}`,
      onclick: () => {
        swiped = null
        // Shown right away; the next state push confirms it (children come along on the Mac).
        const target = snapshot.sessions.find((x) => x.id === s.id)
        if (target) target.archived = archived ? undefined : Date.now()
        send({ t: "archive", id: s.id, on: !archived })
        render()
      },
    },
    archived ? "Unarchive" : "Archive",
  )
  const wrap = h("div", { className: "swipe" }, action, link)
  const set = (x: number, animate: boolean) => {
    link.style.transition = animate ? "transform 0.18s ease-out" : "none"
    link.style.transform = x ? `translateX(${x}px)` : ""
    // Hidden at rest: its color would bleed through the row's rounded corners.
    wrap.classList.toggle("revealed", x !== 0)
  }
  if (swiped === s.id) set(-ACTION_W, false)
  let start: { x: number; y: number; base: number } | null = null
  let dragging = false
  link.addEventListener("pointerdown", (e) => {
    start = { x: e.clientX, y: e.clientY, base: swiped === s.id ? -ACTION_W : 0 }
    dragging = false
  })
  link.addEventListener("pointermove", (e) => {
    if (!start) return
    if (sheetEl) return void (start = null)
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!dragging) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (start = null)
      if (Math.abs(dx) < 10) return
      dragging = true
      swiping = true
      link.setPointerCapture(e.pointerId)
      // Only one row open at a time.
      if (swiped && swiped !== s.id) closeSwiped(link)
    }
    set(Math.max(-ACTION_W - 30, Math.min(0, start.base + dx)), false)
  })
  const end = (e: PointerEvent) => {
    if (!start) return
    const open = dragging && start.base + (e.clientX - start.x) < -ACTION_W / 2
    if (dragging) {
      swiped = open ? s.id : swiped === s.id ? null : swiped
      set(open ? -ACTION_W : 0, true)
    }
    start = null
    swiping = false
    if (renderHeld) {
      renderHeld = false
      setTimeout(render, 200)
    }
  }
  link.addEventListener("pointerup", end)
  link.addEventListener("pointercancel", end)
  link.addEventListener("click", (e) => {
    // A swipe (or tapping an open row) isn't an open.
    if (dragging || swiped) {
      e.preventDefault()
      if (!dragging) closeSwiped()
    }
    dragging = false
  })
  return wrap
}

// ---------- long press menu ----------

const LONG_PRESS_MS = 450

/** Hold still on el for a moment (or right-click it) to call fire; the tap that follows is swallowed. */
function longPress(el: HTMLElement, fire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let start = { x: 0, y: 0 }
  let fired = false
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return
    fired = false
    start = { x: e.clientX, y: e.clientY }
    cancel()
    timer = setTimeout(() => {
      timer = undefined
      fired = true
      fire()
    }, LONG_PRESS_MS)
  })
  // Moving means scrolling or swiping, not holding.
  el.addEventListener("pointermove", (e) => {
    if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel()
  })
  el.addEventListener("pointerup", cancel)
  el.addEventListener("pointercancel", cancel)
  el.addEventListener(
    "click",
    (e) => {
      if (!fired) return
      fired = false
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    { capture: true },
  )
  // Right-click in a desktop browser, and Android's own long press (which comes after ours).
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    if (fired || sheetEl) return
    cancel()
    fire()
  })
}

/** The open bottom sheet, outside #app so list re-renders leave it alone */
let sheetEl: HTMLElement | undefined
let sheetOpened = 0

function closeSheet() {
  const el = sheetEl
  sheetEl = undefined
  if (!el) return
  el.classList.remove("open")
  setTimeout(() => el.remove(), 200)
}

function openSheet(title: string, subtitle: string | undefined, content: HTMLElement[]) {
  sheetEl?.remove()
  const el = h(
    "div",
    { className: "sheet" },
    h("div", {
      className: "sheet-backdrop",
      // The finger lifting off the long press lands here: ignore that one.
      onclick: () => Date.now() - sheetOpened > 400 && closeSheet(),
    }),
    h(
      "div",
      { className: "sheet-panel" },
      h("div", { className: "sheet-head" }, h("div", { className: "sheet-title" }, title), ...(subtitle ? [h("div", { className: "sheet-sub" }, subtitle)] : [])),
      h("div", { className: "sheet-body" }, ...content),
      h("button", { className: "sheet-cancel", onclick: closeSheet }, "Cancel"),
    ),
  )
  document.body.append(el)
  sheetEl = el
  sheetOpened = Date.now()
  requestAnimationFrame(() => el.classList.add("open"))
}

function sheetAction(label: string, run: () => void, opts: { danger?: boolean; checked?: boolean; keepOpen?: boolean } = {}) {
  return h(
    "button",
    {
      className: `sheet-action${opts.danger ? " danger" : ""}`,
      onclick: () => {
        if (Date.now() - sheetOpened < 400) return
        if (!opts.keepOpen) closeSheet()
        run()
      },
    },
    h("span", {}, label),
    ...(opts.checked ? [h("span", { className: "check" }, "✓")] : []),
  )
}

const spaceLabel = (id: string | null) => (id ? (snapshot.spaces.find((sp) => sp.id === id)?.name ?? "") : "No space")

/** from: the session screen it's opened on (its own "Open as…" is left out, archiving goes back to the list) */
function sessionMenu(s: Session, from?: "chat" | "term") {
  const fx = isFx(s.id)
  const parent = s.parentID ? snapshot.sessions.find((x) => x.id === s.parentID) : undefined
  const sub = [s.archived ? "Archived" : spaceLabel(s.spaceID), fx ? "fx" : "opencode"].join(" · ")
  openSheet(s.title || "Untitled", sub, [
    ...(fx
      ? from
        ? []
        : [sheetAction("Open", () => (location.hash = sessionHref(s.id)))]
      : [
          ...(from === "chat" ? [] : [sheetAction("Open as chat", () => (location.hash = `#/s/${encodeURIComponent(s.id)}`))]),
          ...(from === "term" ? [] : [sheetAction("Open in terminal", () => (location.hash = `#/t/${encodeURIComponent(s.id)}`))]),
        ]),
    sheetAction("New child session", () => {
      creating = `child:${s.id}`
      notice = ""
      send({ t: "new", spaceID: s.spaceID, parentID: s.id })
      render()
    }),
    sheetAction("Rename…", () => renameSheet(s), { keepOpen: true }),
    sheetAction("Move to…", () => moveSheet(s), { keepOpen: true }),
    ...(parent ? [sheetAction(`Open parent “${parent.title || "Untitled"}”`, () => (location.hash = sessionHref(parent.id)))] : []),
    ...(s.parentID
      ? [
          sheetAction("Detach from parent", () => {
            s.parentID = undefined
            send({ t: "detach", id: s.id })
            render()
          }),
        ]
      : []),
    sheetAction(
      s.archived ? "Unarchive" : "Archive",
      () => {
        s.archived = s.archived ? undefined : Date.now()
        send({ t: "archive", id: s.id, on: !!s.archived })
        // Archived from its own screen: it's done, back to the list (like the desktop leaving it).
        if (from && s.archived) location.hash = "#/"
        else render()
      },
      { danger: !s.archived },
    ),
  ])
}

function renameSheet(s: Session) {
  const input = h("input", { className: "sheet-input", value: s.title, enterKeyHint: "done", autocomplete: "off" }) as HTMLInputElement
  const save = () => {
    const title = input.value.trim()
    closeSheet()
    if (!title || title === s.title) return
    s.title = title
    send({ t: "rename", id: s.id, title })
    render()
  }
  input.addEventListener("keydown", (e) => e.key === "Enter" && save())
  openSheet("Rename session", undefined, [input, h("button", { className: "sheet-save", onclick: save }, "Save")])
  sheetOpened = 0
  input.focus()
  input.select()
}

function moveSheet(s: Session) {
  const move = (spaceID: string | null) => () => {
    s.spaceID = spaceID
    s.archived = undefined
    send({ t: "move", id: s.id, spaceID })
    render()
  }
  openSheet("Move to", s.title || "Untitled", [
    sheetAction("No space", move(null), { checked: !s.spaceID }),
    ...snapshot.spaces.map((sp) => sheetAction(sp.name, move(sp.id), { checked: s.spaceID === sp.id })),
  ])
  sheetOpened = 0
}

function spaceMenu(space: RemoteSnapshot["spaces"][number]) {
  const key = `space:${space.id}`
  const count = snapshot.sessions.filter((s) => s.spaceID === space.id && !s.archived).length
  openSheet(space.name, `${count} session${count === 1 ? "" : "s"}`, [
    sheetAction("New session", () => startNew(space.id)),
    sheetAction(isFolded(key) ? "Unfold" : "Fold", () => toggleFold(key)),
    sheetAction("Open its board", () => {
      localStorage.setItem("boardSpace", space.id)
      location.hash = "#/board"
    }),
  ])
}

/** ⋯ in a session screen's header: the same menu as a long press in the list */
function sessionMenuButton(id: string, from: "chat" | "term") {
  return h(
    "button",
    {
      className: "icon menu-btn",
      title: "More",
      onclick: () => {
        const s = snapshot.sessions.find((x) => x.id === id)
        if (!s) return void ((notice = "This session isn't in the list anymore"), render())
        sessionMenu(s, from)
        sheetOpened = 0
      },
    },
    icon("dots"),
  )
}

// ---------- rows ----------

/** A row in a space's session tree */
type TreeRow = { session: Session; depth: number; children: number; folded: boolean; rollup?: Session }

/**
 * Nests sessions under their parent when the parent is in the same list (src/renderer/Sidebar.tsx's
 * sessionTree). Siblings are ordered by their subtree's latest activity, so an active child lifts its parent.
 */
function sessionTree(list: Session[]): TreeRow[] {
  const ids = new Set(list.map((s) => s.id))
  const kids = new Map<string, Session[]>()
  const roots: Session[] = []
  for (const s of list) {
    const parent = s.parentID
    if (parent && parent !== s.id && ids.has(parent)) kids.set(parent, [...(kids.get(parent) ?? []), s])
    else roots.push(s)
  }
  const latest = new Map<string, number>()
  const descendants = new Map<string, Session[]>()
  const walk = (s: Session, seen: Set<string>): void => {
    seen.add(s.id)
    let max = s.updated
    const all: Session[] = []
    for (const c of kids.get(s.id) ?? []) {
      if (seen.has(c.id)) continue
      walk(c, seen)
      max = Math.max(max, latest.get(c.id)!)
      all.push(c, ...descendants.get(c.id)!)
    }
    latest.set(s.id, max)
    descendants.set(s.id, all)
  }
  const seen = new Set<string>()
  for (const r of roots) walk(r, seen)
  const byLatest = (a: Session, b: Session) => latest.get(b.id)! - latest.get(a.id)!
  const rows: TreeRow[] = []
  const emit = (s: Session, depth: number) => {
    const children = (kids.get(s.id) ?? []).filter((c) => latest.has(c.id)).sort(byLatest)
    const folded = children.length > 0 && isFolded(`s:${s.id}`)
    rows.push({ session: s, depth, children: children.length, folded, rollup: folded ? topStatus(descendants.get(s.id)!) : undefined })
    if (!folded) for (const c of children) emit(c, depth + 1)
  }
  for (const r of roots.sort(byLatest)) emit(r, 0)
  return rows
}

/** px per tree level */
const CHILD_INDENT = 16

function row(s: Session, tree?: TreeRow) {
  const depth = tree?.depth ?? 0
  const status = tree?.rollup && STATUS_RANK[tree.rollup.status] > STATUS_RANK[s.status] ? tree.rollup.status : s.status
  const a = h(
    "a",
    { className: `row item${tree ? " in-space" : ""}`, href: sessionHref(s.id) },
    h("span", { className: "title" }, s.title || "Untitled"),
    ...(s.harness === "fx" ? [h("span", { className: "tag" }, "fx")] : []),
    statusEl(s, status),
  )
  if (tree) a.style.paddingLeft = `${40 + depth * CHILD_INDENT}px`
  if (tree && tree.children > 0) {
    const toggle = h(
      "button",
      {
        className: "tree-toggle",
        title: tree.folded ? `Show ${tree.children} child session${tree.children > 1 ? "s" : ""}` : "Hide child sessions",
        onclick: (e: MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
          toggleFold(`s:${s.id}`)
        },
      },
      icon(tree.folded ? "chevron-right" : "chevron-down"),
    )
    toggle.style.left = `${40 + depth * CHILD_INDENT - 30}px`
    a.prepend(toggle)
  }
  if (s.statusDetail) a.title = s.statusDetail
  longPress(a, () => sessionMenu(s))
  return swipeable(s, a)
}

function homeHeader() {
  const tab = (label: string, href: string, on: boolean) => h("a", { className: `tab${on ? " on" : ""}`, href }, label)
  return h(
    "header",
    {},
    h("span", { className: "brand" }, "ctrl", h("span", { className: `conn ${connected ? "on" : ""}` })),
    h("nav", { className: "tabs" }, tab("Sessions", "#/", !onBoard()), tab("Board", "#/board", onBoard())),
  )
}

const startNew = (spaceID: string | null) => {
  creating = spaceID ?? ""
  notice = ""
  send({ t: "new", spaceID })
  render()
}

/** The space's ⋯: same menu as a long press. Shows a spinner while a session starts there. */
function menuButton(space: RemoteSnapshot["spaces"][number]) {
  return h(
    "button",
    {
      className: "new",
      title: "More",
      onclick: (e: MouseEvent) => {
        e.stopPropagation()
        spaceMenu(space)
        // Opened by a tap, not a held finger: no lift to ignore.
        sheetOpened = 0
      },
    },
    creating === space.id ? h("span", { className: "spinner" }) : icon("dots"),
  )
}

function spaceGroup(space: RemoteSnapshot["spaces"][number], list: Session[]) {
  const key = `space:${space.id}`
  const open = !isFolded(key)
  const rollup = open ? undefined : topStatus(list)
  const header = h(
    "div",
    { className: "row space-header", onclick: () => toggleFold(key) },
    icon(open ? "folder-open" : "folder"),
    h("span", { className: "title" }, space.name),
    ...(rollup ? [h("span", { className: "rollup" }, statusEl(rollup))] : []),
    menuButton(space),
  )
  longPress(header, () => spaceMenu(space))
  const el = h(
    "div",
    { className: "space" },
    header,
    ...(open
      ? list.length
        ? sessionTree(list).map((r) => row(r.session, r))
        : [
            h(
              "div",
              { className: "row hint" },
              h("span", { className: "title" }, "No sessions yet"),
              h(
                "button",
                { className: "hint-new", disabled: creating === space.id, onclick: () => startNew(space.id) },
                creating === space.id ? h("span", { className: "spinner" }) : icon("plus"),
                "New session",
              ),
            ),
          ]
      : []),
  )
  el.dataset.spaceId = space.id
  return el
}

function foldSection(key: string, title: string, list: Session[]) {
  const folded = isFolded(key)
  const n = shown[key] ?? PAGE_SIZE
  return h(
    "section",
    { className: `fold ${key}` },
    h("button", { className: "section-header toggle", onclick: () => toggleFold(key) }, h("span", {}, title), icon(folded ? "chevron-right" : "chevron-down")),
    ...(folded
      ? []
      : [
          ...list.slice(0, n).map((s) => row(s)),
          ...(list.length > n
            ? [
                h(
                  "button",
                  {
                    className: "more",
                    onclick: () => {
                      shown[key] = n + PAGE_SIZE
                      render()
                    },
                  },
                  "Show more",
                ),
              ]
            : []),
          ...(list.length ? [] : [h("div", { className: "row hint" }, "No sessions")]),
        ]),
  )
}

// ---------- search ----------

let query = ""
const SEARCH_LIMIT = 50

/** Built once: the list re-renders around it, so typing keeps focus and the keyboard stays up. */
const searchInput = h("input", {
  type: "search",
  placeholder: "Search sessions",
  enterKeyHint: "search",
  autocomplete: "off",
  spellcheck: false,
}) as HTMLInputElement
const searchClear = h("button", { className: "search-clear", title: "Clear", hidden: true }, "×")
const searchBar = h("div", { className: "search" }, searchInput, searchClear)
searchInput.addEventListener("input", () => {
  query = searchInput.value
  searchClear.hidden = !query
  askSearch()
  render()
})
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchInput.blur()
  if (e.key === "Escape") clearSearch()
})
searchClear.addEventListener("pointerdown", (e) => e.preventDefault())
searchClear.addEventListener("click", () => clearSearch())
const clearSearch = () => {
  searchInput.value = query = ""
  searchClear.hidden = true
  askSearch()
  render()
}

// Message search: the Mac's ⌘K index, asked over the socket (debounced, stale answers dropped).
const SEARCH_DEBOUNCE_MS = 150
const INDEXING_POLL_MS = 1000
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let messageHits: { q: string; hits: RemoteSearchHit[] } = { q: "", hits: [] }

function askSearch() {
  clearTimeout(searchTimer)
  const q = query.trim()
  if (q.length < 2) {
    messageHits = { q: "", hits: [] }
    return
  }
  searchTimer = setTimeout(() => send({ t: "search", q, seq: ++searchSeq }), SEARCH_DEBOUNCE_MS)
}

function searchReceive(msg: Extract<Inbound, { t: "search" }>) {
  if (msg.seq !== searchSeq || msg.q !== query.trim()) return
  messageHits = { q: msg.q, hits: msg.hits }
  // Still indexing (first run, or catching up): ask again until it's done, like the palette.
  if (msg.status.indexing) searchTimer = setTimeout(() => send({ t: "search", q: msg.q, seq: ++searchSeq }), INDEXING_POLL_MS)
  render()
}

const matches = (q: string, ...fields: (string | undefined)[]) => {
  const hay = fields.filter(Boolean).join(" ").toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

const folderName = (dir: string) => dir.replace(/\/+$/, "").split("/").pop() ?? ""

/** Index snippets wrap matches in \uE000…\uE001 */
function snippetEl(text: string, role: string) {
  const el = h("span", { className: "snippet" })
  if (role === "user") el.append(h("span", { className: "snippet-role" }, "You: "))
  text.split("\uE000").forEach((part, i) => {
    if (i === 0) return void el.append(part)
    const [hit, rest = ""] = part.split("\uE001")
    el.append(h("mark", {}, hit), rest)
  })
  return el
}

const resultSection = (title: string, rows: HTMLElement[]) =>
  rows.length ? [h("div", { className: "section-header" }, h("span", {}, title)), ...rows] : []

/** Like the palette (⌘K): chats by title, space or folder, then message hits, then spaces. Archived rank last. */
function searchResults() {
  const q = query.trim()
  const spaceName = new Map(snapshot.spaces.map((sp) => [sp.id, sp.name]))
  const where = (archived: boolean, spaceID: string | null, dir?: string) =>
    archived ? "Archived" : spaceID ? (spaceName.get(spaceID) ?? "") : dir ? folderName(dir) : "No space"

  const chats = snapshot.sessions
    .filter((s) => matches(q, s.title, s.spaceID ? spaceName.get(s.spaceID) : undefined, s.directory))
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.updated - a.updated)
    .slice(0, SEARCH_LIMIT)
  const chatRows = chats.map((s) => {
    const el = row(s)
    el.querySelector(".title")!.append(h("span", { className: "where" }, where(!!s.archived, s.spaceID, s.directory)))
    return el
  })

  const shown = new Set(chats.map((s) => s.id))
  const known = new Map(snapshot.sessions.map((s) => [s.id, s]))
  const hits = messageHits.q === q ? messageHits.hits.filter((x) => !shown.has(x.sessionID)) : []
  hits.sort((a, b) => Number(a.archived) - Number(b.archived))
  const hitRows = hits.map((x) => {
    const s = known.get(x.sessionID)
    const status = s?.status ?? x.status
    return h(
      "a",
      { className: "row hit", href: sessionHref(x.sessionID) },
      h(
        "span",
        { className: "title" },
        x.title || "Untitled",
        snippetEl(x.snippet, x.role),
        h("span", { className: "where" }, where(x.archived, x.spaceID, s?.directory)),
      ),
      ...(status && status !== "idle" ? [s ? statusEl(s, status) : h("span", { className: status === "running" ? "spinner" : `dot ${status}` })] : []),
    )
  })

  const spaceRows = snapshot.spaces
    .filter((sp) => matches(q, sp.name))
    .map((sp) => {
      const count = snapshot.sessions.filter((s) => s.spaceID === sp.id && !s.archived).length
      return h(
        "button",
        {
          className: "row space-result",
          onclick: () => {
            // Clear the search and land on the space, unfolded.
            folds[`space:${sp.id}`] = false
            localStorage.setItem("folds", JSON.stringify(folds))
            clearSearch()
            searchInput.blur()
            document.querySelector(`[data-space-id="${sp.id}"]`)?.scrollIntoView({ block: "start" })
          },
        },
        icon("folder"),
        h("span", { className: "title" }, sp.name),
        h("span", { className: "time" }, `${count} session${count === 1 ? "" : "s"}`),
      )
    })

  return [...resultSection("Chats", chatRows), ...resultSection("Messages", hitRows), ...resultSection("Spaces", spaceRows)]
}

function listBody() {
  if (!connected && !snapshot.sessions.length) return h("div", { className: "list-body" }, h("p", { className: "empty" }, "Connecting…"))
  if (query.trim()) {
    const results = searchResults()
    return h(
      "div",
      { className: "list-body results" },
      ...(results.length ? results : [h("p", { className: "empty" }, "No matching sessions")]),
    )
  }
  const live = snapshot.sessions.filter((s) => !s.archived)
  // Recents is a view over every live session, spaces are a grouping on top (like the sidebar).
  const recents = [...live].sort((a, b) => b.updated - a.updated)
  const archived = snapshot.sessions.filter((s) => s.archived).sort((a, b) => b.archived! - a.archived!)
  const newChat = h(
    "button",
    { className: "row action", disabled: creating !== null, onclick: () => startNew(null) },
    creating === "" ? h("span", { className: "spinner" }) : icon("compose"),
    h("span", { className: "title" }, "New chat"),
  )
  return h(
    "div",
    { className: "list-body" },
    newChat,
    h(
      "section",
      { className: "spaces" },
      h("div", { className: "section-header" }, h("span", {}, "Spaces")),
      ...snapshot.spaces.map((sp) => spaceGroup(sp, live.filter((s) => s.spaceID === sp.id))),
      ...(snapshot.spaces.length ? [] : [h("div", { className: "row hint" }, "No spaces yet, create one in ctrl")]),
    ),
    foldSection("recents", "Recents", recents),
    ...(archived.length ? [foldSection("archived", "Archived", archived)] : []),
  )
}

function renderList() {
  return h("div", { className: "list" }, homeHeader(), searchBar, ...(notice ? [h("div", { className: "notice" }, notice)] : []), listBody())
}

/** Sessions screen already up: swap everything but the search bar. */
function updateList(el: HTMLElement) {
  for (const child of [...el.children]) if (child !== searchBar) child.remove()
  el.prepend(homeHeader())
  el.append(...(notice ? [h("div", { className: "notice" }, notice)] : []), listBody())
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
            ...c.sessions.map((x) => h("a", { className: "card-session", href: sessionHref(x.id) }, "▸ " + (x.title || "Session"))),
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
  chat = undefined
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
  const toChat = isFx(id) ? [] : [h("a", { className: "icon", href: `#/s/${encodeURIComponent(id)}` }, "Chat")]
  return h(
    "div",
    { className: "session" },
    h("header", {}, back, title, h("span", { className: `conn ${connected ? "on" : ""}` }), minus, plus, ...toChat, sessionMenuButton(id, "term")),
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

// ---------- chat ----------

type ChatInbound = Extract<Inbound, { t: "chat" | "chat-more" | "chat-update" | "chat-pending" }>

/** The chat on screen: messages by id (live updates replace them in place), oldest first. */
let chat:
  | {
      id: string
      title?: string
      items: Map<string, ChatItem>
      cursor: string | null
      pending: ChatPending[]
      loaded: boolean
      loadingMore: boolean
    }
  | undefined

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })
// Links leave the app (and never replace it) when tapped.
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank")
  tokens[idx].attrSet("rel", "noreferrer")
  return defaultLink(tokens, idx, options, env, self)
}

const TOOL_ICONS: Record<string, string> = { running: "◌", done: "✓", error: "✕" }

function showChat(id: string) {
  if (term) closeTerm()
  if (chat?.id !== id) chat = { id, items: new Map(), cursor: null, pending: [], loaded: false, loadingMore: false }
  notice = ""
  render()
  send({ t: "chat", id })
}

function chatReceive(msg: ChatInbound) {
  if (!chat || msg.id !== chat.id) return
  const list = sessionEl?.querySelector<HTMLElement>(".chat-list")
  const nearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 120
  if (msg.t === "chat") {
    chat.items = new Map(msg.items.map((i) => [i.id, i]))
    chat.cursor = msg.cursor
    chat.pending = msg.pending
    chat.title = msg.title
    chat.loaded = true
    drawMessages()
    scrollToBottom()
  } else if (msg.t === "chat-update") {
    for (const i of msg.items) chat.items.set(i.id, i)
    drawMessages()
    if (nearBottom) scrollToBottom()
  } else if (msg.t === "chat-more") {
    const before = list ? list.scrollHeight - list.scrollTop : 0
    chat.items = new Map([...msg.items.map((i) => [i.id, i] as const), ...chat.items])
    chat.cursor = msg.cursor
    chat.loadingMore = false
    drawMessages()
    // Keep what you were reading in place while older messages land above it.
    if (list) list.scrollTop = list.scrollHeight - before
  } else if (msg.t === "chat-pending") {
    chat.pending = msg.pending
  }
  updateChatChrome()
}

function scrollToBottom() {
  const list = sessionEl?.querySelector<HTMLElement>(".chat-list")
  if (list) list.scrollTop = list.scrollHeight
}

function itemEl(i: ChatItem) {
  if (i.kind === "user") return h("div", { className: "msg user" }, h("div", { className: "bubble" }, i.text))
  const parts = i.parts.map((p) => {
    if (p.type === "text") {
      const el = h("div", { className: "md" })
      el.innerHTML = md.render(p.text)
      return el
    }
    if (p.type === "reasoning") return h("div", { className: "thinking" }, "Thought")
    return h(
      "div",
      { className: `tool ${p.status}` },
      h("span", { className: "tool-icon" }, TOOL_ICONS[p.status]),
      h("span", { className: "tool-name" }, p.name),
      h("span", { className: "tool-summary" }, p.summary),
    )
  })
  return h(
    "div",
    { className: "msg assistant" },
    ...parts,
    ...(i.error ? [h("div", { className: "msg-error" }, i.error)] : []),
    ...(i.live && !i.parts.length ? [h("div", { className: "typing" }, h("span"), h("span"), h("span"))] : []),
  )
}

/** Redraws only messages that changed (streaming updates one at a time), so long chats stay cheap. */
function drawMessages() {
  const list = sessionEl?.querySelector<HTMLElement>(".chat-list")
  if (!list || !chat) return
  const items = [...chat.items.values()].sort((a, b) => a.time - b.time)
  const existing = new Map([...list.querySelectorAll<HTMLElement>("[data-key]")].map((el) => [el.dataset.key!, el]))
  const top = list.querySelector(".chat-top")
  let prev: Element | null = top
  for (const i of items) {
    const json = JSON.stringify(i)
    let el = existing.get(i.id)
    existing.delete(i.id)
    if (!el || el.dataset.json !== json) {
      const next = itemEl(i)
      next.dataset.key = i.id
      next.dataset.json = json
      if (el) el.replaceWith(next)
      el = next
    }
    if (prev ? prev.nextElementSibling !== el : list.firstElementChild !== el) {
      if (prev) prev.after(el)
      else list.prepend(el)
    }
    prev = el
  }
  for (const el of existing.values()) el.remove()
}

/** Top of the list (load earlier), pending asks and the stop button follow the latest state. */
function updateChatChrome() {
  if (!chat || !sessionEl) return
  const id = chat.id
  const top = sessionEl.querySelector<HTMLElement>(".chat-top")!
  top.replaceChildren(
    !chat.loaded
      ? h("p", { className: "empty" }, connected ? "Loading…" : "Connecting…")
      : chat.cursor
        ? h(
            "button",
            {
              className: "more",
              disabled: chat.loadingMore,
              onclick: () => {
                if (!chat?.cursor) return
                chat.loadingMore = true
                send({ t: "chat-more", cursor: chat.cursor })
                updateChatChrome()
              },
            },
            chat.loadingMore ? "Loading…" : "Load earlier messages",
          )
        : h("span"),
  )
  const asks = sessionEl.querySelector<HTMLElement>(".chat-asks")!
  asks.replaceChildren(
    ...chat.pending.map((p) => {
      const reply = (decision: "once" | "always" | "reject", label: string, cls = "") =>
        h("button", { className: `ask-btn ${cls}`, onclick: () => send({ t: "chat-reply", requestID: p.id, decision }) }, label)
      return h(
        "div",
        { className: "ask" },
        h("div", { className: "ask-detail" }, p.detail),
        p.kind === "permission"
          ? h("div", { className: "ask-actions" }, reply("once", "Allow", "primary"), reply("always", "Always"), reply("reject", "Deny"))
          : h("div", { className: "ask-actions" }, h("a", { className: "ask-btn primary", href: `#/t/${encodeURIComponent(id)}` }, "Answer in terminal")),
      )
    }),
  )
  const session = snapshot.sessions.find((s) => s.id === id)
  sessionEl.querySelector(".title")!.textContent = session?.title || chat.title || "Session"
  const running = session?.status === "running"
  sessionEl.querySelector<HTMLElement>(".stop")!.hidden = !running
}

function renderChat(id: string) {
  const session = snapshot.sessions.find((s) => s.id === id)
  const input = h("textarea", { rows: 1, placeholder: "Message", enterKeyHint: "enter" }) as HTMLTextAreaElement
  const grow = () => {
    input.style.height = ""
    input.style.height = `${Math.min(160, input.scrollHeight)}px`
  }
  // Return types a new line (the phone's keyboard); the button sends.
  input.addEventListener("input", grow)
  const submit = () => {
    const text = input.value
    if (!text.trim()) return
    send({ t: "chat-send", text })
    input.value = ""
    grow()
  }
  const keepFocus = (e: PointerEvent) => e.preventDefault()
  const el = h(
    "div",
    { className: "session chat" },
    h(
      "header",
      {},
      h("a", { className: "back", href: "#/" }, "‹"),
      h("span", { className: "title" }, session?.title || "Session"),
      h("span", { className: `conn ${connected ? "on" : ""}` }),
      h("a", { className: "icon", href: `#/t/${encodeURIComponent(id)}` }, "Terminal"),
      sessionMenuButton(id, "chat"),
    ),
    ...(notice ? [h("div", { className: "notice" }, notice)] : []),
    h("div", { className: "chat-list" }, h("div", { className: "chat-top" })),
    h("div", { className: "chat-asks" }),
    h(
      "div",
      { className: "composer" },
      input,
      h("button", { className: "stop", title: "Stop", hidden: true, onpointerdown: keepFocus, onclick: () => send({ t: "chat-stop" }) }, "■"),
      h("button", { className: "send-btn", title: "Send", onpointerdown: keepFocus, onclick: submit }, "↑"),
    ),
  )
  sessionEl = el
  drawMessages()
  updateChatChrome()
  if (chat?.loaded) requestAnimationFrame(scrollToBottom)
  return el
}

// ---------- render ----------

/**
 * The list re-renders from scratch (it's small). The session screen is built once per session so the
 * terminal and the half-typed message survive state pushes; only its header updates.
 */
function render() {
  const chatID = routeChat()
  const id = routeSession() ?? chatID
  const screen = chatID ? `chat:${chatID}` : `term:${id}`
  if (!id) {
    if (swiping) return void (renderHeld = true)
    sessionEl?.remove()
    sessionEl = undefined
    if (!onBoard() && listEl?.dataset.screen === location.hash) return void updateList(listEl)
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
  if (!sessionEl || sessionEl.dataset.id !== screen) {
    sessionEl?.remove()
    sessionEl = chatID ? renderChat(chatID) : renderSession(id)
    sessionEl.dataset.id = screen
    app.append(sessionEl)
    return
  }
  if (chatID) updateChatChrome()
  const session = snapshot.sessions.find((s) => s.id === id)
  sessionEl.querySelector(".title")!.textContent = session?.title || (chatID && chat?.title) || "Session"
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
  if (!routeSession() && !routeChat()) render()
}, 30_000)

// The token is in a cookie now: keep it out of the address bar, history and screenshots.
if (location.search) history.replaceState(null, "", `/${location.hash}`)

connect()
route()
