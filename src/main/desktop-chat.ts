import type { ChatPending } from "./remote"
import type { ChatItem, ChatPage } from "./remote-chat"

type Deps = {
  page(sessionID: string): Promise<ChatPage>
  pending(sessionID: string): ChatPending[]
  updated(sessionID: string, items: ChatItem[]): void
  pendingChanged(sessionID: string, pending: ChatPending[]): void
}

/** While a turn streams, the chat view re-reads the newest messages at most this often (like remote control). */
const THROTTLE_MS = 300

/**
 * The desktop's chat view (Settings → Appearance → Sessions as chat): the one opencode session it shows,
 * refreshed on that session's events. Same reads as remote control's chat (src/main/remote-chat.ts).
 */
export class DesktopChat {
  private watching: string | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private pendingJSON = ""

  constructor(private deps: Deps) {}

  async open(sessionID: string) {
    this.watching = sessionID
    clearTimeout(this.timer)
    this.timer = undefined
    const page = await this.deps.page(sessionID)
    const pending = this.deps.pending(sessionID)
    this.pendingJSON = JSON.stringify(pending)
    return { ...page, pending }
  }

  close() {
    this.watching = null
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Something happened in a session (text streamed, a tool ran, a turn ended). */
  sessionEvent(sessionID: string) {
    if (sessionID !== this.watching || this.timer) return
    this.timer = setTimeout(async () => {
      this.timer = undefined
      if (this.watching !== sessionID) return
      try {
        const { items } = await this.deps.page(sessionID)
        if (this.watching === sessionID) this.deps.updated(sessionID, items)
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
