import { useEffect, useRef, useState } from "react"
import type { ModelChoices, ModelRef, Space } from "../shared/types"
import { shortPath } from "./format"
import { Icon } from "./icons"
import { ModelPicker } from "./ModelPicker"
import { Toggle } from "./Toggle"

export function SpaceSettings({
  space,
  appDefault,
  onClose,
}: {
  space: Space
  /** Settings → default model, used when the space doesn't pick one */
  appDefault: ModelRef | null
  onClose(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [name, setName] = useState(space.name)
  const [instructions, setInstructions] = useState(space.instructions ?? "")
  const [choices, setChoices] = useState<ModelChoices | null>(null)
  const [modelError, setModelError] = useState<string>()

  // Take focus away from the terminal so keystrokes don't leak into the TUI.
  useEffect(() => root.current?.focus(), [])

  useEffect(() => {
    let live = true
    setModelError(undefined)
    window.ctrl.listModels(space.directory).then(
      (c) => live && setChoices(c),
      (err) => live && setModelError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [space.directory])

  // Older state has a model but no flag: that meant on.
  const modelOn = space.modelEnabled ?? !!space.model

  // Text fields save on blur; also flush on close, which unmounts without a blur.
  const pending = useRef({ name, instructions })
  pending.current = { name, instructions }
  const saveName = () => {
    const next = pending.current.name.trim()
    if (next && next !== space.name) void window.ctrl.updateSpace(space.id, { name: next })
    else setName(space.name)
  }
  const saveInstructions = () => {
    if (pending.current.instructions !== (space.instructions ?? ""))
      void window.ctrl.updateSpace(space.id, { instructions: pending.current.instructions || null })
  }
  const flush = useRef(() => {})
  flush.current = () => {
    saveName()
    saveInstructions()
  }
  useEffect(() => () => flush.current(), [])

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
          <h1>{space.name}</h1>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="settings-sub">Space settings · apply to new sessions started in this space</div>

        <h2>General</h2>
        <div className="settings-card">
          <div className="setting">
            <div>
              <div className="setting-title">Name</div>
            </div>
            <input
              className="setting-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur()
              }}
            />
          </div>

          <div className="setting">
            <div>
              <div className="setting-title">Folder</div>
              <div className="setting-desc">New sessions start here. {space.directory ? "" : "Defaults to ~."}</div>
            </div>
            <div className="setting-actions">
              {space.directory && (
                <span className="setting-path" title={space.directory}>
                  {/* LRM marks keep slashes in place inside the rtl (start-ellipsis) box */}
                  {`\u200e${shortPath(space.directory)}\u200e`}
                </span>
              )}
              <button className="btn" onClick={() => void window.ctrl.pickSpaceFolder(space.id)}>
                {space.directory ? "Change…" : "Choose…"}
              </button>
              {space.directory && (
                <button
                  className="icon-btn"
                  title="Clear folder"
                  onClick={() => void window.ctrl.updateSpace(space.id, { directory: null })}
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
                Model for new sessions in this space. You can still switch models inside a session.
              </div>
            </div>
            <Toggle
              on={modelOn}
              onChange={(on) =>
                void window.ctrl.updateSpace(space.id, {
                  modelEnabled: on,
                  // First time on: start from the app's custom model, if there is one.
                  ...(on && !space.model && appDefault ? { model: appDefault } : {}),
                })
              }
            />
          </div>
          <div className="setting-sub">
            <ModelPicker
              choices={choices}
              error={modelError}
              value={space.model ?? null}
              enabled={modelOn}
              onChange={(model) => void window.ctrl.updateSpace(space.id, { model })}
              fallback={
                appDefault
                  ? { label: "App custom model", detail: "Uses the custom model from ctrl's settings" }
                  : { label: "Default opencode model", detail: "ctrl doesn't set a model, so opencode uses its own default" }
              }
            />
          </div>
        </div>

        <h2>Instructions</h2>
        <div className="settings-card">
          <div className="setting setting-stack">
            <div className="setting-desc wide">
              Added to every new session in this space as extra instructions. They don't show up in the chat, and the
              model sees them on every turn.
            </div>
            <textarea
              className="setting-textarea"
              placeholder="e.g. This space is for PR reviews in vercel/front. Use the review-pr skill and keep comments short."
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={saveInstructions}
              rows={8}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
