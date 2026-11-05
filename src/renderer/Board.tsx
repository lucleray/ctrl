import { useEffect, useMemo, useState } from "react"
import { boardPlacement, resourceType, type Placement, type Stage } from "../shared/adapters"
import type { AppState, ResourceItem } from "../shared/types"
import { age } from "./format"
import { Icon } from "./icons"

/** "all", or a space id */
export type BoardScope = string

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
  scope: BoardScope
  onScope(scope: BoardScope): void
  onClose(): void
  onOpenSession(id: string): void
}) {
  const { state, scope } = props
  const space = state.spaces.find((s) => s.id === scope)

  const sessionIDs = useMemo(() => {
    if (space) return Object.keys(state.assignments).filter((id) => state.assignments[id] === space.id)
    return [...new Set([...state.sessions.map((s) => s.id), ...Object.keys(state.assignments)])]
  }, [space, state.assignments, state.sessions])

  const items = useBoard(sessionIDs)
  const me = state.adapters.find((a) => a.id === "github")?.status?.account

  const columns = useMemo(() => {
    const now = Date.now()
    const placed = items
      .map((item) => ({ item, placement: boardPlacement(item, { me, now }) }))
      .filter((c): c is Card => !!c.placement)
    return COLUMNS.map((col) => ({ ...col, cards: placed.filter((c) => c.placement.stage === col.id) }))
  }, [items, me])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [props.onClose])

  const sessionsByID = useMemo(() => new Map(state.sessions.map((s) => [s.id, s])), [state.sessions])
  const total = columns.reduce((n, c) => n + (c.id === "done" ? 0 : c.cards.length), 0)

  return (
    <div className="board">
      <div className="board-header">
        <div className="board-title">
          <h1>Board</h1>
          <select value={scope} onChange={(e) => props.onScope(e.target.value)}>
            <option value="all">All spaces</option>
            {state.spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="board-sub">
            {total} open · {me ? `as @${me}` : "GitHub login unknown, every PR counts as yours"}
          </span>
        </div>
        <button className="icon-btn" title="Close (Esc)" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="board-columns">
        {columns.map((col) => (
          <Column key={col.id} {...col} sessionsByID={sessionsByID} onOpenSession={props.onOpenSession} />
        ))}
      </div>
    </div>
  )
}

type Card = { item: ResourceItem; placement: Placement }

function Column(props: {
  id: Stage
  label: string
  hint: string
  cards: Card[]
  sessionsByID: Map<string, AppState["sessions"][number]>
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
          <BoardCard key={c.item.id} card={c} sessionsByID={props.sessionsByID} onOpenSession={props.onOpenSession} />
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
  onOpenSession(id: string): void
}) {
  const { item, placement } = props.card
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
      <div className="board-card-reason">{placement.reason}</div>
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
