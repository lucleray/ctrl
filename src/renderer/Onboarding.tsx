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
      blurb: "Fast, native coding agent from Vercel Labs. One process per session.",
      url: "https://fx.sh",
      ok: fx.state === "ok",
      status: fx.state === "ok" ? `Installed · ${fx.version}` : "Not installed",
      command: fx.state === "ok" ? undefined : FX_INSTALL,
    },
    {
      id: "opencode",
      name: "opencode",
      blurb: "Open source coding agent with a background service, so turns keep running when ctrl quits.",
      url: "https://opencode.ai/v2/docs/",
      ok: opencode.state === "ok",
      status:
        opencode.state === "ok"
          ? `Installed · ${opencode.version}`
          : outdated
            ? `Version ${opencode.version} is too old, ctrl needs ${opencode.min}`
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
      ? "ctrl is a home for your coding agent sessions. Install fx, opencode or both in a terminal to get started."
      : installed.length === 1
        ? `${installed[0].name} is installed, so you're all set. You can add the other one any time, and both kinds of session live side by side.`
        : "Both are installed. Pick the one new sessions start with. You can change it any time in Settings, or per space."

  return (
    <div className="onboarding">
      <div className="setup-card onboarding-card">
        <h1>Welcome to ctrl</h1>
        <p>{intro}</p>
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
                  <span className={`harness-card-status ${c.ok ? "ok" : ""}`}>
                    {c.ok && <Icon name="check" />}
                    {c.status}
                  </span>
                </div>
                <div className="harness-card-blurb">
                  {c.blurb}{" "}
                  <a
                    href={c.url}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      void window.ctrl.openExternal(c.url)
                    }}
                  >
                    Learn more
                  </a>
                </div>
                {c.command && <Command command={c.command} />}
              </div>
            )
          })}
        </div>
        {installed.length === 0 ? (
          <>
            <button className="btn primary" disabled={busy} onClick={recheck}>
              {busy ? "Checking…" : "Check again"}
            </button>
            <p className="setup-note">ctrl also checks again when you come back to this window.</p>
          </>
        ) : (
          <button className="btn primary" onClick={() => onDone(choice)}>
            Start with {choiceName}
          </button>
        )}
      </div>
    </div>
  )
}

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="setup-command" onClick={(e) => e.stopPropagation()}>
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
