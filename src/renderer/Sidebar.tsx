import { useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from "react"
import { shortcutLabel } from "../shared/shortcuts"
import type { AppState, SessionItem, Space } from "../shared/types"
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
  /** sessionID → ⌘ number while ⌘ is held */
  hints: Map<string, number> | null
}

type Reorder = { id: string; pos: "before" | "after" }

export function Sidebar({ state, hints, onOpen, onNew, onSearch, onSettings, onToggleResources }: Props) {
  const [creating, setCreating] = useState(false)
  const [renamingSpace, setRenamingSpace] = useState<string | null>(null)
  const [renamingSession, setRenamingSession] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [reorder, setReorder] = useState<Reorder | null>(null)
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

  const clearDrag = () => {
    setDropTarget(null)
    setReorder(null)
    draggingSpace.current = null
  }

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

  const sessionRow = (s: SessionItem) =>
    renamingSession === s.id ? (
      <NameInput
        key={s.id}
        initial={s.title}
        indent
        onDone={(title) => {
          setRenamingSession(null)
          if (title && title !== s.title) void window.ctrl.renameSession(s.id, title)
        }}
      />
    ) : (
      <div
        key={s.id}
        data-session-id={s.id}
        className={`row session ${s.id === state.currentSessionID ? "active" : ""}`}
        draggable
        onDragStart={(e) => {
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
        title={[statusText(s), s.title, shortPath(s.directory)].filter(Boolean).join("\n")}
      >
        <span className="label">{s.title}</span>
        {hints?.has(s.id) ? (
          <kbd className="jump-hint">⌘{hints.get(s.id)}</kbd>
        ) : s.status === "idle" ? (
          <span className="meta">{age(s.updated)}</span>
        ) : (
          <StatusIcon status={s.status} />
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

      <div className="scroll">
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
            <PagedList items={grouped.recents} render={sessionRow} />
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
            <PagedList items={grouped.archived} render={sessionRow} />
          </FoldSection>
        )}
      </div>

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
  renaming: boolean
  highlight: boolean
  reorder: "before" | "after" | null
  onRenamed(): void
  onStartRename(): void
  onNew(): void
  dropProps: HTMLAttributes<HTMLDivElement>
  onDragStart(e: DragEvent): void
  onDragEnd(): void
  renderSession(s: SessionItem): ReactNode
}) {
  const { space } = props
  const open = !space.collapsed
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
          title={space.directory ?? "No folder set (sessions start in ~)"}
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
          {props.sessions.map(props.renderSession)}
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
    <div className={`row input-row ${props.indent ? "indent" : ""}`}>
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
