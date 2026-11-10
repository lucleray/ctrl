import type { ChatPending } from "./remote"
import type { ChatItem, ChatPage, ChatQueued } from "./remote-chat"

type Deps = {
  page(sessionID: string): Promise<ChatPage>
  pending(sessionID: string): ChatPending[]
  inbox(sessionID: string): Promise<ChatQueued[]>
  updated(sessionID: string, items: ChatItem[]): void
  pendingChanged(sessionID: string, pending: ChatPending[]): void
  inboxChanged(sessionID: string, inbox: ChatQueued[]): void
}

/** While a turn streams, the chat view re-reads the newest messages at most this often (like remote control). */
const THROTTLE_MS = 300

/**
 * The desktop's chat view (Settings → Appearance → Sessions as chat): the one opencode session it shows,
 * refreshed on that session's events. Same reads as remote control's chat (src/main/remote-chat.ts).
 * Refreshes only send the messages that changed since the last one, so a streaming turn re-renders one message.
 */
export class DesktopChat {
  private watching: string | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private pendingJSON = ""
  private inboxJSON = "[]"
  /** What the view has, per message id, as JSON */
  private sent = new Map<string, string>()

  constructor(private deps: Deps) {}

  async open(sessionID: string) {
    this.watching = sessionID
    clearTimeout(this.timer)
    this.timer = undefined
    const [page, inbox] = await Promise.all([this.deps.page(sessionID), this.deps.inbox(sessionID).catch(() => [])])
    const pending = this.deps.pending(sessionID)
    this.pendingJSON = JSON.stringify(pending)
    this.inboxJSON = JSON.stringify(inbox)
    this.sent = new Map(page.items.map((i) => [i.id, JSON.stringify(i)]))
    return { ...page, pending, inbox }
  }

  close() {
    this.watching = null
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Something happened in a session (text streamed, a tool ran, a turn ended, a message was sent). */
  sessionEvent(sessionID: string) {
    if (sessionID !== this.watching || this.timer) return
    this.timer = setTimeout(async () => {
      this.timer = undefined
      if (this.watching !== sessionID) return
      try {
        const [{ items }, inbox] = await Promise.all([this.deps.page(sessionID), this.deps.inbox(sessionID).catch(() => null)])
        if (this.watching !== sessionID) return
        const changed = items.filter((i) => {
          const json = JSON.stringify(i)
          if (this.sent.get(i.id) === json) return false
          this.sent.set(i.id, json)
          return true
        })
        if (changed.length) this.deps.updated(sessionID, changed)
        const json = inbox && JSON.stringify(inbox)
        if (inbox && json !== this.inboxJSON) {
          this.inboxJSON = json!
          this.deps.inboxChanged(sessionID, inbox)
        }
      } catch (err) {
        console.error("[ctrl] chat refresh failed", err)
      }
    }, THROTTLE_MS)
  }

  /** State pushed: permissions and questions may have come or gone. */
  changed() {
    const id = this.watching
    if (!id) return
    const pending = this.deps.pending(id)
    const json = JSON.stringify(pending)
    if (json === this.pendingJSON) return
    this.pendingJSON = json
    this.deps.pendingChanged(id, pending)
  }
}
