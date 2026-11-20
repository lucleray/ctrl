import QRCode from "qrcode"
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { CTRL_INSTRUCTIONS } from "../shared/ctrl-instructions"
import {
  FONT_SIZE,
  type Appearance,
  type AppState,
  type CliToolConfig,
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
  type RemoteStatus,
  type ToolFix,
  type ToolHarness,
  type ToolItem,
  type UpdateStatus,
  CLI_TOOL_EVERY,
  SOUND_EVENTS,
  TOOL_BROKEN,
  SYSTEM_SOUNDS,
} from "../shared/types"
import { CLI_TOOL_PRESETS, cliToolID } from "../shared/tools"
import { age, shortPath } from "./format"
import { ToolScan } from "./ToolScan"
import { Icon } from "./icons"
import { ModelPicker } from "./ModelPicker"
import { ShortcutSettings } from "./ShortcutSettings"
import { shortcutLabel } from "../shared/shortcuts"
import { Toggle } from "./Toggle"
import { WorktreeSettings } from "./WorktreeSettings"

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

const DEFAULT = "__default__"


/** Dark modules on white with a quiet zone, so phone cameras read it in dark mode too. */
function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" })
  const n = modules.size
  const pad = 2
  let d = ""
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) if (modules.get(y, x)) d += `M${x + pad} ${y + pad}h1v1h-1z`
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n + pad * 2} ${n + pad * 2}`} shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

function RemoteRows({ remote }: { remote: RemoteStatus }) {
  const [copied, setCopied] = useState(false)
  const [showLink, setShowLink] = useState(false)
  if (remote.state === "off") return null
  if (remote.state === "error")
    return (
      <div className="setting setting-indent">
        <div>
          <div className="setting-title">Not running</div>
          <div className="setting-desc mcp-error">{remote.detail}</div>
        </div>
      </div>
    )
  // The MagicDNS name when there is one, else the tailnet IP.
  const url = remote.urls[0]
  return (
    <>
      {remote.state === "local" && (
        <div className="setting setting-indent">
          <div>
            <div className="setting-title">Tailscale isn't connected</div>
            <div className="setting-desc">
              Only this Mac can open the page for now. Connect Tailscale on this Mac and your phone, and the link
              below switches to your tailnet address.
            </div>
          </div>
        </div>
      )}
      {remote.state === "on" && (
        <div className="setting setting-indent remote-qr">
          <QrCode text={url} />
          <div>
            <div className="setting-title">Scan with your phone</div>
            <div className="setting-desc">
              Point your phone's camera at the code and open the link. Your phone needs Tailscale on. After the first
              visit, the phone stays signed in.
            </div>
            {!showLink && (
              <button className="text-btn" onClick={() => setShowLink(true)}>
                Can't scan? Show the link
              </button>
            )}
          </div>
        </div>
      )}
      {(showLink || remote.state === "local") && (
        <div className="setting setting-indent">
          <div style={{ minWidth: 0 }}>
            <div className="setting-title">{new URL(url).host}</div>
            <div className="setting-desc">Open this link on your phone. It holds a secret, so keep it private.</div>
          </div>
          <button
            className="btn"
            onClick={() =>
              void navigator.clipboard.writeText(url).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }
          >
            <Icon name={copied ? "check" : "copy"} />
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
    </>
  )
}

const TOOL_DOTS: Record<ToolItem["state"], string> = {
  ok: "connected",
  checking: "disabled",
  pending: "pending",
  disabled: "disabled",
  broken: "failed",
  "needs-auth": "failed",
  missing: "failed",
}

/** Status line under a tool's name. */
function toolStatus(tool: ToolItem): string {
  if (tool.fixing) return "Fixing…"
  const when = tool.checked ? ` · checked ${age(tool.checked) === "now" ? "just now" : `${age(tool.checked)} ago`}` : ""
  switch (tool.state) {
    case "ok":
      return tool.kind === "mcp" ? "Connected" : `Ready${when}`
    case "checking":
      return "Checking…"
    case "pending":
      return "Connecting…"
    case "disabled":
      return "Disabled"
    case "needs-auth":
      return "Needs sign-in"
    case "missing":
      return "Not installed"
    default:
      return tool.kind === "mcp" ? "Failed" : `Failing${when}`
  }
}

const HARNESS_TEXT: Record<ToolHarness["state"], string> = {
  ok: "ok",
  checking: "checking…",
  pending: "connecting…",
  disabled: "disabled",
  broken: "failing",
  "needs-auth": "needs sign-in",
  missing: "not installed",
  "not-set-up": "not set up",
  unused: "not in use",
}

/** Where an MCP server stands in each harness, with that harness's fix (Add, Log in, Fix). */
function HarnessChips({ tool, onFix }: { tool: ToolItem; onFix(id: string): void }) {
  return (
    <div className="tool-harnesses">
      {tool.harnesses!.map((h) => {
        const dot = h.state === "not-set-up" ? "pending" : h.state === "unused" ? "disabled" : TOOL_DOTS[h.state]
        return (
          <span key={h.harness} className="tool-harness" title={h.detail}>
            <span className={`mcp-dot ${dot}`} />
            <span className={`adapter-status ${dot}`}>
              {h.harness} {HARNESS_TEXT[h.state]}
            </span>
            {h.label && (
              <button className="text-btn" onClick={() => onFix(`${tool.id}@${h.harness}`)}>
                {h.label}
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

/** One watched tool, MCP server or CLI: its state, and Check + its fix when it's broken. */
function ToolRow({
  tool,
  onFix,
  onEdit,
  onRemove,
}: {
  tool: ToolItem
  onFix(id: string): void
  onEdit?(): void
  onRemove?(): void
}) {
  const broken = TOOL_BROKEN.includes(tool.state)
  const [busy, setBusy] = useState(false)
  const dot = TOOL_DOTS[tool.state]
  const chips = tool.kind === "mcp" && !!tool.harnesses?.length
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${tool.fixing ? "pending" : dot}`} />
        <div style={{ minWidth: 0 }}>
          <div className="setting-title">{tool.name}</div>
          {tool.check && (
            <div className="setting-desc tool-check" title={tool.check}>
              <code>{tool.check}</code>
            </div>
          )}
          {broken && tool.detail && <div className="setting-desc mcp-error">{tool.detail}</div>}
          {chips ? (
            <HarnessChips tool={tool} onFix={onFix} />
          ) : (
            <div className={`setting-desc adapter-status ${tool.fixing ? "pending" : dot}`}>{toolStatus(tool)}</div>
          )}
        </div>
      </div>
      <div className="mcp-actions">
        {(broken || tool.kind === "cli") && (
          <button
            className="btn"
            disabled={busy || tool.fixing}
            onClick={() => {
              setBusy(true)
              void window.ctrl.checkTool(tool.id).finally(() => setBusy(false))
            }}
          >
            {busy ? "Checking…" : tool.kind === "mcp" ? "Retry" : "Check"}
          </button>
        )}
        {broken && !chips && (
          <button className="btn primary" disabled={tool.fixing} onClick={() => onFix(tool.id)}>
            {tool.label}
          </button>
        )}
        {onEdit && (
          <button className="icon-btn" title="Edit" onClick={onEdit}>
            <Icon name="compose" />
          </button>
        )}
        {onRemove && (
          <button className="icon-btn" title="Stop watching" onClick={onRemove}>
            <Icon name="trash" />
          </button>
        )}
      </div>
    </div>
  )
}

const FIX_KINDS: { value: ToolFix["kind"]; label: string; placeholder: string }[] = [
  { value: "command", label: "Run a command", placeholder: "aws sso login --profile default" },
  { value: "url", label: "Open a page", placeholder: "https://…" },
  { value: "session", label: "Start a session", placeholder: "Prompt (optional, ctrl writes one from the error)" },
]

const fixValue = (fix: ToolFix) => (fix.kind === "command" ? fix.command : fix.kind === "url" ? fix.url : (fix.prompt ?? ""))

/** Adds or edits one CLI check: what to run, and what fixes it. */
function CliToolEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Omit<CliToolConfig, "id">
  onSave(config: Omit<CliToolConfig, "id">): void
  onCancel(): void
}) {
  const [name, setName] = useState(initial.name)
  const [check, setCheck] = useState(initial.check)
  const [kind, setKind] = useState<ToolFix["kind"]>(initial.fix.kind)
  const [value, setValue] = useState(fixValue(initial.fix))
  const [label, setLabel] = useState(initial.label ?? "")
  const [every, setEvery] = useState(String(initial.every ?? CLI_TOOL_EVERY))
  const fix: ToolFix =
    kind === "command"
      ? { kind, command: value.trim() }
      : kind === "url"
        ? { kind, url: value.trim() }
        : { kind, ...(value.trim() ? { prompt: value.trim() } : {}) }
  const minutes = Math.round(Number(every))
  const valid =
    !!name.trim() &&
    !!check.trim() &&
    (kind === "session" || !!value.trim()) &&
    (kind !== "url" || /^https?:\/\//.test(value.trim())) &&
    minutes >= 1
  const save = () =>
    valid &&
    onSave({
      name: name.trim(),
      check: check.trim(),
      fix,
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(minutes !== CLI_TOOL_EVERY ? { every: minutes } : {}),
    })
  return (
    <div
      className="setting setting-stack tool-editor"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") save()
        if (e.key === "Escape") (e.stopPropagation(), onCancel())
      }}
    >
      <label>
        <span>Name</span>
        <input className="setting-input" value={name} autoFocus placeholder="AWS (work)" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span>Check</span>
        <input
          className="setting-input mono"
          value={check}
          spellCheck={false}
          placeholder="aws sts get-caller-identity --profile default"
          onChange={(e) => setCheck(e.target.value)}
        />
      </label>
      <div className="setting-desc wide">Exits 0 while the CLI works. Runs in a shell with no terminal, so it can't ask questions.</div>
      <label>
        <span>Fix</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as ToolFix["kind"])}>
          {FIX_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span />
        <input
          className={`setting-input${kind === "command" ? " mono" : ""}`}
          value={value}
          spellCheck={false}
          placeholder={FIX_KINDS.find((k) => k.value === kind)!.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <label>
        <span>Button</span>
        <input
          className="setting-input"
          value={label}
          placeholder={kind === "command" ? "Run" : kind === "url" ? "Open" : "Fix"}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label>
        <span>Every</span>
        <span className="tool-every">
          <input className="setting-input" type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} />
          minutes, and when ctrl gets focus
        </span>
      </label>
      <div className="setting-actions tool-editor-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid} onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}

const CUSTOM = "__custom__"

/**
 * Settings → Tools: before tools.json exists, opencode's MCP servers and a Scan button. After, your list:
 * MCP servers with their state per harness, CLI checks (edit, add by hand), Remove on every row, and a
 * quiet "Scan again".
 */
function ToolsSection({ tools, setUp, onFix }: { tools: ToolItem[]; setUp: boolean; onFix(id: string): void }) {
  /** CLI being edited: an existing id, or null for a new one, with its starting values */
  const [editing, setEditing] = useState<{ id: string | null; initial: Omit<CliToolConfig, "id"> & { key?: string } } | null>(null)
  const [scanning, setScanning] = useState(false)
  const mcp = tools.filter((t) => t.kind === "mcp")
  const cli = tools.filter((t) => t.kind === "cli")

  const commit = (config: Omit<CliToolConfig, "id">) => {
    const taken = cli.map((t) => t.id.slice("cli:".length))
    const id = editing?.id ?? cliToolID(config.name, taken)
    void window.ctrl.saveCliTool({ ...config, ...(editing?.initial.key ? { key: editing.initial.key } : {}), id })
    setEditing(null)
  }
  const remove = (id: string) => void window.ctrl.removeTool(id)

  if (!setUp)
    return (
      <>
        <div className="settings-card">
          {scanning ? (
            <div className="setting setting-stack">
              <ToolScan onDone={() => setScanning(false)} onCancel={() => setScanning(false)} />
            </div>
          ) : (
            <div className="setting">
              <div>
                <div className="setting-title">Watch your MCP servers and CLI logins</div>
                <div className="setting-desc">
                  ctrl looks at your harnesses and CLIs (AWS SSO, gh, vercel, pup…) and keeps one list. It tells you
                  when one needs you, like an expired login, and checks each harness you use has your MCP servers.
                </div>
              </div>
              <button className="btn primary" onClick={() => setScanning(true)}>
                Scan
              </button>
            </div>
          )}
        </div>
        <h3 className="settings-subhead">MCP servers in opencode</h3>
        <div className="settings-card">
          {mcp.length ? (
            mcp.map((tool) => <ToolRow key={tool.id} tool={tool} onFix={onFix} />)
          ) : (
            <div className="setting">
              <div className="setting-desc">No MCP servers configured.</div>
            </div>
          )}
        </div>
      </>
    )

  return (
    <>
      {scanning ? (
        <div className="settings-card">
          <div className="setting setting-stack">
            <ToolScan cta="Watch" onDone={() => setScanning(false)} onCancel={() => setScanning(false)} />
          </div>
        </div>
      ) : (
        <div className="tools-header">
          <div className="setting-desc">
            Watching {mcp.length} MCP server{mcp.length === 1 ? "" : "s"} and {cli.length} CLI{cli.length === 1 ? "" : "s"}.
            Scan again to pick up new ones from your harnesses and this Mac.
          </div>
          <button className="btn" onClick={() => setScanning(true)}>
            Scan again
          </button>
        </div>
      )}
      <h3 className="settings-subhead">MCP servers</h3>
      <div className="settings-card">
        {mcp.length ? (
          mcp.map((tool) => <ToolRow key={tool.id} tool={tool} onFix={onFix} onRemove={() => remove(tool.id)} />)
        ) : (
          <div className="setting">
            <div className="setting-desc">No MCP servers in your list. Scan again to pick them up from your harnesses.</div>
          </div>
        )}
      </div>
      <h3 className="settings-subhead">Command line tools</h3>
      <div className="settings-card">
        {cli.map((tool) => {
          const config = tool.config
          if (editing?.id && `cli:${editing.id}` === tool.id)
            return <CliToolEditor key={tool.id} initial={editing.initial} onSave={commit} onCancel={() => setEditing(null)} />
          return (
            <ToolRow
              key={tool.id}
              tool={tool}
              onFix={onFix}
              onEdit={config && (() => setEditing({ id: config.id, initial: config }))}
              onRemove={() => remove(tool.id)}
            />
          )
        })}
        {editing && !editing.id ? (
          <CliToolEditor initial={editing.initial} onSave={commit} onCancel={() => setEditing(null)} />
        ) : (
          <div className="setting">
            <div>
              <div className="setting-title">Add a CLI</div>
              <div className="setting-desc">
                ctrl runs its check in the background and tells you when it stops working, with a button that fixes it.
              </div>
            </div>
            <select
              value=""
              onChange={(e) => {
                const preset = CLI_TOOL_PRESETS.find((p) => p.name === e.target.value)
                setEditing({
                  id: null,
                  initial: preset
                    ? { name: preset.name, check: preset.check, fix: preset.fix, ...(preset.label ? { label: preset.label } : {}) }
                    : { name: "", check: "", fix: { kind: "command", command: "" } },
                })
              }}
            >
              <option value="" disabled>
                Add…
              </option>
              {CLI_TOOL_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
              <option value={CUSTOM}>Custom…</option>
            </select>
          </div>
        )}
      </div>
    </>
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

type SectionID =
  | "appearance"
  | "sessions"
  | "notifications"
  | "shortcuts"
  | "agents"
  | "tools"
  | "worktrees"
  | "adapters"
  | "companion"
  | "remote"
  | "about"

/** The sidebar, in order. `keywords` find a section by words none of its rows say. */
const SECTIONS: { id: SectionID; label: string; icon: string; group?: string; keywords?: string }[] = [
  { id: "appearance", label: "Appearance", icon: "sun", group: "General", keywords: "dark light font zoom chat terminal" },
  { id: "sessions", label: "Sessions", icon: "terminal", group: "General" },
  { id: "notifications", label: "Notifications", icon: "bell", group: "General", keywords: "alerts" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard", group: "General", keywords: "keyboard keys hotkeys" },
  { id: "agents", label: "Agents", icon: "bot", group: "Integrations", keywords: "skills" },
  { id: "tools", label: "Tools", icon: "plug", group: "Integrations", keywords: "mcp servers cli credentials login aws" },
  { id: "worktrees", label: "Worktrees", icon: "git-branch", group: "Integrations", keywords: "git checkout repo repositories pool warm branch cleanup" },
  { id: "adapters", label: "Resource adapters", icon: "link", group: "Integrations", keywords: "links" },
  { id: "companion", label: "Companion", icon: "panel-float", group: "Integrations" },
  { id: "remote", label: "Remote control", icon: "phone", group: "Integrations", keywords: "phone mobile tailscale" },
  { id: "about", label: "About", icon: "info", keywords: "version" },
]

/** Reopening settings comes back to the section you left. */
let lastSection: SectionID = "appearance"

/** The next time settings opens, it opens on this section (a toast's "Set up", `ui:settings` with an id). */
export const openSettingsSection = (id: string) => {
  if (SECTIONS.some((s) => s.id === id)) lastSection = id as SectionID
}

const HIGHLIGHT = "settings-search"

/** Text nodes a search looks at: what's written on screen, not the options inside selects. */
function textNodes(el: Element): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("select, textarea") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

function termRanges(nodes: Text[], terms: string[]): Range[] {
  const ranges: Range[] = []
  for (const node of nodes) {
    const text = node.data.toLowerCase()
    for (const term of terms) {
      for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
        const range = new Range()
        range.setStart(node, at)
        range.setEnd(node, at + term.length)
        ranges.push(range)
      }
    }
  }
  return ranges
}

/**
 * Hides the rows of `root` that don't match every term and highlights the matches. A row's indented
 * rows (sounds per event, model pickers) go with it. A section shows whole when its name matches, or its
 * keywords do and none of its rows. Returns the sections with at least one match.
 */
function filterRows(root: HTMLElement, terms: string[]): SectionID[] {
  const matches = (text: string) => {
    const lower = text.toLowerCase()
    return terms.every((t) => lower.includes(t))
  }
  const ranges: Range[] = []
  const found: SectionID[] = []
  for (const section of root.querySelectorAll<HTMLElement>("[data-section]")) {
    const meta = SECTIONS.find((s) => s.id === section.dataset.section)!
    const groups: HTMLElement[][][] = []
    for (const card of section.querySelectorAll<HTMLElement>(".settings-card")) {
      const cardGroups: HTMLElement[][] = []
      for (const row of card.children as HTMLCollectionOf<HTMLElement>) {
        const attached = row.classList.contains("setting-indent") || row.classList.contains("setting-sub")
        if (attached && cardGroups.length) cardGroups[cardGroups.length - 1].push(row)
        else cardGroups.push([row])
      }
      groups.push(cardGroups)
    }
    const hits = new Set(groups.flat().filter((g) => matches(g.flatMap(textNodes).map((n) => n.data).join(" "))))
    const whole = matches(meta.label) || (hits.size === 0 && matches(`${meta.label} ${meta.keywords ?? ""}`))
    if (whole) ranges.push(...termRanges(textNodes(section.querySelector("h2")!), terms))
    const any = whole || hits.size > 0
    for (const cardGroups of groups) {
      for (const group of cardGroups) {
        const show = whole || hits.has(group)
        for (const row of group) row.hidden = !show
        if (show) ranges.push(...termRanges(group.flatMap(textNodes), terms))
      }
      let first = true
      for (const row of cardGroups.flat()) {
        row.toggleAttribute("data-first", first && !row.hidden)
        if (!row.hidden) first = false
      }
    }
    section.hidden = !any
    if (any) found.push(meta.id)
  }
  CSS.highlights?.set(HIGHLIGHT, new Highlight(...ranges))
  return found
}

export function Settings({
  state,
  onClose,
  onFixTool,
}: {
  state: AppState
  onClose(): void
  onFixTool(id: string): void
}) {
  const { settings, themes } = state
  const key = (id: Parameters<typeof shortcutLabel>[0]) => shortcutLabel(id, settings.shortcuts)
  const zoomKeys = [key("zoom-in"), key("zoom-out"), key("zoom-reset")]

  const search = useRef<HTMLInputElement>(null)
  const results = useRef<HTMLDivElement>(null)
  const [showCtrlText, setShowCtrlText] = useState(false)
  const [active, setActive] = useState<SectionID>(lastSection)
  const [query, setQuery] = useState("")
  const [found, setFound] = useState<SectionID[]>([])
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const searching = terms.length > 0

  // Focus the search box: typing searches right away, and keystrokes don't leak into the TUI.
  useEffect(() => search.current?.focus(), [])
  useEffect(() => void window.ctrl.checkAdapters(), [])
  useEffect(() => () => void CSS.highlights?.delete(HIGHLIGHT), [])

  // Runs after every render while searching, so rows that appear (sounds turned on) get filtered too.
  useLayoutEffect(() => {
    if (!searching || !results.current) return void CSS.highlights?.delete(HIGHLIGHT)
    const next = filterRows(results.current, terms)
    setFound((prev) => (prev.join() === next.join() ? prev : next))
  })

  const open = (id: SectionID) => {
    lastSection = id
    setActive(id)
    setQuery("")
  }

  const opencodeModels = useModels("opencode", state.opencode.state === "ok")
  const fxModels = useModels("fx", state.fx.state === "ok")

  const alerts: Partial<Record<SectionID, boolean>> = {
    sessions: state.opencodeServer?.state === "broken",
    tools: state.tools.some((t) => TOOL_BROKEN.includes(t.state)),
    worktrees: state.worktrees.repos.some((r) => !!r.error),
    adapters: state.adapters.some((a) => a.mode !== "off" && a.status?.state === "error"),
    about: state.update.state === "available",
  }

  const bodies: Record<SectionID, ReactNode> = {
    appearance: (
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
            <div className="setting-title">Sessions</div>
            <div className="setting-desc">
              Show them in their terminal, or as a chat like on your phone. opencode sessions switch any time, with
              the TUI running underneath. New fx sessions start as whichever is picked, and keep it.
            </div>
          </div>
          <div className="segmented">
            {(["terminal", "chat"] as const).map((v) => (
              <button
                key={v}
                className={settings.sessionView === v ? "on" : ""}
                onClick={() => void window.ctrl.setSettings({ sessionView: v })}
              >
                {v === "terminal" ? "Terminal" : "Chat"}
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
    ),

    sessions: (
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

        <div className="setting">
          <div>
            <div className="setting-title">Space</div>
            <div className="setting-desc">New chats (⌘N, New chat) start in this space and use its settings.</div>
          </div>
          <select
            value={state.spaces.some((s) => s.id === settings.defaultSpace) ? settings.defaultSpace! : ""}
            onChange={(e) => void window.ctrl.setSettings({ defaultSpace: e.target.value || null })}
          >
            <option value="">No space</option>
            {state.spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
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
              space, the other sessions and links in it, and how to take a git worktree to work on a repo. Invisible in the chat. opencode only. A space can turn it on
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
            <textarea className="setting-textarea" readOnly value={CTRL_INSTRUCTIONS} rows={12} />
          </div>
        )}
      </div>
    ),

    notifications: (
      <div className="settings-card">
        <div className="setting">
          <div>
            <div className="setting-title">Dock badge</div>
            <div className="setting-desc">Show how many sessions are waiting for your input.</div>
          </div>
          <Toggle on={settings.dockBadge} onChange={(dockBadge) => void window.ctrl.setSettings({ dockBadge })} />
        </div>
        <div className="setting">
          <div>
            <div className="setting-title">System notifications</div>
            <div className="setting-desc">When a session needs your input, finishes or fails while ctrl isn't focused.</div>
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
              Play a sound when a session needs your input, finishes or fails. Replaces the system notification sound.
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
    ),

    shortcuts: <ShortcutSettings overrides={settings.shortcuts} />,

    agents: (
      <div className="settings-card">
        <SkillRow skill={state.skill} />
        <CliRow cli={state.cli} skill={state.cliSkill} />
      </div>
    ),

    tools: <ToolsSection tools={state.tools} setUp={state.toolsSetUp} onFix={onFixTool} />,

    worktrees: <WorktreeSettings state={state} />,

    adapters: (
      <div className="settings-card">
        {state.adapters.map((adapter) => (
          <AdapterRow key={adapter.id} adapter={adapter} modes={settings.adapterModes} />
        ))}
      </div>
    ),

    companion: (
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
    ),

    remote: (
      <div className="settings-card">
        <div className="setting">
          <div>
            <div className="setting-title">
              Remote control <span className="pill">Experimental</span>
            </div>
            <div className="setting-desc">
              Use ctrl from your phone: a web page on your Tailscale network lists your spaces and sessions, lets
              you chat in opencode ones and shows the Board. macOS may ask once to allow incoming connections.
            </div>
          </div>
          <Toggle
            on={settings.remoteControl}
            onChange={(remoteControl) => void window.ctrl.setSettings({ remoteControl })}
          />
        </div>
        {settings.remoteControl && <RemoteRows remote={state.remote} />}
      </div>
    ),

    about: (
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
    ),
  }

  const current = SECTIONS.find((s) => s.id === active)!

  return (
    <div
      className="settings settings-split"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (query) setQuery("")
          else onClose()
        } else if (e.key === "f" && e.metaKey) {
          e.preventDefault()
          search.current?.select()
        }
      }}
    >
      <nav className="settings-nav">
        <h1>Settings</h1>
        <label className="settings-search">
          <Icon name="search" />
          <input
            ref={search}
            value={query}
            placeholder="Search"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searching && found[0]) open(found[0])
            }}
          />
          {query && (
            <button className="icon-btn" title="Clear (Esc)" onClick={() => (setQuery(""), search.current?.focus())}>
              <Icon name="close" />
            </button>
          )}
        </label>
        {SECTIONS.map((s, i) => (
          <Fragment key={s.id}>
            {s.group !== SECTIONS[i - 1]?.group && (
              <div className="settings-nav-group">{s.group ?? ""}</div>
            )}
            <button
              className={`row${!searching && s.id === active ? " active" : ""}${searching && !found.includes(s.id) ? " dim" : ""}`}
              onClick={() => open(s.id)}
            >
              <Icon name={s.icon} />
              <span className="label">{s.label}</span>
              {alerts[s.id] && <span className="mcp-dot failed" />}
            </button>
          </Fragment>
        ))}
      </nav>

      <div className="settings-content">
        {searching ? (
          <div className="settings-inner" key="search" ref={results}>
            <h1>Search</h1>
            {SECTIONS.map((s) => (
              <section key={s.id} data-section={s.id}>
                <h2>
                  <button className="settings-result-title" title={`Open ${s.label}`} onClick={() => open(s.id)}>
                    {s.label}
                    <Icon name="chevron-right" />
                  </button>
                </h2>
                {bodies[s.id]}
              </section>
            ))}
            {found.length === 0 && <div className="settings-empty">No settings match “{query.trim()}”</div>}
          </div>
        ) : (
          <div className="settings-inner" key={active}>
            <h1>{current.label}</h1>
            {bodies[active]}
          </div>
        )}
      </div>

      <button className="icon-btn settings-close" title="Close (Esc)" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  )
}
