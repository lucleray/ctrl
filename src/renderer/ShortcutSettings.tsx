import { useEffect, useState } from "react"
import {
  bindings,
  COMMANDS,
  formatAccel,
  isUsable,
  reservedReason,
  type CommandID,
  type ShortcutOverrides,
} from "../shared/shortcuts"
import { Icon } from "./icons"

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export function ShortcutSettings({ overrides }: { overrides: ShortcutOverrides }) {
  const [recording, setRecording] = useState<CommandID | null>(null)
  const [note, setNote] = useState<{ id: CommandID; text: string; error?: boolean } | null>(null)

  // Main sends every key press here while recording, so ⌘W, ⌘Q etc. can't fire.
  useEffect(() => {
    if (!recording) return
    void window.ctrl.recordShortcut(true)
    const off = window.ctrl.onRecordedKey((accel) => {
      if (accel === "Escape") return setRecording(null)
      if (accel === "Backspace" || accel === "Delete") {
        save(recording, [])
        setNote({ id: recording, text: "Shortcut removed" })
        return setRecording(null)
      }
      const reserved = reservedReason(accel)
      if (reserved) return setNote({ id: recording, text: `${formatAccel(accel)} is taken: ${reserved}`, error: true })
      if (!isUsable(accel)) return setNote({ id: recording, text: "Include ⌘, ⌃ or ⌥", error: true })

      const next: ShortcutOverrides = { ...overrides }
      const taken = COMMANDS.find((c) => c.id !== recording && bindings(c.id, next).includes(accel))
      if (taken) next[taken.id] = bindings(taken.id, next).filter((b) => b !== accel)
      next[recording] = [accel]
      for (const c of COMMANDS) if (next[c.id] && sameList(next[c.id]!, c.defaults)) delete next[c.id]
      void window.ctrl.setSettings({ shortcuts: next })
      setNote(taken ? { id: recording, text: `Moved from “${taken.label}”` } : null)
      setRecording(null)
    })
    return () => {
      off()
      void window.ctrl.recordShortcut(false)
    }
  }, [recording, overrides])

  const save = (id: CommandID, list: string[]) => {
    const next = { ...overrides, [id]: list }
    const command = COMMANDS.find((c) => c.id === id)!
    if (sameList(list, command.defaults)) delete next[id]
    void window.ctrl.setSettings({ shortcuts: next })
  }

  return (
    <div className="settings-card">
      {COMMANDS.map((c) => {
        const list = bindings(c.id, overrides)
        const isRecording = recording === c.id
        const rowNote = note?.id === c.id ? note : null
        return (
          <div className="setting" key={c.id}>
            <div>
              <div className="setting-title">{c.label}</div>
              {(rowNote || c.desc) && (
                <div className={`setting-desc ${rowNote?.error ? "error" : ""}`}>{rowNote?.text ?? c.desc}</div>
              )}
            </div>
            <div className="shortcut-controls">
              {overrides[c.id] && !isRecording && (
                <button
                  className="icon-btn"
                  title={`Reset to ${c.defaults.map(formatAccel).join(" / ")}`}
                  onClick={() => {
                    save(c.id, c.defaults)
                    setNote(null)
                  }}
                >
                  <Icon name="reset" />
                </button>
              )}
              <button
                className={`shortcut-keys ${isRecording ? "recording" : ""}`}
                title={isRecording ? "Esc to cancel, ⌫ to remove" : "Click to change"}
                onClick={() => {
                  setNote(null)
                  setRecording(isRecording ? null : c.id)
                }}
                onBlur={() => isRecording && setRecording(null)}
              >
                {isRecording ? (
                  <span className="shortcut-prompt">Press keys…</span>
                ) : list.length ? (
                  list.map((b) => <kbd key={b}>{formatAccel(b)}</kbd>)
                ) : (
                  <span className="shortcut-prompt">None</span>
                )}
              </button>
            </div>
          </div>
        )
      })}
      <div className="setting">
        <div>
          <div className="setting-title">Jump to session</div>
          <div className="setting-desc">Hold ⌘ to see the numbers next to sessions.</div>
        </div>
        <div className="shortcut-keys static">
          <kbd>⌘1</kbd>…<kbd>⌘9</kbd>
        </div>
      </div>
    </div>
  )
}
