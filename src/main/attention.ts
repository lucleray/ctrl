import { app, Notification, type BrowserWindow } from "electron"
import { SOUND_EVENTS, type SessionItem, type SessionStatus, type Settings, type SoundEvent } from "../shared/types"
import { playSound } from "./sound"

type Deps = {
  window(): BrowserWindow | undefined
  settings(): Settings
  isArchived(sessionID: string): boolean
  open(sessionID: string): void
  /** Log instead of showing notifications (headless test runs). */
  quiet: boolean
}

/**
 * Turns session status changes into a dock badge, sounds and macOS notifications.
 * Sounds and notifications only fire on transitions. Notifications only while ctrl isn't
 * focused; sounds too unless soundsWhenFocused is on.
 */
export class Attention {
  private previous?: Map<string, SessionStatus>
  // Keep references so notifications aren't garbage-collected before they're clicked.
  private live = new Set<Notification>()

  constructor(private deps: Deps) {}

  update(sessions: SessionItem[]) {
    const visible = sessions.filter((s) => !this.deps.isArchived(s.id))
    this.badge(visible)

    const previous = this.previous
    this.previous = new Map(sessions.map((s) => [s.id, s.status]))
    if (!previous) return // first load: don't notify about pre-existing state

    const events: [SessionItem, SoundEvent][] = []
    for (const s of visible) {
      const before = previous.get(s.id)
      if (!before || before === s.status) continue
      if (s.status === "needs-input") events.push([s, "needs-input"])
      else if (before === "running" && s.status === "failed") events.push([s, "failed"])
      else if (before === "running" && s.status === "unread") events.push([s, "finished"])
    }
    if (!events.length) return

    const played = this.sound(events.map(([, e]) => e))
    for (const [s, e] of events) {
      if (e === "needs-input") this.notify(s, "Needs your input", s.statusDetail, played)
      else if (e === "failed") this.notify(s, "Failed", s.title, played)
      else this.notify(s, "Finished", s.title, played)
    }
  }

  /** One sound per update, for the most urgent event. Returns whether ctrl played (or chose silence for) it. */
  private sound(events: SoundEvent[]): boolean {
    const settings = this.deps.settings()
    if (!settings.sounds) return false
    if (this.deps.window()?.isFocused() && !settings.soundsWhenFocused) return false
    const event = SOUND_EVENTS.find((e) => events.includes(e.id))!.id
    const choice = settings.soundChoices[event]
    if (!choice) return true
    if (this.deps.quiet) console.log(`[ctrl] sound (suppressed): ${event} · ${choice}`)
    else playSound(choice)
    return true
  }

  /** Re-applies the badge after the setting changes. */
  refreshBadge(sessions: SessionItem[]) {
    this.badge(sessions.filter((s) => !this.deps.isArchived(s.id)))
  }

  private badge(sessions: SessionItem[]) {
    if (process.platform !== "darwin" || !app.dock) return
    const count = sessions.filter((s) => s.status === "needs-input").length
    app.dock.setBadge(this.deps.settings().dockBadge && count > 0 ? String(count) : "")
  }

  private notify(s: SessionItem, title: string, body: string | undefined, soundHandled: boolean) {
    if (!this.deps.settings().notifications || !Notification.isSupported()) return
    if (this.deps.window()?.isFocused()) return
    if (this.deps.quiet) {
      console.log(`[ctrl] notification (suppressed): ${title} · ${s.title} · ${body ?? ""}`)
      return
    }
    const n = new Notification({
      title: title === "Needs your input" ? `${s.title}` : title,
      subtitle: title === "Needs your input" ? title : undefined,
      body: body ?? s.title,
      // ctrl's own sound replaces the system one when sounds are on.
      silent: soundHandled,
    })
    n.on("click", () => {
      const win = this.deps.window()
      win?.show()
      win?.focus()
      this.deps.open(s.id)
    })
    n.on("close", () => this.live.delete(n))
    this.live.add(n)
    n.show()
  }
}
