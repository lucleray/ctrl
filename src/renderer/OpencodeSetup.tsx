import { useEffect, useState } from "react"
import { FX_INSTALL, OPENCODE_INSTALL, OPENCODE_UPGRADE, type OpencodeCheck } from "../shared/types"
import { Icon } from "./icons"

/**
 * Shown instead of the terminal until a recent enough opencode (or fx) is installed. Checks again
 * when you come back to the window, so installing it in a terminal is enough.
 */
export function OpencodeSetup({ check }: { check: Exclude<OpencodeCheck, { state: "ok" | "checking" }> }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const outdated = check.state === "outdated"
  // `opencode upgrade` on V1 only reaches the latest V1: V2 is a separate install.
  const v1 = outdated && Number.parseInt(check.version, 10) < 2
  const command = outdated && !v1 ? OPENCODE_UPGRADE : OPENCODE_INSTALL

  const recheck = () => {
    setBusy(true)
    void window.ctrl.recheckOpencode().finally(() => setBusy(false))
  }

  useEffect(() => {
    window.addEventListener("focus", recheck)
    return () => window.removeEventListener("focus", recheck)
  }, [])

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>{outdated ? "opencode needs an update" : "ctrl needs opencode"}</h1>
        <p>
          {outdated
            ? `ctrl needs opencode ${check.min} or newer, and you have ${check.version} (${check.bin}). ${v1 ? "Install V2" : "Upgrade it"} in a terminal:`
            : "ctrl is a desktop shell around the opencode TUI, and opencode isn't installed. Install it in a terminal:"}
        </p>
        <div className="setup-command">
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
        {!outdated && (
          <p className="setup-note">
            New to opencode? Run <code>opencode</code> once in a terminal to connect a model provider.
          </p>
        )}
        {check.state === "missing" && check.detail && <p className="setup-note">{check.detail}</p>}
        <p className="setup-note">
          Prefer <a href="https://fx.sh" onClick={(e) => (e.preventDefault(), void window.ctrl.openExternal("https://fx.sh"))}>fx</a>?
          ctrl runs it too: <code>{FX_INSTALL}</code>
        </p>
        <button className="btn primary" disabled={busy} onClick={recheck}>
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
    </div>
  )
}
