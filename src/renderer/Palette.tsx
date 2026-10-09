import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { shortcutLabel } from "../shared/shortcuts"
import type { AppState, IndexStatus, SearchHit } from "../shared/types"
import { Icon } from "./icons"
import { shortPath } from "./format"
import { StatusIcon } from "./StatusIcon"

type Item = {
  key: string
  section: "Chats" | "Messages" | "Spaces" | "Quick actions"
  icon?: ReactNode
  label: string
  /** Second line, e.g. the matching excerpt of a message */
  detail?: ReactNode
  hint?: string
  shortcut?: string
  run(): void
}

type Props = {
  state: AppState
  onClose(): void
  onOpen(sessionID: string): void
  onNew(spaceID: string | null): void
  onRevealSpace(spaceID: string): void
}

const RECENT_LIMIT = 9
const SEARCH_LIMIT = 50
/** While the index is filling up, re-run the query so new matches appear. */
const INDEXING_POLL_MS = 1000

/** Snippet with \uE000…\uE001 match markers → text with <mark>s. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split("\uE000").map((part, i) => {
        if (i === 0) return part
        const [hit, rest = ""] = part.split("\uE001")
        return (
          <span key={i}>
            <mark>{hit}</mark>
            {rest}
          </span>
        )
      })}
    </>
  )
}

/** Message hits for the query; null query clears them. Stale responses are dropped. */
function useMessageSearch(query: string) {
  const [hits, setHits] = useState<SearchHit[]>([])
  const [status, setStatus] = useState<IndexStatus | null>(null)
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      return
    }
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () =>
      window.ctrl.search(q).then((res) => {
        if (!live) return
        setHits(res.hits)
        setStatus(res.status)
        if (res.status.indexing) timer = setTimeout(run, INDEXING_POLL_MS)
      })
    void run()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])
  return { hits, status }
}

function matches(query: string, ...fields: (string | undefined)[]) {
  const hay = fields.filter(Boolean).join(" ").toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token))
}

export function Palette({ state, onClose, onOpen, onNew, onRevealSpace }: Props) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => input.current?.focus(), [])
  const { hits, status } = useMessageSearch(query)

  const items = useMemo(() => {
    const q = query.trim()
    const spaceName = new Map(state.spaces.map((s) => [s.id, s.name]))
    const out: Item[] = []

    // Archived sessions only surface when explicitly searched for, and rank last.
    const sessions = q
      ? state.sessions
          .filter((s) => matches(q, s.title, spaceName.get(state.assignments[s.id]), shortPath(s.directory)))
          .sort((a, b) => Number(!!state.archived[a.id]) - Number(!!state.archived[b.id]))
          .slice(0, SEARCH_LIMIT)
      : state.sessions.filter((s) => !state.archived[s.id]).slice(0, RECENT_LIMIT)
    sessions.forEach((s, i) => {
      out.push({
        key: `s:${s.id}`,
        section: "Chats",
        icon: <StatusIcon status={s.status} />,
        label: s.title,
        hint: state.archived[s.id]
          ? "Archived"
          : (spaceName.get(state.assignments[s.id]) ?? shortPath(s.directory).split("/").pop()),
        shortcut: i < 9 ? `^${i + 1}` : undefined,
        run: () => onOpen(s.id),
      })
    })

    if (q) {
      const shown = new Set(sessions.map((s) => s.id))
      const live = new Map(state.sessions.map((s) => [s.id, s]))
      const ranked = hits
        .filter((h) => !shown.has(h.sessionID))
        .sort((a, b) => Number(!!state.archived[a.sessionID]) - Number(!!state.archived[b.sessionID]))
      for (const hit of ranked) {
        const session = live.get(hit.sessionID)
        out.push({
          key: `m:${hit.sessionID}`,
          section: "Messages",
          icon: session ? <StatusIcon status={session.status} /> : undefined,
          label: session?.title ?? hit.title,
          detail: (
            <>
              {hit.role === "user" && <span className="palette-detail-role">You: </span>}
              <Snippet text={hit.snippet} />
            </>
          ),
          hint: state.archived[hit.sessionID]
            ? "Archived"
            : (spaceName.get(state.assignments[hit.sessionID]) ??
              (session ? shortPath(session.directory).split("/").pop() : undefined)),
          run: () => onOpen(hit.sessionID),
        })
      }

      for (const space of state.spaces.filter((s) => matches(q, s.name, s.directory))) {
        const count = state.sessions.filter(
          (s) => state.assignments[s.id] === space.id && !state.archived[s.id],
        ).length
        out.push({
          key: `p:${space.id}`,
          section: "Spaces",
          icon: <Icon name="folder" />,
          label: space.name,
          hint: `${count} session${count === 1 ? "" : "s"}`,
          run: () => onRevealSpace(space.id),
        })
      }
    }

    const actions: Item[] = [
      { key: "a:new", section: "Quick actions", icon: <Icon name="compose" />, label: "New chat", shortcut: shortcutLabel("new-chat", state.settings.shortcuts) || undefined, run: () => onNew(null) },
    ]
    if (q && !state.spaces.some((s) => s.name.toLowerCase() === q.toLowerCase())) {
      actions.push({
        key: "a:space",
        section: "Quick actions",
        icon: <Icon name="folder-open" />,
        label: `Create space “${q}”`,
        run: () => void window.ctrl.createSpace(q),
      })
    }
    out.push(...actions.filter((a) => a.key === "a:space" || !q || matches(q, a.label)))
    return out
  }, [query, hits, state, onOpen, onNew, onRevealSpace])

  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    list.current?.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" })
  }, [selected])

  const run = (item: Item | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      run(items[selected])
    } else if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      run(items.filter((i) => i.section === "Chats")[Number(e.key) - 1])
    }
  }

  let lastSection = ""
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={input}
          className="palette-input"
          placeholder="Search chats and spaces"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette-list" ref={list}>
          {items.length === 0 && <div className="palette-empty">No results</div>}
          {items.map((item, index) => {
            const header = item.section !== lastSection
            lastSection = item.section
            return (
              <div key={item.key}>
                {header && <div className="palette-section">{item.section}</div>}
                <div
                  className={`palette-item ${index === selected ? "selected" : ""}`}
                  onMouseMove={() => index !== selected && setSelected(index)}
                  onClick={() => run(item)}
                >
                  <span className="palette-icon">{item.icon}</span>
                  {item.detail ? (
                    <span className="palette-text">
                      <span className="palette-label">{item.label}</span>
                      <span className="palette-detail">{item.detail}</span>
                    </span>
                  ) : (
                    <span className="palette-label">{item.label}</span>
                  )}
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {item.shortcut && <kbd>{item.shortcut}</kbd>}
                </div>
              </div>
            )
          })}
        </div>
        {query.trim().length >= 2 && status?.indexing && (
          <div className="palette-footer">
            Indexing messages… {status.done}/{status.total}
          </div>
        )}
      </div>
    </div>
  )
}
