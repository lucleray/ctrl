import "./style.css"
import MarkdownIt from "markdown-it"
import type { ChatPending, FormAnswer, FormField, RemoteBoardCard, RemoteSearchHit, RemoteSnapshot } from "../main/remote"
import type { ChatItem } from "../main/remote-chat"

/**
 * Remote control's web app, served by src/main/remote.ts. Screens are routed by the URL hash so the
 * phone's back gesture works: the session list (#/), the Board (#/board) and an opencode session as a chat
 * (#/s/<id>). fx sessions are listed but open on the Mac only.
 */

type Session = RemoteSnapshot["sessions"][number]
type Outbound =
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
type Inbound =
  | ({ t: "state" } & RemoteSnapshot)
  | { t: "error"; message: string }
  | { t: "board"; cards: RemoteBoardCard[] }
  | { t: "created"; id: string }
  | { t: "search"; seq: number; q: string; hits: RemoteSearchHit[]; status: { indexing: boolean } }
  | { t: "chat"; id: string; title?: string; items: ChatItem[]; cursor: string | null; pending: ChatPending[] }
  | { t: "chat-more"; id: string; items: ChatItem[]; cursor: string | null }
  | { t: "chat-update"; id: string; items: ChatItem[] }
  | { t: "chat-pending"; id: string; pending: ChatPending[] }

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
    // Back on the chat we were looking at.
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
    render()
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

/** Chat screen's session */
const routeChat = () => {
  const m = location.hash.match(/^#\/s\/(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

const isFx = (id: string) => id.startsWith("fx:")
/** Where tapping a session goes: its chat (fx ones bounce back to the list with a notice, see route()). */
const sessionHref = (id: string) => `#/s/${encodeURIComponent(id)}`

const onBoard = () => location.hash === "#/board"

window.addEventListener("hashchange", () => route())

function route() {
  const chatID = routeChat()
  if (chatID && isFx(chatID)) {
    const msg = "fx sessions open on your Mac"
    notice = msg
    setTimeout(() => notice === msg && ((notice = ""), render()), 3000)
    location.replace("#/")
    return
  }
  send({ t: "board", on: onBoard() })
  if (chatID) showChat(chatID)
  else showList()
}

// ---------- list ----------

let listEl: HTMLElement | undefined

function showList() {
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

/** Spaces, Recents, Archived and child sessions start folded (open the one you want). Keys: space:<id>, recents, archived, s:<id> (children). */
const FOLD_DEFAULTS: Record<string, boolean> = { recents: true, archived: true }
const foldDefault = (key: string) => FOLD_DEFAULTS[key] ?? (key.startsWith("space:") || key.startsWith("s:"))
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

/** from: opened on the session's own chat (no "Open", archiving goes back to the list) */
function sessionMenu(s: Session, from?: "chat") {
  const fx = isFx(s.id)
  const parent = s.parentID ? snapshot.sessions.find((x) => x.id === s.parentID) : undefined
  const sub = [s.archived ? "Archived" : spaceLabel(s.spaceID), fx ? "fx" : "opencode"].join(" · ")
  openSheet(s.title || "Untitled", sub, [
    ...(fx || from ? [] : [sheetAction("Open", () => (location.hash = sessionHref(s.id)))]),
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
function sessionMenuButton(id: string, from: "chat") {
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
  return a
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
    // ⋯ only on open spaces; a folded one still shows a spinner while a session starts there.
    ...(open ? [menuButton(space)] : creating === space.id ? [h("span", { className: "spinner" })] : []),
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
              "No sessions yet",
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
const newChatButton = h("button", { className: "new-chat", title: "New chat", onclick: () => startNew(null) }) as HTMLButtonElement
/** Search + New chat, built once like the search bar */
const searchRow = h("div", { className: "search-row" }, searchBar, newChatButton)
const syncNewChat = () => {
  newChatButton.disabled = creating !== null
  newChatButton.replaceChildren(creating === "" ? h("span", { className: "spinner" }) : icon("compose"), "New")
}
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
  return h(
    "div",
    { className: "list-body" },
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
  syncNewChat()
  return h("div", { className: "list" }, homeHeader(), searchRow, ...(notice ? [h("div", { className: "notice" }, notice)] : []), listBody())
}

/** Sessions screen already up: swap everything but the search row. */
function updateList(el: HTMLElement) {
  syncNewChat()
  for (const child of [...el.children]) if (child !== searchRow) child.remove()
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

// ---------- chat ----------

type ChatInbound = Extract<Inbound, { t: "chat" | "chat-more" | "chat-update" | "chat-pending" }>

/** The chat on screen: messages by id (live updates replace them in place), oldest first. */
let sessionEl: HTMLElement | undefined

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

/**
 * The keyboard coming up (or the composer growing, a question showing) shrinks the list from the bottom:
 * keep what was at the bottom in view instead of letting it slide behind the composer.
 */
function anchorBottom(list: HTMLElement) {
  let fromBottom = 0
  list.addEventListener("scroll", () => (fromBottom = list.scrollHeight - list.scrollTop - list.clientHeight), { passive: true })
  let height = 0
  const ro = new ResizeObserver(() => {
    // Left the chat: removal reports a last resize.
    if (!list.isConnected) return ro.disconnect()
    if (list.clientHeight === height) return
    height = list.clientHeight
    list.scrollTop = list.scrollHeight - list.clientHeight - fromBottom
  })
  ro.observe(list)
}

function scrollToBottom() {
  const list = sessionEl?.querySelector<HTMLElement>(".chat-list")
  if (list) list.scrollTop = list.scrollHeight
}

function itemEl(i: ChatItem) {
  if (i.kind === "user") {
    const photos = Array.from({ length: i.images ?? 0 }, (_, n) => {
      const src = `/file/${chat!.id}/${i.id}/${n}`
      return h("a", { href: src, target: "_blank" }, h("img", { src, alt: "Photo", loading: "lazy" }))
    })
    return h(
      "div",
      { className: "msg user" },
      ...(photos.length ? [h("div", { className: "photos" }, ...photos)] : []),
      ...(i.text.trim() ? [h("div", { className: "bubble" }, i.text)] : []),
    )
  }
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
  // Kept while still pending, so a half-filled question survives pushes.
  const asks = sessionEl.querySelector<HTMLElement>(".chat-asks")!
  const existing = new Map([...asks.children].map((el) => [(el as HTMLElement).dataset.key!, el as HTMLElement]))
  asks.replaceChildren(
    ...chat.pending.map((p) => {
      const json = JSON.stringify(p)
      const old = existing.get(p.id)
      if (old?.dataset.json === json) return old
      const el = p.kind === "permission" ? permissionEl(p) : questionEl(p)
      el.dataset.key = p.id
      el.dataset.json = json
      return el
    }),
  )
  const session = snapshot.sessions.find((s) => s.id === id)
  sessionEl.querySelector(".title")!.textContent = session?.title || chat.title || "Session"
  const running = session?.status === "running"
  sessionEl.querySelector<HTMLElement>(".stop")!.hidden = !running
}

function permissionEl(p: Extract<ChatPending, { kind: "permission" }>) {
  const reply = (decision: "once" | "always" | "reject", label: string, cls = "") =>
    h("button", { className: `ask-btn ${cls}`, onclick: () => send({ t: "chat-reply", requestID: p.id, decision }) }, label)
  return h(
    "div",
    { className: "ask" },
    h("div", { className: "ask-detail" }, p.detail),
    h("div", { className: "ask-actions" }, reply("once", "Allow", "primary"), reply("always", "Always"), reply("reject", "Deny")),
  )
}

/** A field shows when it isn't hidden and its `when` conditions hold for the answers so far. */
const fieldShown = (f: FormField, answers: FormAnswer) =>
  !f.hidden && (f.when ?? []).every((w) => (answers[w.key] === w.value) === (w.op === "eq"))

const hasValue = (v: FormAnswer[string] | undefined) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)

const answerLabel = (f: FormField, v: FormAnswer[string] | undefined) => {
  if (!hasValue(v)) return "—"
  const label = (x: string | number | boolean) =>
    typeof x === "boolean" ? (x ? "Yes" : "No") : (f.options?.find((o) => o.value === x)?.label ?? String(x))
  return Array.isArray(v) ? v.map(label).join(", ") : label(v!)
}

/**
 * An opencode question form, one question at a time like the TUI: pick an option (or several), or type your
 * own answer, then Next. Several questions end on a review step (tap one to change it) with Submit.
 */
function questionEl(p: Extract<ChatPending, { kind: "question" }>) {
  const answers: FormAnswer = {}
  /** Typed answers, kept apart from picked options so going back shows both */
  const own: Record<string, string> = {}
  for (const f of p.fields) {
    const d = f.default
    if (typeof d === "string" || typeof d === "number" || typeof d === "boolean") answers[f.key] = d
    else if (Array.isArray(d)) answers[f.key] = d.filter((x): x is string => typeof x === "string")
  }
  let step = 0
  const el = h("div", { className: "ask question" })
  const steps = () => p.fields.filter((f) => fieldShown(f, answers))
  const multiStep = () => steps().length > 1

  const finish = () => {
    const answer: FormAnswer = {}
    for (const f of steps()) if (hasValue(answers[f.key])) answer[f.key] = answers[f.key]
    el.classList.add("sent")
    send({ t: "chat-answer", formID: p.id, answer })
  }
  const go = (n: number) => {
    step = n
    draw()
  }
  const next = () => (step < steps().length - 1 || multiStep() ? go(step + 1) : finish())

  function draw() {
    const list = steps()
    const review = multiStep() && step >= list.length
    const top = h(
      "div",
      { className: "q-top" },
      h("span", { className: "q-progress" }, review ? "Review" : multiStep() ? `${step + 1} of ${list.length}` : "Question"),
      h("button", { className: "q-dismiss", onclick: () => send({ t: "chat-answer", formID: p.id, answer: null }) }, "Dismiss"),
    )
    if (review) {
      el.replaceChildren(
        top,
        h("div", { className: "q-heading" }, p.title),
        ...list.map((f, i) =>
          h(
            "button",
            { className: "q-review", onclick: () => go(i) },
            h("span", { className: "q-desc" }, f.title || f.key),
            h("span", { className: "q-label" }, answerLabel(f, answers[f.key])),
          ),
        ),
        h(
          "div",
          { className: "ask-actions" },
          h("button", { className: "ask-btn", onclick: () => go(list.length - 1) }, "Back"),
          h(
            "button",
            { className: "ask-btn primary", disabled: list.some((f) => f.required && f.type !== "external" && !hasValue(answers[f.key])), onclick: finish },
            "Submit",
          ),
        ),
      )
      return
    }
    const f = list[Math.min(step, list.length - 1)]
    const picks = f.type === "multiselect" ? (f.options ?? []) : f.type === "boolean" ? [{ value: true, label: "Yes" }, { value: false, label: "No" }] : (f.options ?? [])
    const multi = f.type === "multiselect"
    const ownAllowed = f.type !== "boolean" && f.type !== "external" && (!picks.length || f.custom === true)
    const last = step >= list.length - 1 && !multiStep()
    const nextBtn = h("button", { className: "ask-btn primary", onclick: next }, last ? "Submit" : "Next") as HTMLButtonElement
    const syncNext = () => {
      const empty = !hasValue(answers[f.key])
      nextBtn.disabled = !!f.required && f.type !== "external" && empty
      if (!last) nextBtn.textContent = empty && !f.required ? "Skip" : "Next"
    }
    const options = picks.map((o) => {
      const cur = answers[f.key]
      const on = multi ? Array.isArray(cur) && cur.includes(o.value as string) : cur === o.value
      return h(
        "button",
        {
          className: `q-option${on ? " on" : ""}${multi ? " multi" : ""}`,
          onclick: () => {
            if (multi) {
              const list = Array.isArray(cur) ? cur : []
              answers[f.key] = on ? list.filter((x) => x !== o.value) : [...list, o.value as string]
              draw()
              return
            }
            answers[f.key] = o.value
            own[f.key] = ""
            draw()
            // One pick answers it: on to the next question, like the TUI.
            if (!last) setTimeout(next, 150)
          },
        },
        h("span", { className: "q-label" }, o.label),
        ...("description" in o && o.description ? [h("span", { className: "q-desc" }, o.description)] : []),
      )
    })
    const numeric = f.type === "number" || f.type === "integer"
    const input = ownAllowed
      ? (h("input", {
          className: "q-input",
          type: numeric ? "number" : "text",
          placeholder: f.placeholder ?? (picks.length ? "Type your own answer…" : "Your answer"),
          value: own[f.key] ?? (!picks.length && answers[f.key] !== undefined ? String(answers[f.key]) : ""),
          inputMode: f.type === "integer" ? "numeric" : f.type === "number" ? "decimal" : undefined,
          enterKeyHint: last ? "send" : "next",
        }) as HTMLInputElement)
      : null
    input?.addEventListener("input", () => {
      const v = input.value
      own[f.key] = v
      if (numeric) answers[f.key] = v === "" ? "" : Number(v)
      else if (multi) {
        const picked = (Array.isArray(answers[f.key]) ? (answers[f.key] as string[]) : []).filter((x) => f.options?.some((o) => o.value === x))
        answers[f.key] = v.trim() ? [...picked, v.trim()] : picked
      } else answers[f.key] = v
      // Typing your own answer replaces a picked option.
      if (!multi) for (const b of el.querySelectorAll(".q-option.on")) b.classList.remove("on")
      syncNext()
    })
    input?.addEventListener("keydown", (e) => e.key === "Enter" && !nextBtn.disabled && next())
    el.replaceChildren(
      top,
      h("div", { className: "q-heading" }, f.title || p.title),
      ...(f.description ? [h("div", { className: "q-desc q-help" }, f.description)] : []),
      ...(multi ? [h("div", { className: "q-desc q-help" }, "Pick any")] : []),
      ...(picks.length ? [h("div", { className: "q-options" }, ...options)] : []),
      ...(f.type === "external" && f.url ? [h("a", { className: "ask-btn q-link", href: f.url, target: "_blank", rel: "noreferrer" }, "Open link")] : []),
      ...(input ? [input] : []),
      h(
        "div",
        { className: "ask-actions" },
        ...(step > 0 ? [h("button", { className: "ask-btn", onclick: () => go(step - 1) }, "Back")] : []),
        nextBtn,
      ),
    )
    syncNext()
  }
  draw()
  return el
}

/** Longest side of a photo once shrunk on the phone: plenty for a model, a fraction of a camera's size. */
const PHOTO_MAX = 2000
const MAX_PHOTOS = 6

/** A picked photo as a JPEG data: URL, shrunk to PHOTO_MAX (Safari decodes HEIC for the canvas). */
async function shrinkPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL("image/jpeg", 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function renderChat(id: string) {
  const session = snapshot.sessions.find((s) => s.id === id)
  // Editable div, not a textarea: iOS Safari only hands pasted images to rich editable fields. Kept plain
  // text by the paste handler below. Return types a new line (the phone's keyboard); the button sends.
  const input = h("div", { className: "composer-input", contentEditable: "true", role: "textbox", enterKeyHint: "enter" })
  input.dataset.placeholder = "Message"
  const text = () => input.innerText.replace(/\n$/, "")
  // Deleting everything can leave a <br> behind, which hides the placeholder.
  input.addEventListener("input", () => {
    if (!text().trim() && input.childNodes.length && !input.querySelector("img")) input.replaceChildren()
  })
  let photos: string[] = []
  const tray = h("div", { className: "photo-tray", hidden: true })
  const drawTray = () => {
    tray.hidden = !photos.length
    tray.replaceChildren(
      ...photos.map((src, n) =>
        h(
          "div",
          { className: "photo-thumb" },
          h("img", { src, alt: "Photo" }),
          h(
            "button",
            {
              title: "Remove",
              onclick: () => {
                photos = photos.filter((_, k) => k !== n)
                drawTray()
              },
            },
            "×",
          ),
        ),
      ),
    )
  }
  const picker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true }) as HTMLInputElement
  const addPhotos = async (picked: File[]) => {
    const files = picked.filter((f) => f.type.startsWith("image/")).slice(0, MAX_PHOTOS - photos.length)
    for (const file of files) {
      try {
        photos = [...photos, await shrinkPhoto(file)]
      } catch {
        const msg = `Couldn't read ${file.name || "that photo"}`
        notice = msg
        render()
        setTimeout(() => notice === msg && ((notice = ""), render()), 3000)
      }
      drawTray()
    }
  }
  picker.addEventListener("change", () => {
    const files = [...(picker.files ?? [])]
    picker.value = ""
    void addPhotos(files)
  })
  // Pasting an image (copied from Photos, a screenshot, a web page) attaches it; pasted text goes in as usual.
  input.addEventListener("paste", (e) => {
    e.preventDefault()
    const data = e.clipboardData
    if (!data) return
    const files = data.files.length
      ? [...data.files]
      : [...data.items].map((i) => (i.kind === "file" ? i.getAsFile() : null)).filter((f): f is File => !!f)
    if (files.some((f) => f.type.startsWith("image/"))) return void addPhotos(files)
    // Plain text only, never the copied formatting.
    document.execCommand("insertText", false, data.getData("text/plain"))
  })
  input.addEventListener("drop", (e) => e.preventDefault())
  const submit = () => {
    const message = text()
    if (!message.trim() && !photos.length) return
    send({ t: "chat-send", text: message, ...(photos.length ? { images: photos } : {}) })
    input.replaceChildren()
    photos = []
    drawTray()
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
      sessionMenuButton(id, "chat"),
    ),
    ...(notice ? [h("div", { className: "notice" }, notice)] : []),
    h("div", { className: "chat-list" }, h("div", { className: "chat-top" })),
    h("div", { className: "chat-asks" }),
    tray,
    h(
      "div",
      { className: "composer" },
      picker,
      h(
        "button",
        {
          className: "attach-btn",
          title: "Add photos",
          onpointerdown: keepFocus,
          onclick: () => photos.length < MAX_PHOTOS && picker.click(),
        },
        "+",
      ),
      input,
      h("button", { className: "stop", title: "Stop", hidden: true, onpointerdown: keepFocus, onclick: () => send({ t: "chat-stop" }) }, "■"),
      h("button", { className: "send-btn", title: "Send", onpointerdown: keepFocus, onclick: submit }, "↑"),
    ),
  )
  sessionEl = el
  anchorBottom(el.querySelector<HTMLElement>(".chat-list")!)
  drawMessages()
  updateChatChrome()
  if (chat?.loaded) requestAnimationFrame(scrollToBottom)
  return el
}

// ---------- render ----------

/**
 * The list re-renders from scratch (it's small). The chat screen is built once per session so the
 * half-typed message survives state pushes; only its header updates.
 */
function render() {
  const id = routeChat()
  if (!id) {
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
  if (!sessionEl || sessionEl.dataset.id !== id) {
    sessionEl?.remove()
    sessionEl = renderChat(id)
    sessionEl.dataset.id = id
    app.append(sessionEl)
    return
  }
  updateChatChrome()
  const session = snapshot.sessions.find((s) => s.id === id)
  sessionEl.querySelector(".title")!.textContent = session?.title || chat?.title || "Session"
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
  if (!routeChat()) render()
}, 30_000)

// The token is in a cookie now: keep it out of the address bar, history and screenshots.
if (location.search) history.replaceState(null, "", `/${location.hash}`)

connect()
route()
