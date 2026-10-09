import { useEffect, useState } from "react"
import {
  FX_INSTALL,
  OPENCODE_INSTALL,
  OPENCODE_UPGRADE,
  type FxCheck,
  type Harness,
  type OpencodeCheck,
} from "../shared/types"
import { Icon } from "./icons"
import logo from "../../build/icon.png"

type Card = {
  id: Harness
  name: string
  blurb: string
  url: string
  ok: boolean
  status: string
  /** Shell command that installs (or upgrades) it, when it isn't usable */
  command?: string
}

function cards(opencode: OpencodeCheck, fx: FxCheck): Card[] {
  const outdated = opencode.state === "outdated"
  // `opencode upgrade` on V1 only reaches the latest V1: V2 is a separate install.
  const v1 = outdated && Number.parseInt(opencode.version, 10) < 2
  return [
    {
      id: "fx",
      name: "fx",
      blurb: "Fast, native coding agent from Vercel Labs.",
      url: "https://fx.sh",
      ok: fx.state === "ok",
      status: fx.state === "ok" ? `v${fx.version}` : "Not installed",
      command: fx.state === "ok" ? undefined : FX_INSTALL,
    },
    {
      id: "opencode",
      name: "opencode",
      blurb: "Open source agent with a background service, so turns keep going when ctrl quits.",
      url: "https://opencode.ai/v2/docs/",
      ok: opencode.state === "ok",
      status:
        opencode.state === "ok"
          ? `v${opencode.version}`
          : outdated
            ? `v${opencode.version}, needs ${opencode.min}`
            : "Not installed",
      command: opencode.state === "ok" ? undefined : outdated && !v1 ? OPENCODE_UPGRADE : OPENCODE_INSTALL,
    },
  ]
}

/**
 * First-launch screen over the terminal area: which harnesses are installed, the one new sessions
 * start with, and how to install them. Also shown whenever neither is usable. Checks again when you
 * come back to the window, so installing in a terminal is enough.
 */
export function Onboarding({
  opencode,
  fx,
  defaultHarness,
  onDone,
}: {
  opencode: OpencodeCheck
  fx: FxCheck
  defaultHarness: Harness
  onDone(harness: Harness): void
}) {
  const list = cards(opencode, fx)
  const installed = list.filter((c) => c.ok)
  const [picked, setPicked] = useState<Harness>(defaultHarness)
  const [busy, setBusy] = useState(false)
  const choice = installed.length === 1 ? installed[0].id : picked
  const choiceName = list.find((c) => c.id === choice)!.name

  const recheck = () => {
    setBusy(true)
    void window.ctrl.recheckOpencode().finally(() => setBusy(false))
  }

  useEffect(() => {
    window.addEventListener("focus", recheck)
    return () => window.removeEventListener("focus", recheck)
  }, [])

  const intro =
    installed.length === 0
      ? "A cozy home for your coding agent sessions. Install fx, opencode or both to get started."
      : installed.length === 1
        ? `A cozy home for your coding agent sessions. ${installed[0].name} is installed, so you're all set.`
        : "A cozy home for your coding agent sessions. Both agents are installed: pick the one new sessions start with."
  const note =
    installed.length === 0
      ? "Run a command in a terminal. ctrl notices as soon as you come back."
      : installed.length === 1
        ? "You can add the other one any time. Both kinds of session live side by side."
        : "You can change it any time in Settings, or per space."

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <img className="onboarding-logo" src={logo} alt="" draggable={false} />
        <h1>Welcome to ctrl</h1>
        <p className="onboarding-intro">{intro}</p>
        <div className="harness-cards">
          {list.map((c) => {
            const selectable = installed.length === 2
            const selected = c.ok && c.id === choice
            return (
              <div
                key={c.id}
                className={`harness-card ${c.ok ? "ok" : "missing"} ${selected ? "selected" : ""} ${selectable ? "selectable" : ""}`}
                role={selectable ? "radio" : undefined}
                aria-checked={selectable ? selected : undefined}
                tabIndex={selectable ? 0 : undefined}
                onClick={() => selectable && setPicked(c.id)}
                onKeyDown={(e) => selectable && (e.key === " " || e.key === "Enter") && setPicked(c.id)}
              >
                <div className="harness-card-head">
                  <span className="harness-card-name">{c.name}</span>
                  <span className={`harness-card-status ${c.ok ? "ok" : ""}`}>{c.status}</span>
                  <a
                    className="harness-card-link"
                    href={c.url}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      void window.ctrl.openExternal(c.url)
                    }}
                  >
                    {c.id === "fx" ? "fx.sh" : "opencode.ai"} ↗
                  </a>
                  {c.ok && <span className={`harness-card-mark ${selected ? "on" : ""}`}>{selected && <Icon name="check" />}</span>}
                </div>
                <div className="harness-card-blurb">{c.blurb}</div>
                {c.command && <Command command={c.command} />}
              </div>
            )
          })}
        </div>
        {installed.length === 0 ? (
          <button className="btn primary onboarding-cta" disabled={busy} onClick={recheck}>
            {busy ? "Checking…" : "Check again"}
          </button>
        ) : (
          <button className="btn primary onboarding-cta" onClick={() => onDone(choice)}>
            Start with {choiceName}
          </button>
        )}
        <p className="onboarding-note">{note}</p>
      </div>
    </div>
  )
}

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="harness-command" onClick={(e) => e.stopPropagation()}>
      <code>{command}</code>
      <button
        className="icon-btn"
        title="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  )
}
