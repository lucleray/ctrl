import { useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from "react"
import { shortcutLabel } from "../shared/shortcuts"
import { STATUS_RANK, type AppState, type SessionItem, type Space } from "../shared/types"
import { Icon } from "./icons"
import { SESSION_DRAG } from "./ReferenceDrop"
import { age, shortPath, statusText } from "./format"
import { StatusIcon, topStatus } from "./StatusIcon"
import { useSidebarWidth } from "./ResizeHandle"

const SPACE_DRAG = "application/x-ctrl-space"
const RECENTS = "__recents__"
const PAGE_SIZE = 10

type Props = {
  state: AppState
  onOpen(id: string): void
  onNew(spaceID: string | null): void
  onSearch(): void
  onSettings(): void
  onToggleResources(): void
  boardOpen: boolean
  onToggleBoard(): void
  /** Pinned under the list, above the connection banner (the toast) */
  footer?: ReactNode
  /** sessionID → ⌘ number while ⌘ is held */
  hints: Map<string, number> | null
}

type Reorder = { id: string; pos: "before" | "after" }

/** A sidebar row in a space's session tree. */
type TreeRow = {
  session: SessionItem
  depth: number
  /** Direct children shown under it (0 = no disclosure toggle) */
  children: number
  folded: boolean
  /** Most urgent of its descendants, when folded */
  rollup?: SessionItem
}

/**
 * Nests sessions under their parent when the parent is in the same list. The rest are roots.
 * Siblings are ordered by their subtree's latest activity, so an active child lifts its parent.
 */
function sessionTree(list: SessionItem[], parents: Record<string, string>, folded: Set<string>): TreeRow[] {
  const ids = new Set(list.map((s) => s.id))
  const kids = new Map<string, SessionItem[]>()
  const roots: SessionItem[] = []
  for (const s of list) {
    const parent = parents[s.id]
    if (parent && parent !== s.id && ids.has(parent)) kids.set(parent, [...(kids.get(parent) ?? []), s])
    else roots.push(s)
  }
  const latest = new Map<string, number>()
  const descendants = new Map<string, SessionItem[]>()
  const walk = (s: SessionItem, seen: Set<string>): void => {
    seen.add(s.id)
    let max = s.updated
    const all: SessionItem[] = []
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
  const byLatest = (a: SessionItem, b: SessionItem) => latest.get(b.id)! - latest.get(a.id)!
  const rows: TreeRow[] = []
  const emit = (s: SessionItem, depth: number) => {
    const children = (kids.get(s.id) ?? []).filter((c) => latest.has(c.id)).sort(byLatest)
    const isFolded = children.length > 0 && folded.has(s.id)
    rows.push({ session: s, depth, children: children.length, folded: isFolded, rollup: isFolded ? topStatus(descendants.get(s.id)!) : undefined })
    if (!isFolded) for (const c of children) emit(c, depth + 1)
  }
  for (const r of roots.sort(byLatest)) emit(r, 0)
  return rows
}

export function Sidebar({ state, hints, onOpen, onNew, onSearch, onSettings, onToggleResources, boardOpen, onToggleBoard, footer }: Props) {
  const [creating, setCreating] = useState(false)
  const [renamingSpace, setRenamingSpace] = useState<string | null>(null)
  const [renamingSession, setRenamingSession] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [reorder, setReorder] = useState<Reorder | null>(null)
  /** Session a dragged session would become a child of */
  const [nestTarget, setNestTarget] = useState<string | null>(null)
  const draggingSession = useRef<string | null>(null)
  /** Hover card for a parent link (native tooltips take a second and can't show structure) */
  const [parentTip, setParentTip] = useState<{ title: string; space: string | null; archived: boolean; x: number; y: number } | null>(null)
  const draggingSpace = useRef<string | null>(null)
  const { width, handle } = useSidebarWidth(state.ui.sidebarWidth)

  useEffect(() => window.ctrl.onRenameSpace(setRenamingSpace), [])
  useEffect(() => window.ctrl.onRenameSession(setRenamingSession), [])

  const grouped = useMemo(() => {
    const bySpace = new Map<string, SessionItem[]>()
    const recents: SessionItem[] = []
    const archived: SessionItem[] = []
    const valid = new Set(state.spaces.map((s) => s.id))
    for (const session of state.sessions) {
      if (state.archived[session.id]) {
        archived.push(session)
        continue
      }
      // Recents is a view over every live session; spaces are just a grouping on top.
      recents.push(session)
      const spaceID = state.assignments[session.id]
      if (spaceID && valid.has(spaceID)) {
        const list = bySpace.get(spaceID) ?? []
        list.push(session)
        bySpace.set(spaceID, list)
      }
    }
    archived.sort((a, b) => state.archived[b.id] - state.archived[a.id])
    return { bySpace, recents, archived }
  }, [state.sessions, state.assignments, state.spaces, state.archived])

  const folded = useMemo(() => new Set(state.ui.collapsedSessions ?? []), [state.ui.collapsedSessions])

  const toggleChildren = (id: string) => {
    const next = new Set(folded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void window.ctrl.setUi({ collapsedSessions: [...next] })
  }

  const clearDrag = () => {
    setDropTarget(null)
    setReorder(null)
    setNestTarget(null)
    draggingSpace.current = null
    draggingSession.current = null
  }

  /** Opens a session and shows it in the sidebar: unfolds its space and parents, scrolls to it, flashes it. */
  const revealSession = async (id: string) => {
    onOpen(id)
    const spaceID = state.assignments[id]
    if (state.spaces.find((s) => s.id === spaceID)?.collapsed) await window.ctrl.toggleSpace(spaceID)
    const ancestors = new Set<string>()
    for (let cur = state.parents[id]; cur && !ancestors.has(cur); cur = state.parents[cur]) ancestors.add(cur)
    if ([...folded].some((f) => ancestors.has(f)))
      await window.ctrl.setUi({ collapsedSessions: [...folded].filter((f) => !ancestors.has(f)) })
    // The unfolded rows render once the new state arrives: look for the row for a few frames.
    let tries = 30
    const find = () => {
      const el =
        document.querySelector<HTMLElement>(`.space [data-session-id="${id}"]`) ??
        document.querySelector<HTMLElement>(`.sidebar [data-session-id="${id}"]`)
      if (!el) return void (tries-- > 0 && requestAnimationFrame(find))
      el.scrollIntoView({ block: "nearest", behavior: "smooth" })
      el.classList.remove("flash")
      void el.offsetWidth
      el.classList.add("flash")
    }
    requestAnimationFrame(find)
  }

  /** Whether `id` is `ancestor` or sits somewhere under it. */
  const isUnder = (id: string, ancestor: string) => {
    const seen = new Set<string>()
    for (let cur: string | undefined = id; cur && !seen.has(cur); cur = state.parents[cur]) {
      if (cur === ancestor) return true
      seen.add(cur)
    }
    return false
  }

  /** Dropping a session onto another one in a space makes it its child. */
  const nestDrop = (target: SessionItem): HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      const dragged = draggingSession.current
      if (!dragged || !e.dataTransfer.types.includes(SESSION_DRAG) || isUnder(target.id, dragged)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = "move"
      if (nestTarget !== target.id) setNestTarget(target.id)
      setDropTarget(null)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setNestTarget((t) => (t === target.id ? null : t))
    },
    onDrop: (e) => {
      const id = e.dataTransfer.getData(SESSION_DRAG)
      if (!id || isUnder(target.id, id)) return
      e.preventDefault()
      e.stopPropagation()
      clearDrag()
      void window.ctrl.setParent(id, target.id)
    },
  })

  const sessionDrop = (key: string, spaceID: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(SESSION_DRAG)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "move"
      if (dropTarget !== key) setDropTarget(key)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((t) => (t === key ? null : t))
    },
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(SESSION_DRAG)
      if (!id) return
      e.preventDefault()
      clearDrag()
      void window.ctrl.moveSession(id, spaceID)
    },
  })

  const spaceDrop = (space: Space, index: number): HTMLAttributes<HTMLDivElement> => {
    const sessions = sessionDrop(space.id, space.id)
    return {
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(SPACE_DRAG)) return sessions.onDragOver(e)
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"
        const rect = e.currentTarget.getBoundingClientRect()
        const pos = e.clientY < rect.top + Math.min(rect.height / 2, 20) ? "before" : "after"
        if (draggingSpace.current === space.id) return setReorder(null)
        if (reorder?.id !== space.id || reorder.pos !== pos) setReorder({ id: space.id, pos })
      },
      onDragLeave: (e) => {
        sessions.onDragLeave(e)
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setReorder((r) => (r?.id === space.id ? null : r))
      },
      onDrop: (e) => {
        const dragged = draggingSpace.current
        if (!e.dataTransfer.types.includes(SPACE_DRAG) || !dragged) return sessions.onDrop(e)
        e.preventDefault()
        const pos = reorder?.id === space.id ? reorder.pos : "after"
        clearDrag()
        if (dragged === space.id) return
        const from = state.spaces.findIndex((s) => s.id === dragged)
        let to = index + (pos === "after" ? 1 : 0)
        if (from < to) to--
        if (from !== to) void window.ctrl.moveSpace(dragged, to)
      },
    }
  }

  const agentText = (s: SessionItem) => {
    const origin = state.createdByAgent[s.id]
    if (!origin) return null
    const parent = origin.by && state.sessions.find((p) => p.id === origin.by)
    const who = origin.agent === "agent" ? "an agent" : origin.agent
    return parent ? `Created by ${who} in "${parent.title}"` : `Created by ${who}`
  }

  const sessionLabel = (id: string) => {
    const p = state.sessions.find((x) => x.id === id)
    if (!p) return null
    const spaceID = state.assignments[id]
    const space = state.spaces.find((x) => x.id === spaceID)
    return { session: p, where: space ? `in ${space.name}` : "in no space", space: space?.name ?? null, archived: !!state.archived[id] }
  }

  const parentText = (s: SessionItem) => {
    const parentID = state.parents[s.id]
    const parent = parentID && sessionLabel(parentID)
    return parent ? `Child of "${parent.session.title}" (${parent.where}${parent.archived ? ", archived" : ""})` : null
  }

  /**
   * `tree`: the row's place in a space's tree. Rows in a space whose parent isn't shown above them
   * (another space, archived) get a link to the parent instead.
   */
  const sessionRow = (s: SessionItem, tree?: TreeRow) => {
    const depth = tree?.depth ?? 0
    const parentID = state.parents[s.id]
    const parentLink = tree && depth === 0 && parentID ? sessionLabel(parentID) : null
    const status = tree?.rollup && STATUS_RANK[tree.rollup.status] > STATUS_RANK[s.status] ? tree.rollup.status : s.status
    return renamingSession === s.id ? (
      <NameInput
        key={s.id}
        initial={s.title}
        indent
        depth={depth}
        onDone={(title) => {
          setRenamingSession(null)
          if (title && title !== s.title) void window.ctrl.renameSession(s.id, title)
        }}
      />
    ) : (
      <div
        key={s.id}
        data-session-id={s.id}
        className={`row session ${s.id === state.currentSessionID ? "active" : ""} ${nestTarget === s.id && tree ? "nest-over" : ""}`}
        style={depth ? { paddingLeft: 35 + depth * CHILD_INDENT } : undefined}
        draggable
        {...(tree ? nestDrop(s) : {})}
        onDragStart={(e) => {
          draggingSession.current = s.id
          e.dataTransfer.setData(SESSION_DRAG, s.id)
          // move = into a space, copy = reference it in the terminal
          e.dataTransfer.effectAllowed = "copyMove"
        }}
        onDragEnd={clearDrag}
        onClick={() => onOpen(s.id)}
        onDoubleClick={() => setRenamingSession(s.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          void window.ctrl.showSessionMenu(s.id)
        }}
        title={[statusText(s), s.title, `${s.harness} · ${shortPath(s.directory)}`, parentText(s), agentText(s), tree?.rollup && `${tree.rollup.title}: ${statusText(tree.rollup)}`]
          .filter(Boolean)
          .join("\n")}
      >
        {tree && tree.children > 0 && (
          <button
            className="icon-btn tree-toggle"
            style={{ left: 35 + depth * CHILD_INDENT - 20 }}
            title={tree.folded ? `Show ${tree.children} child session${tree.children > 1 ? "s" : ""}` : "Hide child sessions"}
            onClick={(e) => {
              e.stopPropagation()
              toggleChildren(s.id)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Icon name={tree.folded ? "chevron-right" : "chevron-down"} />
          </button>
        )}
        {parentLink && (
          <button
            className="icon-btn parent-link"
            // Empty title: keeps the row's native tooltip from showing over the hover card.
            title=""
            aria-label={`Parent: ${parentLink.session.title}`}
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setParentTip({ title: parentLink.session.title, space: parentLink.space, archived: parentLink.archived, x: r.left, y: r.bottom + 6 })
            }}
            onMouseLeave={() => setParentTip(null)}
            onClick={(e) => {
              e.stopPropagation()
              setParentTip(null)
              void revealSession(parentLink.session.id)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Icon name="corner-up-left" />
          </button>
        )}
        {s.harness === "fx" && <span className="harness-tag">fx</span>}
        {state.createdByAgent[s.id] && (
          <span className="agent-tag">
            <Icon name="bot" />
          </span>
        )}
        <span className="label">{s.title}</span>
        {hints?.has(s.id) ? (
          <kbd className="jump-hint">⌘{hints.get(s.id)}</kbd>
        ) : s.status === "idle" ||
          // Archived sessions only flag what's live (running, needs you), not unread/failed.
          (state.archived[s.id] && (s.status === "unread" || s.status === "failed")) ? (
          <span className="meta">{age(s.updated)}</span>
        ) : (
          <StatusIcon status={status} />
        )}
        <button
          className="icon-btn row-action"
          title={state.archived[s.id] ? "Unarchive" : "Archive"}
          onClick={(e) => {
            e.stopPropagation()
            void window.ctrl.setArchived(s.id, !state.archived[s.id])
          }}
        >
          <Icon name={state.archived[s.id] ? "unarchive" : "archive"} />
        </button>
      </div>
    )
  }

  return (
    <aside className="sidebar" style={{ width }}>
      {handle}
      <div className="sidebar-drag" />
      <div className="brand">
        <span>ctrl</span>
        <span className="brand-actions">
          <button className="icon-btn" title={withShortcut("Settings", shortcutLabel("settings", state.settings.shortcuts))} onClick={onSettings}>
            <Icon name="settings" />
          </button>
          <button className="icon-btn" title={withShortcut("Search", shortcutLabel("palette", state.settings.shortcuts))} onClick={onSearch}>
            <Icon name="search" />
          </button>
          <button
            className={`icon-btn ${state.ui.resourcesOpen ? "on" : ""}`}
            title={withShortcut("Resources", shortcutLabel("toggle-resources", state.settings.shortcuts))}
            onClick={onToggleResources}
          >
            <Icon name="panel-right" />
          </button>
          <button className={`icon-btn ${boardOpen ? "on" : ""}`} title="Board" onClick={onToggleBoard}>
            <Icon name="board" />
          </button>
        </span>
      </div>

      <button
        className="row action"
        title={withShortcut("New chat", shortcutLabel("new-chat", state.settings.shortcuts))}
        onClick={() => onNew(null)}
      >
        <Icon name="compose" />
        <span className="label">New chat</span>
      </button>

      <div className="scroll" onScroll={() => setParentTip(null)}>
        <Section
          title="Spaces"
          action={
            <button className="icon-btn" title="New space" onClick={() => setCreating(true)}>
              <Icon name="plus" />
            </button>
          }
        >
          {creating && (
            <NameInput
              icon="folder"
              placeholder="Space name"
              onDone={(name) => {
                setCreating(false)
                if (name) void window.ctrl.createSpace(name)
              }}
            />
          )}
          {state.spaces.length === 0 && !creating && (
            <div className="empty">No spaces yet — hit + to create one</div>
          )}
          {state.spaces.map((space, index) => (
            <SpaceGroup
              key={space.id}
              space={space}
              sessions={grouped.bySpace.get(space.id) ?? []}
              parents={state.parents}
              folded={folded}
              renaming={renamingSpace === space.id}
              onRenamed={() => setRenamingSpace(null)}
              onStartRename={() => setRenamingSpace(space.id)}
              onNew={() => onNew(space.id)}
              highlight={dropTarget === space.id}
              reorder={reorder?.id === space.id ? reorder.pos : null}
              dropProps={spaceDrop(space, index)}
              onDragStart={(e) => {
                draggingSpace.current = space.id
                e.dataTransfer.setData(SPACE_DRAG, space.id)
                e.dataTransfer.effectAllowed = "move"
              }}
              onDragEnd={clearDrag}
              renderSession={sessionRow}
            />
          ))}
        </Section>

        {/* Dropping onto Recents (even folded) takes a session out of its space. */}
        <div className={`drop-zone ${dropTarget === RECENTS ? "over" : ""}`} {...sessionDrop(RECENTS, null)}>
          <FoldSection
            title="Recents"
            collapsed={state.ui.recentsCollapsed}
            onToggle={() => void window.ctrl.setUi({ recentsCollapsed: !state.ui.recentsCollapsed })}
          >
            <PagedList items={grouped.recents} render={(s) => sessionRow(s)} />
            {grouped.recents.length === 0 && <div className="empty">No sessions yet</div>}
          </FoldSection>
        </div>

        {grouped.archived.length > 0 && (
          <FoldSection
            title="Archived"
            className="archived"
            collapsed={state.ui.archivedCollapsed}
            onToggle={() => void window.ctrl.setUi({ archivedCollapsed: !state.ui.archivedCollapsed })}
          >
            <PagedList items={grouped.archived} render={(s) => sessionRow(s)} />
          </FoldSection>
        )}
      </div>

      {footer}

      {parentTip && (
        <div className="parent-tip" style={{ left: parentTip.x, top: parentTip.y }}>
          <div className="parent-tip-label">Parent session</div>
          <div className="parent-tip-title">{parentTip.title}</div>
          <div className="parent-tip-meta">
            {parentTip.space ? `In space “${parentTip.space}”` : "In no space"}
            {parentTip.archived ? " · archived" : ""} · click to show it
          </div>
        </div>
      )}

      {(state.problem || state.error) && (
        <div className={`sidebar-alert ${state.problem ? "problem" : "error"}`} role="alert">
          <Icon name="alert" />
          <span className="alert-text">{state.problem ?? state.error}</span>
          {!state.problem && (
            <button className="icon-btn" title="Dismiss" onClick={() => void window.ctrl.dismissError()}>
              <Icon name="close" />
            </button>
          )}
        </div>
      )}
    </aside>
  )
}

/** px per tree level */
const CHILD_INDENT = 14

const withShortcut = (label: string, shortcut: string) => (shortcut ? `${label} (${shortcut})` : label)

function Section(props: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-header">
        <span>{props.title}</span>
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

function PagedList(props: { items: SessionItem[]; render(s: SessionItem): ReactNode }) {
  const [shown, setShown] = useState(PAGE_SIZE)
  return (
    <>
      {props.items.slice(0, shown).map(props.render)}
      {props.items.length > shown && (
        <button className="row show-more" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          <span className="label">Show more</span>
        </button>
      )}
    </>
  )
}

function FoldSection(props: {
  title: string
  collapsed: boolean
  onToggle(): void
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`section ${props.className ?? ""}`}>
      <button className="section-header toggle" onClick={props.onToggle}>
        <span>{props.title}</span>
        <Icon name={props.collapsed ? "chevron-right" : "chevron-down"} />
      </button>
      {!props.collapsed && props.children}
    </section>
  )
}

function SpaceGroup(props: {
  space: Space
  sessions: SessionItem[]
  parents: Record<string, string>
  folded: Set<string>
  renaming: boolean
  highlight: boolean
  reorder: "before" | "after" | null
  onRenamed(): void
  onStartRename(): void
  onNew(): void
  dropProps: HTMLAttributes<HTMLDivElement>
  onDragStart(e: DragEvent): void
  onDragEnd(): void
  renderSession(s: SessionItem, tree: TreeRow): ReactNode
}) {
  const { space } = props
  const open = !space.collapsed
  const rows = useMemo(
    () => (open ? sessionTree(props.sessions, props.parents, props.folded) : []),
    [open, props.sessions, props.parents, props.folded],
  )
  const rollup = open ? undefined : topStatus(props.sessions)
  const classes = ["space", props.highlight && "over", props.reorder && `drop-${props.reorder}`]
  return (
    <div className={classes.filter(Boolean).join(" ")} data-space-id={space.id} {...props.dropProps}>
      {props.renaming ? (
        <NameInput
          icon="folder"
          initial={space.name}
          onDone={(name) => {
            props.onRenamed()
            if (name && name !== space.name) void window.ctrl.renameSpace(space.id, name)
          }}
        />
      ) : (
        <div
          className="row space-header"
          draggable
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          onClick={() => void window.ctrl.toggleSpace(space.id)}
          onDoubleClick={props.onStartRename}
          onContextMenu={(e) => {
            e.preventDefault()
            void window.ctrl.showSpaceMenu(space.id)
          }}
          title={space.directory ?? "No folder set (follows Settings → Sessions → Folder)"}
        >
          <Icon name={open ? "folder-open" : "folder"} />
          <span className="label">{space.name}</span>
          {!open && rollup && (
            <span className="rollup" title={`${rollup.title}\n${statusText(rollup) ?? ""}`}>
              <StatusIcon status={rollup.status} />
            </span>
          )}
          <span className="hover-actions">
            <button
              className="icon-btn"
              title="New session in space"
              onClick={(e) => {
                e.stopPropagation()
                props.onNew()
              }}
            >
              <Icon name="plus" />
            </button>
            <button
              className="icon-btn"
              title="More"
              onClick={(e) => {
                e.stopPropagation()
                void window.ctrl.showSpaceMenu(space.id)
              }}
            >
              <Icon name="dots" />
            </button>
          </span>
        </div>
      )}
      {open && (
        <div className="space-sessions">
          {rows.map((row) => props.renderSession(row.session, row))}
          {props.sessions.length === 0 && <div className="empty indent">Drag sessions here</div>}
        </div>
      )}
    </div>
  )
}

function NameInput(props: {
  initial?: string
  placeholder?: string
  icon?: string
  indent?: boolean
  depth?: number
  onDone(name: string | null): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (value: string | null) => {
    if (done.current) return
    done.current = true
    props.onDone(value?.trim() || null)
  }
  return (
    <div
      className={`row input-row ${props.indent ? "indent" : ""}`}
      style={props.depth ? { paddingLeft: 31 + props.depth * CHILD_INDENT } : undefined}
    >
      {props.icon && <Icon name={props.icon} />}
      <input
        ref={ref}
        defaultValue={props.initial}
        placeholder={props.placeholder}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter") finish(e.currentTarget.value)
          if (e.key === "Escape") finish(null)
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}
