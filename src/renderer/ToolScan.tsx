import { useEffect, useState } from "react"
import type { DetectedTool } from "../shared/types"
import { Icon } from "./icons"

const names = (items: DetectedTool[], max = 6) =>
  items.length > max
    ? `${items.slice(0, max).map((t) => t.name).join(", ")} and ${items.length - max} more`
    : items.map((t) => t.name).join(", ")

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Runs detection and shows what it found, everything checked: one line per kind, with Customize to
 * uncheck some. Stateless like the scan itself: running it again finds and checks the same things.
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
  const [customize, setCustomize] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.ctrl.scanTools().then(
      (items) => {
        if (!live) return
        setFound(items)
        setChecked(new Set(items.map((t) => t.key)))
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

  const mcp = found.filter((t) => t.kind === "mcp")
  const cli = found.filter((t) => t.kind === "cli")
  const picked = found.filter((t) => checked.has(t.key))
  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="tool-scan">
      {found.length === 0 ? (
        <div className="setting-desc">Found no MCP servers or CLIs to watch. You can add a CLI by hand.</div>
      ) : (
        <>
          <div className="tool-scan-summary">
            <Icon name="check" />
            <div>
              <div className="setting-title">
                Found {[mcp.length && count(mcp.length, "MCP server", "MCP servers"), cli.length && count(cli.length, "CLI", "CLIs")].filter(Boolean).join(" and ")}
              </div>
              {mcp.length > 0 && <div className="setting-desc">{names(mcp)}</div>}
              {cli.length > 0 && <div className="setting-desc">{names(cli)}</div>}
            </div>
          </div>
          <button className="text-btn tool-scan-toggle" onClick={() => setCustomize((v) => !v)}>
            <Icon name="chevron-right" />
            {customize ? "Hide" : "Customize"}
            {picked.length < found.length && ` (${found.length - picked.length} unchecked)`}
          </button>
          {customize && (
            <div className="tool-scan-list">
              {[
                ["MCP servers", mcp],
                ["CLIs", cli],
              ].map(([label, items]) =>
                (items as DetectedTool[]).length ? (
                  <div key={label as string}>
                    <div className="tool-scan-group">{label as string}</div>
                    {(items as DetectedTool[]).map((t) => (
                      <label key={t.key} className="tool-scan-item">
                        <input type="checkbox" checked={checked.has(t.key)} onChange={() => toggle(t.key)} />
                        <span className="setting-title">{t.name}</span>
                        <span className="setting-desc" title={t.description}>
                          {t.description}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null,
              )}
            </div>
          )}
        </>
      )}
      <div className="setting-actions tool-scan-actions">
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={busy} onClick={apply}>
          {found.length === 0 ? "Continue" : picked.length === found.length ? `${cta} all` : `${cta} ${picked.length}`}
        </button>
      </div>
    </div>
  )
}
