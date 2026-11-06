import { useEffect, useMemo, useState } from "react"
import { boardPlacement, resourceType, type Placement, type Stage } from "../shared/adapters"
import type { AppState, ResourceItem } from "../shared/types"
import { age } from "./format"
import { Icon } from "./icons"

/** Space ids to show (NO_SPACE for sessions outside spaces); empty = everything */
export type BoardFilter = string[]
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
      }))
      .filter((c): c is Card => !!c.placement)
  }, [items, me, state.assignments])

  const shown = filter.length ? placed.filter((c) => c.spaces.some((s) => filter.includes(s))) : placed
  const columns = COLUMNS.map((col) => ({ ...col, cards: shown.filter((c) => c.placement.stage === col.id) }))

  // Open cards per space, for the filter chips.
  const openIn = (space: string) => placed.filter((c) => c.placement.stage !== "done" && c.spaces.includes(space)).length
  const chipsList = [
    ...state.spaces.map((s) => ({ id: s.id, name: s.name })),
    { id: NO_SPACE, name: "No space" },
  ].filter((c) => c.id !== NO_SPACE || openIn(NO_SPACE) > 0)
  const toggle = (id: string) => props.onFilter(filter.includes(id) ? filter.filter((f) => f !== id) : [...filter, id])

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
      <div className="board-filters">
        <button className={`board-filter${filter.length ? "" : " on"}`} onClick={() => props.onFilter([])}>
          All spaces
        </button>
        {chipsList.map((c) => (
          <button
            key={c.id}
            className={`board-filter${filter.includes(c.id) ? " on" : ""}`}
            title={filter.includes(c.id) ? "Click to remove from the filter" : "Click to add to the filter"}
            onClick={() => toggle(c.id)}
          >
            {c.name}
            {openIn(c.id) > 0 && <span className="count">{openIn(c.id)}</span>}
          </button>
        ))}
      </div>
      <div className="board-columns">
        {columns.map((col) => (
          <Column
            key={col.id}
            {...col}
            sessionsByID={sessionsByID}
            spaceNames={filter.length === 1 ? undefined : spaceNames}
            onOpenSession={props.onOpenSession}
          />
        ))}
      </div>
    </div>
  )
}

type Card = { item: ResourceItem; placement: Placement; spaces: string[] }

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
