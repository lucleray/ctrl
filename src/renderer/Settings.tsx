import { useEffect, useRef, useState } from "react"
import { FONT_SIZE, type Appearance, type AppState, type ModelChoices } from "../shared/types"
import { Icon } from "./icons"
import { ModelPicker } from "./ModelPicker"
import { Toggle } from "./Toggle"

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

const DEFAULT = "__default__"

export function Settings({ state, onClose }: { state: AppState; onClose(): void }) {
  const { settings, themes } = state

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
              <div className="setting-desc">Font size of the terminal. Also ⌘+, ⌘− and ⌘0 to reset.</div>
            </div>
            <div className="stepper">
              <button
                title="Smaller (⌘−)"
                disabled={settings.fontSize <= FONT_SIZE.min}
                onClick={() => void window.ctrl.setSettings({ fontSize: settings.fontSize - 1 })}
              >
                −
              </button>
              <button
                className="stepper-value"
                title="Reset to default (⌘0)"
                onClick={() => void window.ctrl.setSettings({ fontSize: FONT_SIZE.default })}
              >
                {settings.fontSize}px
              </button>
              <button
                title="Larger (⌘+)"
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
              <div className="setting-title">Default model</div>
              <div className="setting-desc">
                {modelError
                  ? `Couldn't load models: ${modelError}`
                  : settings.defaultModelEnabled
                    ? "For new sessions started from ctrl. A space can pick its own in space settings."
                    : "Off: ctrl doesn't pick a model, opencode uses its own default."}
              </div>
            </div>
            <div className="setting-actions">
              <ModelPicker
                choices={choices}
                error={modelError}
                value={settings.defaultModel}
                enabled={settings.defaultModelEnabled}
                onChange={(defaultModel) => void window.ctrl.setSettings({ defaultModel })}
                fallback={{ label: "opencode default", detail: choices?.default?.name }}
              />
              <Toggle
                title={settings.defaultModelEnabled ? "Use opencode's default instead" : "Pick a default model"}
                on={settings.defaultModelEnabled}
                onChange={(on) =>
                  void window.ctrl.setSettings({
                    defaultModelEnabled: on,
                    // First time on: start from what opencode would pick anyway.
                    ...(on && !settings.defaultModel && choices?.default
                      ? { defaultModel: { providerID: choices.default.providerID, id: choices.default.id } }
                      : {}),
                  })
                }
              />
            </div>
          </div>
        </div>

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
