import { useEffect, useState } from "react"
import type { DetectedTool } from "../shared/types"
import { Icon } from "./icons"

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Runs detection and lists what it found that you don't watch yet, all checked, to add. Ones you
 * already watch show as such, without a checkbox: a scan only adds, Remove on a row stops watching.
 * Used by onboarding and Settings → Tools.
 */
export function ToolScan({
  cta = "Watch",
  onDone,
  onCancel,
}: {
  cta?: string
  onDone(): void
  onCancel?(): void
}) {
  const [found, setFound] = useState<DetectedTool[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.ctrl.scanTools().then(
      (items) => {
        if (!live) return
        setFound(items)
        setChecked(new Set(items.filter((t) => !t.watched).map((t) => t.key)))
      },
      (err) => live && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [])

  const apply = () => {
    setBusy(true)
    void window.ctrl
      .applyToolScan([...checked])
      .then(onDone, (err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  if (error) return <div className="tool-scan setting-desc mcp-error">Couldn't scan: {error}</div>
  if (!found) return <div className="tool-scan setting-desc">Looking at your harnesses and CLIs…</div>

  const fresh = found.filter((t) => !t.watched)
  const picked = fresh.filter((t) => checked.has(t.key))
  const setAll = (keys: string[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      for (const key of keys) on ? next.add(key) : next.delete(key)
      return next
    })

  const groups = [
    { label: "MCP servers", items: found.filter((t) => t.kind === "mcp") },
    { label: "CLIs", items: found.filter((t) => t.kind === "cli") },
  ].filter((g) => g.items.length)

  const freshMcp = fresh.filter((t) => t.kind === "mcp").length
  const freshCli = fresh.length - freshMcp
  const title =
    found.length === 0
      ? "Found no MCP servers or CLIs to watch"
      : fresh.length === 0
        ? "Nothing new: you already watch everything it found"
        : `Found ${[freshMcp && count(freshMcp, "MCP server", "MCP servers"), freshCli && count(freshCli, "CLI", "CLIs")].filter(Boolean).join(" and ")} to watch`

  return (
    <div className="tool-scan">
      <div className="tool-scan-summary">
        <Icon name="check" />
        <div>
          <div className="setting-title">{title}</div>
          {found.length === 0 && <div className="setting-desc">You can add a CLI by hand.</div>}
        </div>
      </div>
      {groups.length > 0 && (
        <div className="tool-scan-list">
          {groups.map(({ label, items }) => {
            const add = items.filter((t) => !t.watched)
            const watched = items.filter((t) => t.watched)
            const allOn = add.every((t) => checked.has(t.key))
            return (
              <div key={label}>
                <div className="tool-scan-group">
                  <span>{label}</span>
                  {add.length > 1 && (
                    <button className="text-btn" onClick={() => setAll(add.map((t) => t.key), !allOn)}>
                      {allOn ? "Select none" : "Select all"}
                    </button>
                  )}
                </div>
                {add.map((t) => (
                  <label key={t.key} className="tool-scan-item">
                    <input type="checkbox" checked={checked.has(t.key)} onChange={() => setAll([t.key], !checked.has(t.key))} />
                    <span className="setting-title">{t.name}</span>
                    <span className="setting-desc" title={t.description}>
                      {t.description}
                    </span>
                  </label>
                ))}
                {watched.map((t) => (
                  <div key={t.key} className="tool-scan-item watched">
                    <Icon name="check" />
                    <span className="setting-title">{t.name}</span>
                    <span className="setting-desc">Already watching</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
      <div className="setting-actions tool-scan-actions">
        {onCancel && fresh.length > 0 && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={busy || (picked.length === 0 && fresh.length > 0 && !!onCancel)} onClick={apply}>
          {fresh.length === 0
            ? onCancel
              ? "Done"
              : "Continue"
            : picked.length === 0
              ? "Skip"
              : picked.length === fresh.length && fresh.length > 1
                ? `${cta} all ${fresh.length}`
                : `${cta} ${picked.length}`}
        </button>
      </div>
    </div>
  )
}
