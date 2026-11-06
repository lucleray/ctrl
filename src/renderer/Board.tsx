import { useEffect, useMemo, useState } from "react"
import { adapterOf, ADAPTERS, boardPlacement, resourceType, type Placement, type Stage } from "../shared/adapters"
import type { AppState, ResourceItem } from "../shared/types"
import { age } from "./format"
import { Icon } from "./icons"

/**
 * One filter row, like a chart legend: only some ids, or everything except some. "except" with no ids
 * shows everything, and keeps showing spaces created later (hiding a space doesn't freeze the list).
 */
export type Selection = { mode: "only" | "except"; ids: string[] }
const ALL: Selection = { mode: "except", ids: [] }

/** What the board shows: a card must pass every row. */
export type BoardFilter = {
  /** Space ids (NO_SPACE for sessions outside spaces) */
  spaces: Selection
  /** Adapter ids: github, slack, vercel, linear… */
  sources: Selection
}
export const NO_FILTER: BoardFilter = { spaces: ALL, sources: ALL }
export const onlySpace = (id: string): BoardFilter => ({ ...NO_FILTER, spaces: { mode: "only", ids: [id] } })

const shows = (sel: Selection, id: string) => (sel.mode === "only" ? sel.ids.includes(id) : !sel.ids.includes(id))
const isAll = (sel: Selection) => sel.mode === "except" && !sel.ids.length

/**
 * Legend clicks. Click: only this one (again: back to all). ⌘ or ⇧-click: show / hide this one, keeping
 * the rest. ⌥-click: everything except this one.
 */
function click(sel: Selection, id: string, e: { metaKey: boolean; shiftKey: boolean; altKey: boolean }): Selection {
  if (e.altKey) return { mode: "except", ids: [id] }
  if (e.metaKey || e.shiftKey) {
    const ids = sel.ids.includes(id) ? sel.ids.filter((i) => i !== id) : [...sel.ids, id]
    return sel.mode === "only" && !ids.length ? ALL : { mode: sel.mode, ids }
  }
  return sel.mode === "only" && sel.ids.length === 1 && sel.ids[0] === id ? ALL : { mode: "only", ids: [id] }
}

/** Saved across restarts: the spaces you hide usually stay hidden. */
const FILTER_KEY = "ctrl.board.filter"
export function loadFilter(): BoardFilter {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "")
    if (f?.spaces?.mode && f?.sources?.mode) return f
  } catch {}
  return NO_FILTER
}
export const saveFilter = (f: BoardFilter) => localStorage.setItem(FILTER_KEY, JSON.stringify(f))
const NO_SPACE = "none"

const COLUMNS: { id: Stage; label: string; hint: string }[] = [
  { id: "you", label: "Needs you", hint: "Your turn: fix, answer, review or merge" },
  { id: "waiting", label: "Waiting on others", hint: "Someone else's turn, usually a reviewer" },
  { id: "moving", label: "In progress", hint: "Drafts, CI, builds and recently mentioned links" },
  { id: "done", label: "Done", hint: "Merged, closed, ready, or quiet for a while" },
]

const DONE_PAGE = 10

/** Resources of these sessions with the sessions mentioning them, live details kept fresh while shown. */
function useBoard(sessionIDs: string[]) {
  const [items, setItems] = useState<ResourceItem[]>([])
  const key = sessionIDs.join(",")
  useEffect(() => {
    let live = true
    const ids = key ? key.split(",") : []
    const load = () => void window.ctrl.listBoard(ids).then((r) => live && setItems(r))
    load()
    const inScope = new Set(ids)
    const offChanged = window.ctrl.onResourcesChanged((changed) => {
      if (!changed || changed.some((id) => inScope.has(id))) load()
    })
    const offMeta = window.ctrl.onResourceMeta((metas) =>
      setItems((prev) => (prev.some((i) => metas[i.id]) ? prev.map((i) => (metas[i.id] ? { ...i, meta: metas[i.id] } : i)) : prev)),
    )
    window.ctrl.watchResources(ids)
    return () => {
      live = false
      offChanged()
      offMeta()
      window.ctrl.watchResources([])
    }
  }, [key])
  return items
}

export function Board(props: {
  state: AppState
  filter: BoardFilter
  onFilter(filter: BoardFilter): void
  onClose(): void
  onOpenSession(id: string): void
}) {
  const { state, filter } = props

  // One board for everything: every session ctrl knows, filtered by space on screen only.
  const sessionIDs = useMemo(
    () => [...new Set([...state.sessions.map((s) => s.id), ...Object.keys(state.assignments)])].sort(),
    [state.assignments, state.sessions],
  )
  const items = useBoard(sessionIDs)
  const me = state.adapters.find((a) => a.id === "github")?.status?.account
  const spaceOf = (sessionID: string) => state.assignments[sessionID] ?? NO_SPACE

  const placed = useMemo(() => {
    const now = Date.now()
    return items
      .map((item) => ({
        item,
        placement: boardPlacement(item, { me, now }),
        spaces: [...new Set((item.sessionIDs ?? []).map(spaceOf))],
        source: adapterOf(item.type)?.id ?? "",
      }))
      .filter((c): c is Card => !!c.placement)
  }, [items, me, state.assignments])

  const inSpaces = (c: Card) => c.spaces.some((s) => shows(filter.spaces, s))
  const inSources = (c: Card) => shows(filter.sources, c.source)
  const shown = placed.filter((c) => inSpaces(c) && inSources(c))
  const columns = COLUMNS.map((col) => ({ ...col, cards: shown.filter((c) => c.placement.stage === col.id) }))

  // Open cards per chip, given the other filter row (so counts match what clicking would show).
  const open = placed.filter((c) => c.placement.stage !== "done")
  const openInSpace = (space: string) => open.filter((c) => inSources(c) && c.spaces.includes(space)).length
  const openFromSource = (source: string) => open.filter((c) => inSpaces(c) && c.source === source).length
  const spaceChips = [...state.spaces.map((s) => ({ id: s.id, name: s.name })), { id: NO_SPACE, name: "No space" }]
    .filter((c) => c.id !== NO_SPACE || placed.some((p) => p.spaces.includes(NO_SPACE)))
    .map((c) => ({ ...c, count: openInSpace(c.id) }))
  // Only sources with cards on the board (repos, Notion… never make it there).
  const sourceChips = ADAPTERS.filter((a) => placed.some((c) => c.source === a.id)).map((a) => ({
    id: a.id,
    name: a.name,
    count: openFromSource(a.id),
  }))
  const onClick = (key: keyof BoardFilter) => (id: string, e: React.MouseEvent) =>
    props.onFilter({ ...filter, [key]: click(filter[key], id, e) })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [props.onClose])

  const sessionsByID = useMemo(() => new Map(state.sessions.map((s) => [s.id, s])), [state.sessions])
  const spaceNames = useMemo(() => new Map(state.spaces.map((s) => [s.id, s.name])), [state.spaces])
  const total = columns.reduce((n, c) => n + (c.id === "done" ? 0 : c.cards.length), 0)

  return (
    <div className="board">
      <div className="board-header">
        <div className="board-title">
          <h1>Board</h1>
          <span className="board-sub">
            {total} open · {me ? `as @${me}` : "GitHub login unknown, every PR counts as yours"}
          </span>
        </div>
        <button className="icon-btn" title="Close (Esc)" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>
      <FilterRow
        label="Spaces"
        all="All spaces"
        chips={spaceChips}
        selection={filter.spaces}
        onAll={() => props.onFilter({ ...filter, spaces: ALL })}
        onClick={onClick("spaces")}
      />
      <FilterRow
        label="Types"
        all="All types"
        chips={sourceChips}
        selection={filter.sources}
        onAll={() => props.onFilter({ ...filter, sources: ALL })}
        onClick={onClick("sources")}
      />
      <div className="board-columns">
        {columns.map((col) => (
          <Column
            key={col.id}
            {...col}
            sessionsByID={sessionsByID}
            spaceNames={filter.spaces.mode === "only" && filter.spaces.ids.length === 1 ? undefined : spaceNames}
            onOpenSession={props.onOpenSession}
          />
        ))}
      </div>
    </div>
  )
}

type Card = { item: ResourceItem; placement: Placement; spaces: string[]; source: string }

function FilterRow(props: {
  label: string
  all: string
  chips: { id: string; name: string; count: number }[]
  selection: Selection
  onAll(): void
  onClick(id: string, e: React.MouseEvent): void
}) {
  const all = isAll(props.selection)
  return (
    <div className="board-filters">
      <span className="board-filters-label">{props.label}</span>
      <button className={`board-filter${all ? " on" : ""}`} onClick={props.onAll}>
        {props.all}
      </button>
      {props.chips.map((c) => {
        const visible = shows(props.selection, c.id)
        return (
          <button
            key={c.id}
            className={`board-filter${all ? "" : visible ? " on" : " hidden"}`}
            title={"Click: only this · ⌘-click: show / hide · ⌥-click: all except this"}
            onClick={(e) => props.onClick(c.id, e)}
          >
            <span className="board-filter-dot" />
            <span className="board-filter-name">{c.name}</span>
            {/* Always there, so chips keep their width when counts change or the chip is hidden. */}
            <span className={`count${c.count ? "" : " zero"}`}>{c.count}</span>
          </button>
        )
      })}
    </div>
  )
}

function Column(props: {
  id: Stage
  label: string
  hint: string
  cards: Card[]
  sessionsByID: Map<string, AppState["sessions"][number]>
  /** Set when cards from several spaces mix: each card names its spaces */
  spaceNames?: Map<string, string>
  onOpenSession(id: string): void
}) {
  const [shown, setShown] = useState(DONE_PAGE)
  const cards = props.id === "done" ? props.cards.slice(0, shown) : props.cards
  return (
    <section className={`board-column stage-${props.id}`}>
      <div className="board-column-header" title={props.hint}>
        <span>{props.label}</span>
        <span className="count">{props.cards.length}</span>
      </div>
      <div className="board-cards">
        {props.cards.length === 0 && <div className="board-empty">Nothing here</div>}
        {cards.map((c) => (
          <BoardCard
            key={c.item.id}
            card={c}
            sessionsByID={props.sessionsByID}
            spaceNames={props.spaceNames}
            onOpenSession={props.onOpenSession}
          />
        ))}
        {props.id === "done" && props.cards.length > shown && (
          <button className="row show-more" onClick={() => setShown((n) => n + DONE_PAGE)}>
            <span className="label">Show more</span>
          </button>
        )}
      </div>
    </section>
  )
}

function BoardCard(props: {
  card: Card
  sessionsByID: Map<string, AppState["sessions"][number]>
  spaceNames?: Map<string, string>
  onOpenSession(id: string): void
}) {
  const { item, placement } = props.card
  const spaces = props.spaceNames
    ? props.card.spaces.map((id) => props.spaceNames!.get(id)).filter((n): n is string => !!n)
    : []
  const type = resourceType(item.type)
  const meta = item.meta?.missing ? undefined : item.meta
  const parsed = type?.describe(item.data) ?? { title: item.url }
  const title = meta?.title ?? parsed.title
  const subtitle = meta?.subtitle ?? parsed.subtitle
  // Newest first; sessions ctrl hasn't loaded (older, deleted) are left out.
  const sessions = (item.sessionIDs ?? [])
    .map((id) => props.sessionsByID.get(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .sort((a, b) => b.updated - a.updated)

  return (
    <div className="board-card" title={item.url} onClick={() => void window.ctrl.openExternal(item.url)}>
      <div className="board-card-top">
        <span className={`resource-icon${meta?.tone ? ` tone-${meta.tone}` : ""}`}>
          <Icon name={type?.icon ?? "link"} />
        </span>
        <span className="board-card-title">{title}</span>
        <span className="meta">{age(item.last)}</span>
      </div>
      <div className="board-card-reason">
        <span>{placement.reason}</span>
        {spaces.length > 0 && (
          <span className="board-card-spaces" title={spaces.join(", ")}>
            {spaces[0]}
            {spaces.length > 1 ? ` +${spaces.length - 1}` : ""}
          </span>
        )}
      </div>
      {(subtitle || !!meta?.chips?.length) && (
        <div className="resource-subtitle">
          {subtitle && <span className="resource-subtitle-text">{subtitle}</span>}
          {!!meta?.chips?.length && (
            <span className="chips">
              {meta.chips.map((c) => (
                <span key={c.text} className={`chip tone-${c.tone}`} title={c.title}>
                  {c.text}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      {sessions.length > 0 && (
        <div className="board-card-sessions">
          {sessions.slice(0, 2).map((s) => (
            <button
              key={s.id}
              className="board-session"
              title={`Open “${s.title}”`}
              onClick={(e) => {
                e.stopPropagation()
                props.onOpenSession(s.id)
              }}
            >
              <Icon name="terminal" />
              <span>{s.title}</span>
            </button>
          ))}
          {sessions.length > 2 && <span className="board-more">+{sessions.length - 2}</span>}
        </div>
      )}
    </div>
  )
}
