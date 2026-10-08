import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import type { ModelChoices, ModelOption, ModelRef } from "../shared/types"
import { Icon } from "./icons"

const keyOf = (m: ModelRef) => `${m.providerID}::${m.id}`

type Props = {
  choices: ModelChoices | null
  error?: string
  value: ModelRef | null
  onChange(model: ModelRef): void
  /** Off: the picker is greyed out and shows `fallback`, what applies instead */
  enabled: boolean
  fallback: { label: string; detail: string }
}

type Row =
  | { kind: "provider"; key: string; label: string; count: number }
  | { kind: "vendor"; key: string; label: string }
  | { kind: "model"; key: string; model: ModelOption }

export function ModelPicker({ choices, error, value, onChange, enabled, fallback }: Props) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = value && choices?.models.find((m) => keyOf(m) === keyOf(value))

  return (
    <>
      <button
        ref={trigger}
        className={`model-trigger ${open ? "open" : ""}`}
        disabled={!enabled || !choices}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-trigger-text">
          {!choices ? (
            <span className="model-trigger-name muted">{error ? "Couldn't load models" : "Loading models…"}</span>
          ) : enabled && value ? (
            <>
              <span className="model-trigger-name">{current?.name ?? value.id}</span>
              <span className="model-trigger-provider">
                {current ? current.providerName : `${value.providerID} · unavailable`}
              </span>
            </>
          ) : (
            <>
              <span className="model-trigger-name">{enabled ? "Choose a model…" : fallback.label}</span>
              <span className="model-trigger-provider">{enabled ? "Pick one from the list" : fallback.detail}</span>
            </>
          )}
        </span>
        <Icon name="chevron-down" />
      </button>
      {open && enabled && choices && (
        <Popover
          anchor={trigger.current!}
          choices={choices}
          value={value}
          onPick={(m) => {
            setOpen(false)
            // Keep the variant when the new model has one with the same name.
            const next = choices.models.find((x) => keyOf(x) === keyOf(m))
            const variant = value?.variant && next?.variants.includes(value.variant) ? value.variant : undefined
            onChange(variant ? { ...m, variant } : m)
            trigger.current?.focus()
          }}
          onClose={() => {
            setOpen(false)
            trigger.current?.focus()
          }}
        />
      )}
      {enabled && value && current && current.variants.length > 0 && (
        <div className="model-variant">
          <span className="model-variant-label">Variant</span>
          <div className="segmented">
            {[undefined, ...current.variants].map((v) => (
              <button
                key={v ?? ""}
                className={(value.variant ?? undefined) === v ? "on" : ""}
                title={v ? undefined : "The model's default variant"}
                onClick={() => onChange({ providerID: value.providerID, id: value.id, ...(v ? { variant: v } : {}) })}
              >
                {v ?? "Default"}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function matches(m: ModelOption, terms: string[]) {
  const hay = `${m.name} ${m.id} ${m.providerName} ${m.providerID}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

function Popover({
  anchor,
  choices,
  value,
  onPick,
  onClose,
}: {
  anchor: HTMLElement
  choices: ModelChoices
  value: ModelRef | null
  onPick(m: ModelRef): void
  onClose(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [provider, setProvider] = useState<string | null>(null)
  const selectedKey = value ? keyOf(value) : ""
  const [active, setActive] = useState(selectedKey)

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = useMemo(
    () => choices.models.filter((m) => (!provider || m.providerID === provider) && matches(m, terms)),
    [choices, provider, query],
  )

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const m of choices.models) if (matches(m, terms)) c.set(m.providerID, (c.get(m.providerID) ?? 0) + 1)
    return c
  }, [choices, query])

  const rows = useMemo(() => {
    const out: Row[] = []
    let lastProvider = ""
    let lastVendor = ""
    for (const m of filtered) {
      if (m.providerID !== lastProvider) {
        lastProvider = m.providerID
        lastVendor = ""
        out.push({
          kind: "provider",
          key: `p:${m.providerID}`,
          label: m.providerName,
          count: counts.get(m.providerID) ?? 0,
        })
      }
      if (m.vendor && m.vendor !== lastVendor) {
        lastVendor = m.vendor
        out.push({ kind: "vendor", key: `v:${m.providerID}:${m.vendor}`, label: m.vendor })
      }
      out.push({ kind: "model", key: keyOf(m), model: m })
    }
    return out
  }, [filtered, counts, provider, query])

  const pickable = rows.filter((r) => r.kind === "model")

  // Keep the highlight on a visible row as the filter changes.
  useEffect(() => {
    if (!pickable.some((r) => r.key === active)) setActive(pickable[0]?.key ?? "")
  }, [rows])


  // Position under the trigger (or above it when there's no room), right-aligned.
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 16
      const above = r.top - 16
      const up = below < 320 && above > below
      const width = Math.min(Math.max(r.width, 380), 560, window.innerWidth - 24)
      const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12))
      setStyle({
        left,
        width,
        maxHeight: Math.min(480, up ? above : below),
        ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      })
    }
    place()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [anchor])

  // Once placed (hidden elements can't take focus or scroll): focus search, center the current model.
  const placed = style.visibility !== "hidden"
  useEffect(() => {
    if (!placed) return
    input.current?.focus()
    list.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(selectedKey)}"]`)
      ?.scrollIntoView({ block: "center" })
  }, [placed])

  useEffect(() => {
    if (!placed) return
    list.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [active])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!root.current?.contains(t) && !anchor.contains(t)) onClose()
    }
    // The settings page scrolling would leave the popover floating in the wrong spot.
    const scroll = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", down)
    document.addEventListener("scroll", scroll, true)
    window.addEventListener("blur", onClose)
    return () => {
      document.removeEventListener("mousedown", down)
      document.removeEventListener("scroll", scroll, true)
      window.removeEventListener("blur", onClose)
    }
  }, [anchor, onClose])

  const pick = (key: string) => {
    const m = choices.models.find((x) => keyOf(x) === key)
    if (m) onPick({ providerID: m.providerID, id: m.id })
  }

  const move = (delta: number) => {
    if (!pickable.length) return
    const i = pickable.findIndex((r) => r.key === active)
    const next = Math.max(0, Math.min(pickable.length - 1, (i === -1 ? -1 : i) + delta))
    setActive(pickable[next].key)
  }

  const tabs = [{ id: null as string | null, name: "All", count: [...counts.values()].reduce((a, b) => a + b, 0) }]
  for (const p of choices.providers) tabs.push({ id: p.id, name: p.name, count: counts.get(p.id) ?? 0 })

  return (
    <div
      ref={root}
      className="model-popover"
      style={style}
      onKeyDown={(e) => {
        // Don't let Esc/arrows reach the settings page behind us.
        e.stopPropagation()
        if (e.key === "Escape") onClose()
        else if (e.key === "ArrowDown") (e.preventDefault(), move(1))
        else if (e.key === "ArrowUp") (e.preventDefault(), move(-1))
        else if (e.key === "PageDown") (e.preventDefault(), move(8))
        else if (e.key === "PageUp") (e.preventDefault(), move(-8))
        else if (e.key === "Enter") (e.preventDefault(), active && pick(active))
        else if (e.key === "Tab") {
          e.preventDefault()
          const i = tabs.findIndex((t) => t.id === provider)
          setProvider(tabs[(i + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length].id)
        }
      }}
    >
      <div className="model-search">
        <Icon name="search" />
        <input
          ref={input}
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <button className="icon-btn" title="Clear" onClick={() => setQuery("")}>
            <Icon name="close" />
          </button>
        )}
      </div>

      <div className="model-tabs">
        {tabs.map((t) => (
          <button
            key={t.id ?? "all"}
            className={`model-tab ${provider === t.id ? "on" : ""}`}
            disabled={t.count === 0 && provider !== t.id}
            onClick={() => setProvider(t.id)}
          >
            {t.name}
            <span className="model-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="model-list" ref={list}>
        {pickable.length === 0 && <div className="model-empty">No models match “{query}”</div>}
        {rows.map((r) => {
          if (r.kind === "provider")
            return (
              <div key={r.key} className="model-group">
                {r.label}
                <span>{r.count}</span>
              </div>
            )
          if (r.kind === "vendor")
            return (
              <div key={r.key} className="model-vendor">
                {r.label}
              </div>
            )
          const selected = r.key === selectedKey
          return (
            <div
              key={r.key}
              data-key={r.key}
              className={`model-row ${r.key === active ? "active" : ""} ${selected ? "selected" : ""}`}
              onMouseMove={() => r.key !== active && setActive(r.key)}
              onClick={() => pick(r.key)}
            >
              <span className="model-check">{selected && <Icon name="check" />}</span>
              <span className="model-name">{r.model.name}</span>
              <span className="model-id">{r.model.vendor ? r.model.id.slice(r.model.vendor.length + 1) : r.model.id}</span>
            </div>
          )
        })}
      </div>

      <div className="model-footer">
        <span>
          <kbd>↑↓</kbd> navigate
        </span>
        <span>
          <kbd>↵</kbd> select
        </span>
        <span>
          <kbd>tab</kbd> provider
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  )
}
