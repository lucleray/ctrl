import { app, Notification, type BrowserWindow } from "electron"
import type { SessionItem, SessionStatus, Settings } from "../shared/types"

type Deps = {
  window(): BrowserWindow | undefined
  settings(): Settings
  isArchived(sessionID: string): boolean
  open(sessionID: string): void
  /** Log instead of showing notifications (headless test runs). */
  quiet: boolean
}

/**
 * Turns session status changes into a dock badge and macOS notifications.
 * Notifications only fire on transitions, and only while ctrl isn't focused.
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

    for (const s of visible) {
      const before = previous.get(s.id)
      if (!before || before === s.status) continue
      if (s.status === "needs-input") this.notify(s, "Needs your input", s.statusDetail)
      else if (before === "running" && s.status === "failed") this.notify(s, "Failed", s.title)
      else if (before === "running" && s.status === "unread") this.notify(s, "Finished", s.title)
    }
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

  private notify(s: SessionItem, title: string, body?: string) {
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
      silent: false,
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
