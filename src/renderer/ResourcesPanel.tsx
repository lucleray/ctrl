import { useEffect, useMemo, useState } from "react"
import { RESOURCE_TYPES, resourceType } from "../shared/adapters"
import type { AdapterInfo, AppState, Harness, ResourceItem, ResourceMeta } from "../shared/types"
import { harnessOf } from "../shared/types"
import { age, shortPath } from "./format"
import { Icon } from "./icons"
import { RESOURCE_DRAG, type ResourceDrag, sessionMention } from "./ReferenceDrop"
import { usePanelWidth } from "./ResizeHandle"

const PAGE_SIZE = 8
const DOCKED_MIN = 240
const DOCKED_MAX = 560
const DOCKED_DEFAULT = 300

/**
 * Resources of the current session's scope, refetched when the indexer reports
 * changes in it. While shown unfolded, main keeps their live details fresh and pushes them.
 */
function useResources(sessionIDs: string[], watching: boolean) {
  const [items, setItems] = useState<ResourceItem[]>([])
  const key = sessionIDs.join(",")
  useEffect(() => {
    let live = true
    const ids = key ? key.split(",") : []
    const load = () => void window.ctrl.listResources(ids).then((r) => live && setItems(r))
    load()
    const inScope = new Set(ids)
    const offChanged = window.ctrl.onResourcesChanged((changed) => {
      if (!changed || changed.some((id) => inScope.has(id))) load()
    })
    const offMeta = window.ctrl.onResourceMeta((metas) =>
      setItems((prev) => (prev.some((i) => metas[i.id]) ? prev.map((i) => (metas[i.id] ? { ...i, meta: metas[i.id] } : i)) : prev)),
    )
    return () => {
      live = false
      offChanged()
      offMeta()
    }
  }, [key])
  // Folded, the pill only needs the count: no live fetches for links nobody sees.
  useEffect(() => {
    if (!watching) return
    window.ctrl.watchResources(key ? key.split(",") : [])
    return () => window.ctrl.watchResources([])
  }, [key, watching])
  return items
}

export function ResourcesPanel({ state, onClose }: { state: AppState; onClose(): void }) {
  const current = state.currentSessionID
  const space = current ? state.spaces.find((s) => s.id === state.assignments[current]) : undefined
  const scope = space ? state.ui.resourcesScope : "session"

  const sessionIDs = useMemo(() => {
    if (!current) return []
    if (scope === "session" || !space) return [current]
    return Object.keys(state.assignments).filter((id) => state.assignments[id] === space.id)
  }, [current, scope, space, state.assignments])

  const collapsed = state.ui.resourcesCollapsed
  const docked = state.ui.resourcesDocked
  const { width, handle } = usePanelWidth(state.ui.resourcesWidth, {
    key: "resourcesWidth",
    min: DOCKED_MIN,
    max: DOCKED_MAX,
    initial: DOCKED_DEFAULT,
    edge: "left",
  })
  const fetched = useResources(sessionIDs, !collapsed)
  // Referenced sessions get their title and state from the sidebar's list, so renames, archiving
  // and deletes show up without reindexing. Archiving only hides a session: the reference stays.
  const items = useMemo(() => {
    const byID = new Map(state.sessions.map((s) => [s.id, s]))
    const spaceName = new Map(state.spaces.map((s) => [s.id, s.name]))
    return fetched
      .filter((i) => i.type !== "session" || i.data.id !== current)
      .map((i) => (i.type === "session" ? { ...i, meta: sessionMeta(i, state, byID.get(i.data.id), spaceName) } : i))
  }, [fetched, current, state])
  const target = current ? harnessOf(current) : "opencode"
  const groups = useMemo(
    () =>
      RESOURCE_TYPES.map((type) => ({ type, items: items.filter((i) => i.type === type.id) })).filter(
        (g) => g.items.length,
      ),
    [items],
  )

  return (
    <aside
      className={`resources${collapsed ? " collapsed" : ""}${docked ? " docked" : ""}`}
      style={docked && !collapsed ? { width } : undefined}
    >
      {docked && <div className="resources-drag" />}
      {docked && !collapsed && handle}
      <div className="resources-header">
        <button
          className="resources-toggle"
          title={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
          onClick={() => void window.ctrl.setUi({ resourcesCollapsed: !collapsed })}
        >
          <Icon name={docked ? (collapsed ? "chevron-left" : "chevron-right") : collapsed ? "chevron-right" : "chevron-down"} />
          <span>Resources</span>
          {collapsed && items.length > 0 && <span className="count">{items.length}</span>}
        </button>
        <span className="resources-actions">
          <button
            className="icon-btn"
            title={docked ? "Float over the terminal" : "Dock to the right"}
            onClick={() => void window.ctrl.setUi({ resourcesDocked: !docked })}
          >
            <Icon name={docked ? "panel-float" : "panel-right"} />
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </span>
      </div>
      {space && (
        <div className="segmented">
          {(["session", "space"] as const).map((s) => (
            <button
              key={s}
              className={scope === s ? "on" : ""}
              title={s === "space" ? `Every session in ${space.name}` : undefined}
              onClick={() => void window.ctrl.setUi({ resourcesScope: s })}
            >
              {s === "session" ? "This session" : "This space"}
            </button>
          ))}
        </div>
      )}
      <div className="scroll">
        {!current ? (
          <div className="empty">Open a session to see the links shared in it.</div>
        ) : groups.length === 0 ? (
          <div className="empty">
            No links yet. Referenced sessions, PRs, repos, Notion docs, Slack threads, Linear issues and Vercel deployments shared in this{" "}
            {scope === "space" ? "space" : "session"} show up here.
          </div>
        ) : (
          groups.map((g) => (
            <ResourceGroup
              key={g.type.id}
              label={g.type.label}
              items={g.items}
              source={state.adapters.find((a) => a.mode === "live" && a.types.includes(g.type.id))}
              spaceScope={scope === "space"}
              target={target}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function sessionMeta(
  item: ResourceItem,
  state: AppState,
  session: AppState["sessions"][number] | undefined,
  spaceName: Map<string, string>,
): ResourceMeta {
  const fx = harnessOf(item.data.id) === "fx"
  if (!session)
    return {
      subtitle: "No longer in ctrl's session list",
      tone: "muted",
      chips: [{ text: "deleted", tone: "bad" }, ...(fx ? [{ text: "fx", tone: "muted" as const }] : [])],
      details: ["Deleted, or not loaded yet"],
      fetched: Date.now(),
    }
  const space = spaceName.get(state.assignments[session.id] ?? "")
  const archived = state.archived[session.id]
  const status = (
    {
      "needs-input": { text: "needs you", tone: "warn" },
      running: { text: "running", tone: "open" },
      failed: { text: "failed", tone: "bad" },
    } as const
  )[session.status as "needs-input" | "running" | "failed"]
  return {
    title: session.title,
    subtitle: space ? `${space} · ${shortPath(session.directory)}` : shortPath(session.directory),
    tone: archived ? "muted" : status?.tone,
    chips: [
      ...(archived ? [{ text: "archived", tone: "muted" as const, title: `Archived ${age(archived)} ago` }] : []),
      ...(status ? [status] : []),
      ...(fx ? [{ text: "fx", tone: "muted" as const }] : []),
    ],
    fetched: session.updated,
  }
}

function ResourceGroup(props: {
  label: string
  items: ResourceItem[]
  source?: AdapterInfo
  spaceScope: boolean
  target: Harness
}) {
  const [shown, setShown] = useState(PAGE_SIZE)
  return (
    <section className="section">
      <div className="section-header">
        <span>{props.label}</span>
        <span className="count">{props.items.length}</span>
      </div>
      {props.items.slice(0, shown).map((item) => (
        <ResourceRow
          key={item.id}
          item={item}
          source={props.source}
          spaceScope={props.spaceScope}
          target={props.target}
        />
      ))}
      {props.items.length > shown && (
        <button className="row show-more" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          <span className="label">Show more</span>
        </button>
      )}
    </section>
  )
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return undefined
  }
}

function metaTooltip(meta: ResourceMeta | undefined, source: AdapterInfo | undefined) {
  if (!meta || !source) return []
  if (meta.missing) return [`Not found, or ${source.cli?.command ?? source.name}'s account can't see it`]
  return [...(meta.details ?? []), `Updated from ${source.name} ${age(meta.fetched)} ago`]
}

function ResourceRow(props: { item: ResourceItem; source?: AdapterInfo; spaceScope: boolean; target: Harness }) {
  const { item, source, spaceScope } = props
  const isSession = item.type === "session"
  const deleted = isSession && item.meta?.chips?.some((c) => c.text === "deleted")
  const type = resourceType(item.type)
  const meta = item.meta?.missing ? undefined : item.meta
  const parsed = type?.describe(item.data) ?? { title: item.url }
  const title = meta?.title ?? parsed.title
  // Every row has a second line, so rows keep their height when live details arrive.
  const subtitle = meta?.subtitle ?? parsed.subtitle ?? hostOf(item.url)
  const [copied, setCopied] = useState(false)
  const where = spaceScope && item.sessions > 1 ? ` in ${item.sessions} sessions` : ""
  const tooltip = [
    isSession ? `${title}\n${item.data.id}` : meta?.title ? `${title}\n${item.url}` : item.url,
    ...(isSession ? (meta?.details ?? []) : metaTooltip(item.meta, source)),
    `Mentioned ${item.mentions}×${where}, last ${age(item.last)} ago${item.sharedByYou ? " · shared by you" : ""}`,
  ].join("\n")

  const text = isSession ? sessionMention({ id: item.data.id, title }, props.target) : item.url

  return (
    <div
      className="row resource"
      title={tooltip}
      draggable
      onDragStart={(e) => {
        const drag: ResourceDrag = { text, session: isSession }
        e.dataTransfer.setData(RESOURCE_DRAG, JSON.stringify(drag))
        e.dataTransfer.setData("text/plain", text)
        e.dataTransfer.effectAllowed = "copy"
      }}
      onClick={() => {
        if (!isSession) void window.ctrl.openExternal(item.url)
        else if (!deleted) void window.ctrl.openSession(item.data.id)
      }}
    >
      <span className={`resource-icon${meta?.tone ? ` tone-${meta.tone}` : ""}`}>
        <Icon name={type?.icon ?? "link"} />
      </span>
      <span className="resource-text">
        <span className="label">{title}</span>
        <span className="resource-subtitle">
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
        </span>
      </span>
      <span className="meta">{age(item.last)}</span>
      <button
        className="icon-btn row-action"
        title={copied ? "Copied" : isSession ? "Copy reference" : "Copy link"}
        onClick={(e) => {
          e.stopPropagation()
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  )
}
