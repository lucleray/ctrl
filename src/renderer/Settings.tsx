import { useEffect, useRef, useState } from "react"
import {
  FONT_SIZE,
  type Appearance,
  type AppState,
  type GithubStatus,
  type McpServerItem,
  type McpStatus,
  type ModelChoices,
} from "../shared/types"
import { Icon } from "./icons"
import { ModelPicker } from "./ModelPicker"
import { ShortcutSettings } from "./ShortcutSettings"
import { shortcutLabel } from "../shared/shortcuts"
import { Toggle } from "./Toggle"

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

const DEFAULT = "__default__"

const MCP_LABELS: Record<McpStatus, string> = {
  connected: "Connected",
  pending: "Connecting…",
  disabled: "Disabled",
  failed: "Failed",
  needs_auth: "Needs sign-in",
}

function McpRow({ server, onFix }: { server: McpServerItem; onFix(): void }) {
  const broken = server.status === "failed" || server.status === "needs_auth"
  const [busy, setBusy] = useState(false)
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${server.status}`} />
        <div>
          <div className="setting-title">{server.name}</div>
          {server.error && <div className="setting-desc mcp-error">{server.error}</div>}
        </div>
      </div>
      <div className="mcp-actions">
        {broken ? (
          <>
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void window.ctrl.reconnectMcp(server.name).finally(() => setBusy(false))
              }}
            >
              {busy ? "Retrying…" : "Retry"}
            </button>
            <button className="btn primary" onClick={onFix}>
              Fix
            </button>
          </>
        ) : (
          <span className="mcp-status">{MCP_LABELS[server.status]}</span>
        )}
      </div>
    </div>
  )
}

/** Live PR/issue/commit details in the resources panel, using gh's login. */
function GithubRow({ status }: { status: GithubStatus }) {
  const [busy, setBusy] = useState(false)
  const dot = { ok: "connected", paused: "pending", idle: "disabled" }[status.state as string] ?? "failed"
  const desc =
    status.state === "ok"
      ? `Signed in as @${status.login} through gh · ${status.remaining?.toLocaleString()} of ${status.limit?.toLocaleString()} API points left this hour (ctrl used ${status.used ?? 0})`
      : status.state === "no-cli"
        ? "Install the GitHub CLI (brew install gh), then run gh auth login"
        : status.state === "logged-out"
          ? "Run gh auth login in a terminal to get PR, issue and CI status"
          : status.state === "idle"
            ? "Uses gh's login. Details refresh while the resources panel is open."
            : status.detail
  const problem = status.state === "no-cli" || status.state === "logged-out" || status.state === "error"
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${dot}`} />
        <div>
          <div className="setting-title">GitHub</div>
          <div className="setting-desc mcp-error">
            {status.state === "paused" ? `Paused: ${status.detail}` : desc}
          </div>
        </div>
      </div>
      {problem && (
        <div className="mcp-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void window.ctrl.retryGithub().finally(() => setTimeout(() => setBusy(false), 1500))
            }}
          >
            {busy ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
    </div>
  )
}

export function Settings({
  state,
  onClose,
  onFixMcp,
}: {
  state: AppState
  onClose(): void
  onFixMcp(name: string): void
}) {
  const { settings, themes } = state
  const key = (id: Parameters<typeof shortcutLabel>[0]) => shortcutLabel(id, settings.shortcuts)
  const zoomKeys = [key("zoom-in"), key("zoom-out"), key("zoom-reset")]

  const root = useRef<HTMLDivElement>(null)

  // Take focus away from the terminal so keystrokes don't leak into the TUI.
  useEffect(() => root.current?.focus(), [])

  const [choices, setChoices] = useState<ModelChoices | null>(null)
  const [modelError, setModelError] = useState<string>()
  useEffect(() => {
    let live = true
    window.ctrl.listModels().then(
      (c) => live && setChoices(c),
      (err) => live && setModelError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [])

  return (
    <div
      className="settings"
      ref={root}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
      }}
    >
      <div className="settings-inner">
        <div className="settings-header">
          <h1>Settings</h1>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <h2>Appearance</h2>
        <div className="settings-card">
          <div className="setting">
            <div>
              <div className="setting-title">Theme</div>
              <div className="setting-desc">Applies to the app and the embedded opencode TUI.</div>
            </div>
            <div className="segmented">
              {APPEARANCES.map((a) => (
                <button
                  key={a.value}
                  className={settings.appearance === a.value ? "on" : ""}
                  onClick={() => void window.ctrl.setSettings({ appearance: a.value })}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting">
            <div>
              <div className="setting-title">opencode theme</div>
              <div className="setting-desc">
                Only for the TUI inside ctrl. Your global cli.json is left untouched. Changing it restarts the TUI.
              </div>
            </div>
            <select
              value={settings.tuiTheme ?? DEFAULT}
              onChange={(e) =>
                void window.ctrl.setSettings({ tuiTheme: e.target.value === DEFAULT ? null : e.target.value })
              }
            >
              <option value={DEFAULT}>Default{themes.cliDefault ? ` (${themes.cliDefault})` : ""}</option>
              {themes.custom.length > 0 && (
                <optgroup label="Custom">
                  {themes.custom.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Built-in">
                {themes.builtin.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className="setting">
            <div>
              <div className="setting-title">Text size</div>
              <div className="setting-desc">
                Font size of the terminal.
                {zoomKeys.every(Boolean) && ` Also ${zoomKeys[0]}, ${zoomKeys[1]} and ${zoomKeys[2]} to reset.`}
              </div>
            </div>
            <div className="stepper">
              <button
                title={`Smaller${zoomKeys[1] ? ` (${zoomKeys[1]})` : ""}`}
                disabled={settings.fontSize <= FONT_SIZE.min}
                onClick={() => void window.ctrl.setSettings({ fontSize: settings.fontSize - 1 })}
              >
                −
              </button>
              <button
                className="stepper-value"
                title={`Reset to default${zoomKeys[2] ? ` (${zoomKeys[2]})` : ""}`}
                onClick={() => void window.ctrl.setSettings({ fontSize: FONT_SIZE.default })}
              >
                {settings.fontSize}px
              </button>
              <button
                title={`Larger${zoomKeys[0] ? ` (${zoomKeys[0]})` : ""}`}
                disabled={settings.fontSize >= FONT_SIZE.max}
                onClick={() => void window.ctrl.setSettings({ fontSize: settings.fontSize + 1 })}
              >
                +
              </button>
            </div>
          </div>
        </div>

        <h2>Sessions</h2>
        <div className="settings-card">
          <div className="setting setting-with-sub">
            <div>
              <div className="setting-title">Custom model</div>
              <div className="setting-desc">
                Model for new sessions started from ctrl. A space can pick its own in space settings.
              </div>
            </div>
            <Toggle
              on={settings.defaultModelEnabled}
              onChange={(defaultModelEnabled) => void window.ctrl.setSettings({ defaultModelEnabled })}
            />
          </div>
          <div className="setting-sub">
            <ModelPicker
              choices={choices}
              error={modelError}
              value={settings.defaultModel}
              enabled={settings.defaultModelEnabled}
              onChange={(defaultModel) => void window.ctrl.setSettings({ defaultModel })}
              fallback={{ label: "Default opencode model", detail: "ctrl doesn't set a model, so opencode uses its own default" }}
            />
          </div>
        </div>

        <h2>MCP servers</h2>
        <div className="settings-card">
          {state.mcp.length === 0 ? (
            <div className="setting">
              <div className="setting-desc">No MCP servers configured.</div>
            </div>
          ) : (
            state.mcp.map((server) => (
              <McpRow key={server.name} server={server} onFix={() => onFixMcp(server.name)} />
            ))
          )}
        </div>

        <h2>Resource details</h2>
        <div className="settings-card">
          <GithubRow status={state.github} />
        </div>

        <h2>Shortcuts</h2>
        <ShortcutSettings overrides={settings.shortcuts} />

        <h2>Notifications</h2>
        <div className="settings-card">
          <div className="setting">
            <div>
              <div className="setting-title">Dock badge</div>
              <div className="setting-desc">Show how many sessions are waiting for your input.</div>
            </div>
            <Toggle
              on={settings.dockBadge}
              onChange={(dockBadge) => void window.ctrl.setSettings({ dockBadge })}
            />
          </div>
          <div className="setting">
            <div>
              <div className="setting-title">System notifications</div>
              <div className="setting-desc">
                When a session needs your input, finishes or fails while ctrl isn't focused.
              </div>
            </div>
            <Toggle
              on={settings.notifications}
              onChange={(notifications) => void window.ctrl.setSettings({ notifications })}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
