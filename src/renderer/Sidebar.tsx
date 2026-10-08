import { useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from "react"
import type { AppState, SessionItem, Space } from "../shared/types"
import { Icon } from "./icons"

const DRAG_TYPE = "application/x-ctrl-session"
const CHATS = "__chats__"
const CHATS_LIMIT = 40

type Props = {
  state: AppState
  onOpen(id: string): void
  onNew(spaceID: string | null): void
}

function age(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (86400 * 30))}mo`
}

export function Sidebar({ state, onOpen, onNew }: Props) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  useEffect(() => window.ctrl.onRenameSpace(setRenaming), [])

  const grouped = useMemo(() => {
    const bySpace = new Map<string, SessionItem[]>()
    const chats: SessionItem[] = []
    const valid = new Set(state.spaces.map((s) => s.id))
    for (const session of state.sessions) {
      const spaceID = state.assignments[session.id]
      if (spaceID && valid.has(spaceID)) {
        const list = bySpace.get(spaceID) ?? []
        list.push(session)
        bySpace.set(spaceID, list)
      } else chats.push(session)
    }
    return { bySpace, chats }
  }, [state.sessions, state.assignments, state.spaces])

  const dropProps = (key: string, spaceID: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "move"
      if (dropTarget !== key) setDropTarget(key)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((t) => (t === key ? null : t))
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setDropTarget(null)
      const id = e.dataTransfer.getData(DRAG_TYPE)
      if (id) void window.ctrl.moveSession(id, spaceID)
    },
  })

  const sessionRow = (s: SessionItem) => (
    <div
      key={s.id}
      className={`row session ${s.id === state.currentSessionID ? "active" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, s.id)
        e.dataTransfer.effectAllowed = "move"
      }}
      onDragEnd={() => setDropTarget(null)}
      onClick={() => onOpen(s.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        void window.ctrl.showSessionMenu(s.id)
      }}
      title={`${s.title}\n${s.directory}`}
    >
      <span className="label">{s.title}</span>
      {s.running ? <span className="spinner" /> : <span className="meta">{age(s.updated)}</span>}
    </div>
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <div className="brand">ctrl</div>

      <button className="row action" onClick={() => onNew(null)}>
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
          {state.spaces.map((space) => (
            <SpaceGroup
              key={space.id}
              space={space}
              sessions={grouped.bySpace.get(space.id) ?? []}
              renaming={renaming === space.id}
              onRenamed={() => setRenaming(null)}
              onStartRename={() => setRenaming(space.id)}
              onNew={() => onNew(space.id)}
              highlight={dropTarget === space.id}
              dropProps={dropProps(space.id, space.id)}
              renderSession={sessionRow}
            />
          ))}
        </Section>

        <div className={`drop-zone ${dropTarget === CHATS ? "over" : ""}`} {...dropProps(CHATS, null)}>
          <Section title="Chats">
            {grouped.chats.slice(0, CHATS_LIMIT).map(sessionRow)}
            {grouped.chats.length === 0 && <div className="empty">Drop a session here to remove it from its space</div>}
          </Section>
        </div>
      </div>
    </aside>
  )
}

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

function SpaceGroup(props: {
  space: Space
  sessions: SessionItem[]
  renaming: boolean
  highlight: boolean
  onRenamed(): void
  onStartRename(): void
  onNew(): void
  dropProps: HTMLAttributes<HTMLDivElement>
  renderSession(s: SessionItem): ReactNode
}) {
  const { space } = props
  const open = !space.collapsed
  return (
    <div className={`space ${props.highlight ? "over" : ""}`} {...props.dropProps}>
      {props.renaming ? (
        <NameInput
          initial={space.name}
          onDone={(name) => {
            props.onRenamed()
            if (name && name !== space.name) void window.ctrl.renameSpace(space.id, name)
          }}
        />
      ) : (
        <div
          className="row space-header"
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

function NameInput(props: { initial?: string; placeholder?: string; onDone(name: string | null): void }) {
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
    <div className="row input-row">
      <Icon name="folder" />
      <input
        ref={ref}
        defaultValue={props.initial}
        placeholder={props.placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(e.currentTarget.value)
          if (e.key === "Escape") finish(null)
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}
