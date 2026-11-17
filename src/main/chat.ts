import type { HarnessChat, HarnessSource } from "./harness"
import type { FormAnswer } from "./remote"
import type { ChatQueued } from "./remote-chat"
import type { ChatAttachment, ChatStats, ModelRef, SessionStatus } from "../shared/types"

/** How long a message sent mid-turn waits before what holds the turn goes to the background: most shells are done by then. */
export const BACKGROUND_GRACE_MS = 3000

type Deps = {
  /** The harness a session belongs to (main's sourceOf). */
  source(sessionID: string): HarnessSource | undefined
  /** The session's status in the sidebar, read before sending (a message to an idle session starts a turn). */
  status(sessionID: string): SessionStatus | undefined
  title(sessionID: string): string | undefined
  /** Runs `run` after `ms` (setTimeout); tests run it when they choose. */
  schedule?: (run: () => void, ms: number) => void
}

/**
 * Sessions as a chat, whatever their harness: the desktop's chat view and remote control's phone view call
 * these, and each call goes to the session's harness (HarnessSource.chat). A session whose harness has no chat
 * throws on the calls that need one.
 */
export function createChat(deps: Deps) {
  const schedule = deps.schedule ?? ((run, ms) => void setTimeout(run, ms))

  const chatOf = (sessionID: string): HarnessChat | undefined => deps.source(sessionID)?.chat
  const need = (sessionID: string): HarnessChat => {
    const chat = chatOf(sessionID)
    if (!chat) throw new Error("This session can't open as a chat")
    return chat
  }

  /**
   * A message sent mid-turn that still waits after the grace period: a shell or subagent holds the turn, so it
   * goes on in the background (harnesses that can: src/main/harness.ts) and the agent reads the message. A turn
   * that's only thinking has nothing to move, and isn't interrupted.
   */
  function backgroundIfHeld(sessionID: string, messageID: string) {
    const source = deps.source(sessionID)
    const inbox = source?.chat?.inbox?.bind(source.chat)
    if (!source?.background || !inbox) return
    schedule(async () => {
      try {
        const waiting = await inbox(sessionID)
        if (waiting.some((q) => q.id === messageID)) await source.background!(sessionID)
      } catch (err) {
        console.error("[ctrl] moving to the background failed", err)
      }
    }, BACKGROUND_GRACE_MS)
  }

  return {
    /** Whether a session can open as a chat. */
    can: (sessionID: string) => !!chatOf(sessionID),
    page: (sessionID: string, cursor?: string, detail = false) => need(sessionID).page(sessionID, cursor, detail),
    pending: (sessionID: string) => chatOf(sessionID)?.pending(sessionID) ?? [],
    inbox: async (sessionID: string): Promise<ChatQueued[]> => {
      const chat = need(sessionID)
      return chat.inbox ? chat.inbox(sessionID) : []
    },
    title: (sessionID: string) => deps.title(sessionID),
    /** Steers a running turn; a shell or subagent that holds it back goes to the background (what ⌃B does in opencode's TUI). */
    send: async (sessionID: string, text: string, attachments: ChatAttachment[]) => {
      const chat = need(sessionID)
      // Before sending: the turn this message starts in an idle session is not one to cut short.
      const midTurn = deps.status(sessionID) === "running"
      const id = await chat.send(sessionID, text, attachments)
      if (midTurn && id) backgroundIfHeld(sessionID, id)
      return id
    },
    stop: (sessionID: string) => need(sessionID).stop(sessionID),
    reply: (sessionID: string, requestID: string, decision: "once" | "always" | "reject") =>
      need(sessionID).reply(sessionID, requestID, decision),
    answer: async (sessionID: string, formID: string, answer: FormAnswer | null) => {
      await need(sessionID).answer?.(sessionID, formID, answer)
    },
    image: async (sessionID: string, messageID: string, index: number) => {
      const chat = need(sessionID)
      return chat.image ? chat.image(sessionID, messageID, index) : null
    },
    model: async (sessionID: string): Promise<ModelRef | null> => {
      const chat = need(sessionID)
      return chat.model ? chat.model.get(sessionID) : null
    },
    setModel: async (sessionID: string, model: ModelRef) => {
      await need(sessionID).model?.set(sessionID, model)
    },
    stats: async (sessionID: string): Promise<ChatStats> => {
      const chat = need(sessionID)
      return chat.stats ? chat.stats(sessionID) : { cost: 0, context: null }
    },
  }
}

export type Chat = ReturnType<typeof createChat>
