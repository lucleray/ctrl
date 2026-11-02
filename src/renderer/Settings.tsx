import { useEffect, useRef, useState } from "react"
import { CTRL_INSTRUCTIONS } from "../shared/ctrl-instructions"
import {
  FONT_SIZE,
  type Appearance,
  type AppState,
  type McpServerItem,
  type McpStatus,
  type ModelChoices,
  type AdapterInfo,
  type FxCheck,
  type Harness,
  type OpencodeCheck,
  type OpencodeServer,
  FX_INSTALL,
  HARNESSES,
  OPENCODE_INSTALL,
  type AdapterMode,
  type CliInfo,
  type Settings as SettingsData,
  type SkillStatus,
  type CliStatus,
  type SoundEvent,
  type UpdateStatus,
  SOUND_EVENTS,
  SYSTEM_SOUNDS,
} from "../shared/types"
import { shortPath } from "./format"
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

const ADAPTER_MODES: { value: AdapterMode; label: string; live?: boolean }[] = [
  { value: "off", label: "Off" },
  { value: "links", label: "Links only" },
  { value: "live", label: "Live details", live: true },
]

/** Its status: a dot color (mcp-dot classes) and a line saying whether it works. */
function adapterStatus({ mode, cli, status }: AdapterInfo): { dot: string; text: string } {
  if (mode === "off") return { dot: "disabled", text: "Off, its links are hidden from the resources panel" }
  if (!cli || !status) return { dot: "connected", text: "Ready, nothing to set up" }
  const s = status.state
  if (s === "ok") return { dot: "connected", text: `Ready, using ${cli.command}${status.account ? ` as ${status.account}` : ""}` }
  if (s === "checking") return { dot: "disabled", text: `Checking ${cli.command}…` }
  if (s === "no-cli") return { dot: "failed", text: `Not set up, ${cli.command} isn't installed` }
  if (s === "logged-out") return { dot: "pending", text: `Not set up, ${cli.command} isn't logged in` }
  if (s === "paused") return { dot: "pending", text: `Rate limited, retrying later${status.detail ? ` (${status.detail})` : ""}` }
  return { dot: "failed", text: `Error: ${status.detail ?? "unknown"}` }
}

/** A prompt for an agent to install and log in an adapter's CLI. */
const setupPrompt = (name: string, cli: CliInfo) =>
  [
    `Set up the \`${cli.command}\` CLI on my Mac so ctrl can fetch live ${name} details for links.`,
    "",
    `1. If \`${cli.command}\` isn't installed, install it: \`${cli.install}\``,
    `2. Log in with \`${cli.login}\`. It's interactive: if you can't finish it yourself, tell me exactly what to run in my terminal.`,
    `3. Verify with \`${cli.verify}\` and tell me which account it's logged in as.`,
  ].join("\n")

/** One resource adapter: what it adds, whether it works, and its mode (off, links only, live details). */
function AdapterRow({ adapter, modes }: { adapter: AdapterInfo; modes: SettingsData["adapterModes"] }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const { cli, status } = adapter
  const { dot, text } = adapterStatus(adapter)
  const notSetUp = adapter.mode !== "off" && !!cli && (status?.state === "no-cli" || status?.state === "logged-out")
  const failing = adapter.mode !== "off" && status?.state === "error"
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${dot}`} />
        <div>
          <div className="setting-title">{adapter.name}</div>
          <div className="setting-desc">{adapter.description}</div>
          <div className={`setting-desc adapter-status ${dot}`}>{text}</div>
          {(notSetUp || failing) && cli && (
            <div className="adapter-actions">
              {notSetUp && (
                <button
                  className="btn"
                  title={setupPrompt(adapter.name, cli)}
                  onClick={() =>
                    void navigator.clipboard.writeText(setupPrompt(adapter.name, cli)).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    })
                  }
                >
                  <Icon name={copied ? "check" : "copy"} />
                  {copied ? "Copied" : "Copy setup prompt"}
                </button>
              )}
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void window.ctrl.retryAdapter(adapter.id).finally(() => setBusy(false))
                }}
              >
                {busy ? "Checking…" : "Check again"}
              </button>
            </div>
          )}
        </div>
      </div>
      <select
        value={adapter.mode}
        onChange={(e) => void window.ctrl.setSettings({ adapterModes: { ...modes, [adapter.id]: e.target.value as AdapterMode } })}
      >
        {ADAPTER_MODES.filter((m) => !m.live || cli).map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  )
}

const SKILL_TEXT: Record<SkillStatus["state"], { dot: string; text: string }> = {
  installed: { dot: "connected", text: "Installed in opencode's global skills folder, which fx reads too" },
  outdated: { dot: "pending", text: "Installed, an older version (refreshed at the next launch)" },
  external: { dot: "connected", text: "Installed outside ctrl, so ctrl leaves it alone" },
  missing: { dot: "disabled", text: "Not installed" },
}

/** The read-session skill: lets agents read sessions dropped onto the terminal. */
function SkillRow({ skill }: { skill: SkillStatus }) {
  const [busy, setBusy] = useState(false)
  const { dot, text } = SKILL_TEXT[skill.state]
  const act = (fn: () => Promise<void>) => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${dot}`} />
        <div>
          <div className="setting-title">read-session</div>
          <div className="setting-desc">
            Drag a session onto the terminal to reference it. With this skill, the agent can read that session and
            pick up its context.
          </div>
          <div className={`setting-desc adapter-status ${dot}`} title={skill.path}>
            {text}
            {skill.state === "external" && skill.path ? ` (${skill.path.replace(/^\/Users\/[^/]+/, "~")})` : ""}
          </div>
        </div>
      </div>
      {skill.state === "missing" && (
        <button className="btn primary" disabled={busy} onClick={() => act(window.ctrl.installSkill)}>
          Install
        </button>
      )}
      {(skill.state === "installed" || skill.state === "outdated") && (
        <button className="btn" disabled={busy} onClick={() => act(window.ctrl.uninstallSkill)}>
          Uninstall
        </button>
      )}
    </div>
  )
}

const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, "~")

/** The `ctrl` CLI on PATH, plus the ctrl skill that tells agents how to use it (docs/CLI.md). */
function CliRow({ cli, skill }: { cli: CliStatus; skill: SkillStatus }) {
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<void>) => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  const installed = cli.state === "installed"
  const warn = installed && (cli.shadowedBy || cli.notOnPath)
  const dot = installed ? (warn ? "pending" : "connected") : cli.state === "other" ? "failed" : "disabled"
  const withSkill = skill.state === "installed" || skill.state === "outdated" ? ", with the ctrl skill" : ""
  const text = installed
    ? cli.shadowedBy
      ? `Installed at ${tilde(cli.link)}, but ${tilde(cli.shadowedBy)} comes first in PATH. The ctrl skill still reaches this one`
      : cli.notOnPath
        ? `Installed at ${tilde(cli.link)}, which isn't in your PATH. Add it to run ctrl outside ctrl's terminals`
        : `Installed at ${tilde(cli.link)}${withSkill}`
    : cli.state === "other"
      ? `${tilde(cli.link)} is something else, so ctrl leaves it alone`
      : cli.state === "stale"
        ? `${tilde(cli.link)} points to another copy of ctrl`
        : "Not installed"
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${dot}`} />
        <div>
          <div className="setting-title">ctrl command line</div>
          <div className="setting-desc">
            Lets agents create spaces and sessions, reference sessions, change settings and switch what's on screen.
            Inside ctrl's terminals it works without installing.
          </div>
          <div className={`setting-desc adapter-status ${dot}`} title={cli.target}>
            {text}
          </div>
        </div>
      </div>
      {!installed && cli.state !== "other" && (
        <button className="btn primary" disabled={busy} onClick={() => act(window.ctrl.installCli)}>
          {cli.state === "stale" ? "Relink" : "Install"}
        </button>
      )}
      {installed && (
        <button className="btn" disabled={busy} onClick={() => act(window.ctrl.uninstallCli)}>
          Uninstall
        </button>
      )}
    </div>
  )
}

function updateText(update: UpdateStatus): string {
  switch (update.state) {
    case "idle":
      return "Checks for updates every few hours"
    case "checking":
      return "Checking for updates…"
    case "up-to-date":
      return "You're on the latest version"
    case "available":
      return `Version ${update.version} is available`
    case "downloading":
      return `Downloading ${update.version}…`
    default:
      return update.detail
  }
}

/** Version, and updates from GitHub Releases. */
function AboutRow({ version, update }: { version: string; update: UpdateStatus }) {
  const busy = update.state === "checking" || update.state === "downloading"
  return (
    <div className="setting">
      <div>
        <div className="setting-title">ctrl {version}</div>
        <div className="setting-desc">{updateText(update)}</div>
      </div>
      {update.state === "available" || update.state === "downloading" ? (
        <button className="btn primary" disabled={busy} onClick={() => void window.ctrl.installUpdate()}>
          {update.state === "downloading" ? "Updating…" : "Update and restart"}
        </button>
      ) : (
        <button className="btn" disabled={busy} onClick={() => void window.ctrl.checkForUpdates()}>
          Check for updates
        </button>
      )}
    </div>
  )
}

const NONE = "__none__"
const PICK = "__pick__"

/** Sound for one event: a system sound, a custom file or none, with a preview button. */
function SoundRow({ event, label, choices }: { event: SoundEvent; label: string; choices: SettingsData["soundChoices"] }) {
  const choice = choices[event]
  const custom = choice?.startsWith("/") ? choice : null
  return (
    <div className="setting setting-indent">
      <div>
        <div className="setting-title">{label}</div>
        {custom && (
          <div className="setting-desc setting-path-desc" title={custom}>
            {custom.replace(/^\/Users\/[^/]+/, "~")}
          </div>
        )}
      </div>
      <div className="setting-actions">
        <button
          className="icon-btn"
          title="Play"
          disabled={!choice}
          onClick={() => choice && void window.ctrl.playSound(choice)}
        >
          <Icon name="play" />
        </button>
        <select
          value={choice ?? NONE}
          onChange={(e) => {
            const value = e.target.value
            if (value === PICK) return void window.ctrl.pickSoundFile(event)
            const next = value === NONE ? null : value
            void window.ctrl.setSettings({ soundChoices: { ...choices, [event]: next } })
            if (next) void window.ctrl.playSound(next)
          }}
        >
          <option value={NONE}>None</option>
          {custom && <option value={custom}>{custom.split("/").pop()}</option>}
          <optgroup label="macOS">
            {SYSTEM_SOUNDS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </optgroup>
          <option value={PICK}>Choose file…</option>
        </select>
      </div>
    </div>
  )
}

function useModels(harness: Harness, available: boolean) {
  const [choices, setChoices] = useState<ModelChoices | null>(null)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!available) {
      setError(`${harness} isn't installed`)
      return
    }
    let live = true
    setError(undefined)
    window.ctrl.listModels(harness).then(
      (c) => live && setChoices(c),
      (err) => live && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [harness, available])
  return { choices, error }
}

/** Whether a harness is installed, with its install command when it isn't, and whether opencode's running service works. */
function HarnessRow({
  harness,
  check,
  server,
}: {
  harness: Harness
  check: OpencodeCheck | FxCheck
  server?: OpencodeServer
}) {
  const [busy, setBusy] = useState(false)
  const install = harness === "fx" ? FX_INSTALL : OPENCODE_INSTALL
  const broken = check.state === "ok" && server?.state === "broken"
  const restarting = check.state === "ok" && server?.state === "restarting"
  const text = broken
    ? `Installed · ${check.version} · service (pid ${server.pid}) lost its macOS session`
    : restarting
      ? "Restarting service…"
      : check.state === "ok"
        ? `Installed · ${check.version}`
        : check.state === "checking"
          ? "Checking…"
          : check.state === "outdated"
            ? `Version ${check.version} is too old (needs ${check.min})`
            : "Not installed"
  const dot = broken
    ? "failed"
    : restarting || check.state === "checking"
      ? "pending"
      : check.state === "ok"
        ? "connected"
        : "disabled"
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${dot}`} />
        <div>
          <div className="setting-title">{harness}</div>
          <div className={`setting-desc adapter-status ${dot}`}>{text}</div>
          {broken && (
            <div className="setting-desc">
              DNS, GitHub and the keychain fail in every session. Restarting stops runs in progress.
            </div>
          )}
          {check.state !== "ok" && check.state !== "checking" && (
            <div className="setting-desc">
              Install: <code>{install}</code>
            </div>
          )}
        </div>
      </div>
      {broken && (
        <div className="mcp-actions">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void window.ctrl.restartOpencode().finally(() => setBusy(false))
            }}
          >
            {busy ? "Restarting…" : "Restart"}
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
  const [showCtrlText, setShowCtrlText] = useState(false)

  // Take focus away from the terminal so keystrokes don't leak into the TUI.
  useEffect(() => root.current?.focus(), [])
  useEffect(() => void window.ctrl.checkAdapters(), [])

  const opencodeModels = useModels("opencode", state.opencode.state === "ok")
  const fxModels = useModels("fx", state.fx.state === "ok")

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
          <div className="setting">
            <div>
              <div className="setting-title">Harness</div>
              <div className="setting-desc">
                Agent new sessions start with. A space can pick its own, and sessions of both kinds live side by side.{" "}
                <a href="https://github.com/lucleray/ctrl/blob/main/docs/HARNESSES.md" onClick={(e) => (e.preventDefault(), void window.ctrl.openExternal(e.currentTarget.href))}>
                  What each supports
                </a>
              </div>
            </div>
            <div className="segmented">
              {HARNESSES.map((h) => (
                <button
                  key={h.id}
                  className={settings.defaultHarness === h.id ? "on" : ""}
                  onClick={() => void window.ctrl.setSettings({ defaultHarness: h.id })}
                >
                  {h.name}
                </button>
              ))}
            </div>
          </div>
          <HarnessRow harness="opencode" check={state.opencode} server={state.opencodeServer} />
          <HarnessRow harness="fx" check={state.fx} />

          <div className="setting">
            <div>
              <div className="setting-title">Folder</div>
              <div className="setting-desc">
                New sessions start here when their space doesn't set a folder. {settings.defaultDirectory ? "" : "Defaults to ~."}
              </div>
            </div>
            <div className="setting-actions">
              {settings.defaultDirectory && (
                <span className="setting-path" title={settings.defaultDirectory}>
                  {/* LRM marks keep slashes in place inside the rtl (start-ellipsis) box */}
                  {`\u200e${shortPath(settings.defaultDirectory)}\u200e`}
                </span>
              )}
              <button className="btn" onClick={() => void window.ctrl.pickDefaultFolder()}>
                {settings.defaultDirectory ? "Change…" : "Choose…"}
              </button>
              {settings.defaultDirectory && (
                <button
                  className="icon-btn"
                  title="Clear folder"
                  onClick={() => void window.ctrl.setSettings({ defaultDirectory: null })}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
          </div>

          <div className="setting setting-with-sub">
            <div>
              <div className="setting-title">Custom model</div>
              <div className="setting-desc">
                Model for new sessions started from ctrl, per harness. A space can pick its own in space settings.
              </div>
            </div>
            <Toggle
              on={settings.defaultModelEnabled}
              onChange={(defaultModelEnabled) => void window.ctrl.setSettings({ defaultModelEnabled })}
            />
          </div>
          <div className="setting-sub">
            <div className="setting-desc model-harness-label">opencode</div>
            <ModelPicker
              choices={opencodeModels.choices}
              error={opencodeModels.error}
              value={settings.defaultModel}
              enabled={settings.defaultModelEnabled}
              onChange={(defaultModel) => void window.ctrl.setSettings({ defaultModel })}
              fallback={{ label: "Default opencode model", detail: "ctrl doesn't set a model, so opencode uses its own default" }}
            />
          </div>
          <div className="setting-sub">
            <div className="setting-desc model-harness-label">fx</div>
            <ModelPicker
              choices={fxModels.choices}
              error={fxModels.error}
              value={settings.defaultFxModel}
              enabled={settings.defaultModelEnabled}
              onChange={(defaultFxModel) => void window.ctrl.setSettings({ defaultFxModel })}
              fallback={{ label: "Default fx model", detail: "ctrl doesn't set a model, so fx uses its own default" }}
            />
          </div>

          <div className="setting setting-with-sub">
            <div>
              <div className="setting-title">ctrl instructions</div>
              <div className="setting-desc">
                Tells agents they run inside ctrl and how to look around with the <code>ctrl</code> command: their session,
                space, the other sessions and links in it. Invisible in the chat. opencode only. A space can turn it on
                or off for its sessions.{" "}
                <a href="#" onClick={(e) => (e.preventDefault(), setShowCtrlText((v) => !v))}>
                  {showCtrlText ? "Hide text" : "Show text"}
                </a>
              </div>
            </div>
            <Toggle
              on={settings.ctrlInstructions}
              onChange={(ctrlInstructions) => void window.ctrl.setSettings({ ctrlInstructions })}
            />
          </div>
          {showCtrlText && (
            <div className="setting-sub">
              <textarea className="setting-textarea" readOnly value={CTRL_INSTRUCTIONS} rows={10} />
            </div>
          )}
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

        <h2>Resource adapters</h2>
        <div className="settings-card">
          {state.adapters.map((adapter) => (
            <AdapterRow key={adapter.id} adapter={adapter} modes={settings.adapterModes} />
          ))}
        </div>

        <h2>Agents</h2>
        <div className="settings-card">
          <SkillRow skill={state.skill} />
          <CliRow cli={state.cli} skill={state.cliSkill} />
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
          <div className="setting">
            <div>
              <div className="setting-title">Sounds</div>
              <div className="setting-desc">
                Play a sound when a session needs your input, finishes or fails. Replaces the system notification
                sound.
              </div>
            </div>
            <Toggle on={settings.sounds} onChange={(sounds) => void window.ctrl.setSettings({ sounds })} />
          </div>
          {settings.sounds && (
            <>
              {SOUND_EVENTS.map((e) => (
                <SoundRow key={e.id} event={e.id} label={e.label} choices={settings.soundChoices} />
              ))}
              <div className="setting setting-indent">
                <div>
                  <div className="setting-title">Also when ctrl is focused</div>
                  <div className="setting-desc">Otherwise sounds only play while you're in another app.</div>
                </div>
                <Toggle
                  on={settings.soundsWhenFocused}
                  onChange={(soundsWhenFocused) => void window.ctrl.setSettings({ soundsWhenFocused })}
                />
              </div>
            </>
          )}
        </div>

        <h2>About</h2>
        <div className="settings-card">
          <AboutRow version={state.version} update={state.update} />
          <div className="setting">
            <div>
              <div className="setting-title">Welcome screen</div>
              <div className="setting-desc">The first-launch screen that picks a harness for new sessions.</div>
            </div>
            <button
              className="btn"
              onClick={() => {
                void window.ctrl.setUi({ onboarded: false })
                onClose()
              }}
            >
              Show again
            </button>
          </div>
        </div>

        <h2>ctrl Companion</h2>
        <div className="settings-card">
          <div className="setting">
            <div>
              <div className="setting-title">
                ctrl Companion <span className="pill">Experimental</span>
              </div>
              <div className="setting-desc">
                A small window that stays on top and lists the sessions that mentioned what you're looking at: the PR
                or issue in your browser, the Slack thread or channel, the Notion page. Press{" "}
                {shortcutLabel("companion-new-session", settings.shortcuts) || "its shortcut"} from any app (or click New in
                the window) to start a new session with that link typed in. Reading Slack, Notion and Linear needs Accessibility access,
                browsers ask for permission to read their tab.
              </div>
            </div>
            <Toggle on={settings.companion} onChange={(companion) => void window.ctrl.setSettings({ companion })} />
          </div>
        </div>
      </div>
    </div>
  )
}
