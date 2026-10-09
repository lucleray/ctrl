import { useEffect, useMemo, useState } from "react"
import { RESOURCE_TYPES, resourceType } from "../shared/resources"
import type { AdapterInfo, AppState, ResourceItem, ResourceMeta } from "../shared/types"
import { age } from "./format"
import { Icon } from "./icons"

const PAGE_SIZE = 8

/**
 * Resources of the current session's scope, refetched when the indexer reports
 * changes in it. While shown, main keeps their live details fresh and pushes them.
 */
function useResources(sessionIDs: string[]) {
  const [items, setItems] = useState<ResourceItem[]>([])
  const key = sessionIDs.join(",")
  useEffect(() => {
    let live = true
    const ids = key ? key.split(",") : []
    const load = () => void window.ctrl.listResources(ids).then((r) => live && setItems(r))
    load()
    window.ctrl.watchResources(ids)
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
      window.ctrl.watchResources([])
    }
  }, [key])
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

  const items = useResources(sessionIDs)
  const groups = useMemo(
    () =>
      RESOURCE_TYPES.map((type) => ({ type, items: items.filter((i) => i.type === type.id) })).filter(
        (g) => g.items.length,
      ),
    [items],
  )

  return (
    <aside className="resources">
      <div className="resources-header">
        <span>Resources</span>
        <button className="icon-btn" title="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
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
            No links yet. PRs, repos, Notion docs, Slack threads, Linear issues and Vercel deployments shared in this{" "}
            {scope === "space" ? "space" : "session"} show up here.
          </div>
        ) : (
          groups.map((g) => (
            <ResourceGroup
              key={g.type.id}
              label={g.type.label}
              items={g.items}
              source={state.adapters.find((a) => a.enabled && a.types.includes(g.type.id))}
              spaceScope={scope === "space"}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function ResourceGroup(props: { label: string; items: ResourceItem[]; source?: AdapterInfo; spaceScope: boolean }) {
  const [shown, setShown] = useState(PAGE_SIZE)
  return (
    <section className="section">
      <div className="section-header">
        <span>{props.label}</span>
        <span className="count">{props.items.length}</span>
      </div>
      {props.items.slice(0, shown).map((item) => (
        <ResourceRow key={item.id} item={item} source={props.source} spaceScope={props.spaceScope} />
      ))}
      {props.items.length > shown && (
        <button className="row show-more" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          <span className="label">Show more</span>
        </button>
      )}
    </section>
  )
}

function metaTooltip(meta: ResourceMeta | undefined, source: AdapterInfo | undefined) {
  if (!meta || !source) return []
  if (meta.missing) return [`Not found, or ${source.cli.command}'s account can't see it`]
  return [...(meta.details ?? []), `Updated from ${source.name} ${age(meta.fetched)} ago`]
}

function ResourceRow({ item, source, spaceScope }: { item: ResourceItem; source?: AdapterInfo; spaceScope: boolean }) {
  const type = resourceType(item.type)
  const meta = item.meta?.missing ? undefined : item.meta
  const parsed = type?.describe(item.data) ?? { title: item.url }
  const title = meta?.title ?? parsed.title
  const subtitle = meta?.subtitle ?? parsed.subtitle
  const [copied, setCopied] = useState(false)
  const where = spaceScope && item.sessions > 1 ? ` in ${item.sessions} sessions` : ""
  const tooltip = [
    meta?.title ? `${title}\n${item.url}` : item.url,
    ...metaTooltip(item.meta, source),
    `Mentioned ${item.mentions}×${where}, last ${age(item.last)} ago${item.sharedByYou ? " · shared by you" : ""}`,
  ].join("\n")

  return (
    <div className="row resource" title={tooltip} onClick={() => void window.ctrl.openExternal(item.url)}>
      <span className={`resource-icon${meta?.tone ? ` tone-${meta.tone}` : ""}`}>
        <Icon name={type?.icon ?? "link"} />
      </span>
      <span className="resource-text">
        <span className="label">{title}</span>
        {(subtitle || meta?.chips?.length) && (
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
        )}
      </span>
      <span className="meta">{age(item.last)}</span>
      <button
        className="icon-btn row-action"
        title={copied ? "Copied" : "Copy link"}
        onClick={(e) => {
          e.stopPropagation()
          void navigator.clipboard.writeText(item.url).then(() => {
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
