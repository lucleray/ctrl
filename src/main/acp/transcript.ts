import { inputOf, summarize, type ChatItem, type ChatPage, type ChatPart } from "../remote-chat"

/**
 * An ACP session's updates (`session/update`) turned into chat items, the same ones opencode's messages become
 * in src/main/remote-chat.ts, so the chat views draw both alike. Built in order from a replay (`session/load`)
 * and then live updates; the views read pages from it.
 *
 * A user message starts an item; the agent's text, thoughts and tool calls that follow form one assistant item,
 * until the next user message (a steer splits the reply in two). The assistant item is live until `endTurn`.
 */

/** One `session/update` as ACP sends it; only the fields read here. */
export type SessionUpdate = {
  sessionUpdate: string
  messageId?: string
  content?: Content | ToolContent[]
  toolCallId?: string
  name?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: unknown
  _meta?: Record<string, unknown>
}

type Content = { type: string; text?: string; data?: string; mimeType?: string }
type ToolContent = { type: string; content?: Content }

export type ImageData = { mime: string; data: string }

type Live = ChatItem & { kind: "assistant" }

/** Messages per page: the newest on open, then older ones on "Load earlier" (same as opencode's). */
const PAGE = 40

/**
 * fx 0.0.17 sends its operational notices (skill warnings, context limits) as reply text, in chunks of their
 * own before the reply (vercel-labs/fx#1016; #1739 makes them `notice` updates). They aren't the agent's words.
 */
const NOTICE = /^(skill discovery warning:|\[context\] )/

/** Tool statuses as ACP names them → the chat's. Anything unknown is still running. */
const TOOL_STATUS: Record<string, "done" | "error"> = {
  completed: "done",
  failed: "error",
}

export class Transcript {
  readonly items: ChatItem[] = []
  /** Images attached to each user message, by item id, for the chat's <img>. */
  private images = new Map<string, ImageData[]>()
  /** Tool parts by ACP toolCallId, so updates find them. */
  private tools = new Map<string, ChatPart & { type: "tool" }>()
  /** The assistant item that collects the agent's output now, if a turn is open. */
  private current: Live | null = null
  /** The user message whose chunks still arrive (chunks of one message share a messageId). */
  private lastUser: { id: string; messageId: string | undefined } | null = null
  private seq = 0
  /** Items need increasing times to sort; updates carry none, so each gets the clock's or the one after the last. */
  private lastTime = 0

  constructor(private now: () => number = Date.now) {}

  /** Applies one update. Returns true when the items changed. */
  apply(update: SessionUpdate): boolean {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return this.userChunk(update)
      case "agent_message_chunk":
        return this.agentText(update, "text")
      case "agent_thought_chunk":
        return this.agentText(update, "reasoning")
      case "tool_call":
        return this.toolCall(update)
      case "tool_call_update":
        return this.toolUpdate(update)
      default:
        // session_info_update, usage_update, available_commands_update, notice, plan…: not part of the transcript.
        return false
    }
  }

  /** The turn ended (the prompt request came back): the reply is final, with the error that ended it, if any. */
  endTurn(error?: string) {
    const item = this.current
    this.current = null
    this.lastUser = null
    if (!item) {
      // Failed before saying anything: the error still needs a reply to sit on.
      if (error) this.items.push({ id: `a${++this.seq}`, kind: "assistant", time: this.time(), live: false, parts: [], error })
      return !!error
    }
    item.live = false
    if (error) item.error = error
    // Nothing came back and nothing went wrong: no empty reply.
    if (!item.parts.length && !item.error) this.items.splice(this.items.indexOf(item), 1)
    return true
  }

  /** Whether a reply is being collected (a turn runs). */
  get open() {
    return this.current !== null
  }

  /**
   * The newest page (no cursor), or the page before `cursor`, oldest first. The cursor is the index of the
   * first item of the page it came with. `detail`: thinking text and full commands, which only the desktop shows.
   */
  page(cursor?: string, detail = false): ChatPage {
    const end = cursor === undefined ? this.items.length : Math.max(0, Math.min(this.items.length, Number(cursor) || 0))
    const start = Math.max(0, end - PAGE)
    const items = this.items.slice(start, end).map((i) => (detail ? i : withoutDetail(i)))
    return { items, cursor: start > 0 ? String(start) : null }
  }

  /** The index-th image attached to a message you sent. */
  image(itemID: string, index: number) {
    return this.images.get(itemID)?.[index]
  }

  private time() {
    this.lastTime = Math.max(this.now(), this.lastTime + 1)
    return this.lastTime
  }

  private userChunk(update: SessionUpdate) {
    const content = update.content as Content | undefined
    if (!content) return false
    // A reply in progress ends here: a steer joined the turn, and what follows it is a new reply.
    if (this.current) {
      this.current.live = false
      if (!this.current.parts.length) this.items.splice(this.items.indexOf(this.current), 1)
      this.current = null
    }
    let item = this.lastUser && this.items.find((i): i is ChatItem & { kind: "user" } => i.id === this.lastUser!.id)
    if (!item || this.lastUser!.messageId !== update.messageId || !update.messageId) {
      item = { id: `u${++this.seq}`, kind: "user", time: this.time(), text: "" }
      this.items.push(item)
      this.lastUser = { id: item.id, messageId: update.messageId }
    }
    if (content.type === "text") item.text += content.text ?? ""
    else if (content.type === "image" && typeof content.data === "string") {
      const list = this.images.get(item.id) ?? []
      list.push({ mime: content.mimeType || "image/png", data: content.data })
      this.images.set(item.id, list)
      item.images = list.length
    }
    return true
  }

  private reply(): Live {
    if (this.current) return this.current
    const item: Live = { id: `a${++this.seq}`, kind: "assistant", time: this.time(), live: true, parts: [] }
    this.items.push(item)
    this.current = item
    this.lastUser = null
    return item
  }

  private agentText(update: SessionUpdate, type: "text" | "reasoning") {
    const content = update.content as Content | undefined
    const text = content?.type === "text" ? (content.text ?? "") : ""
    if (!text || (type === "text" && NOTICE.test(text))) return false
    const item = this.reply()
    const last = item.parts.at(-1)
    if (last?.type === type) last.text = (last.text ?? "") + text
    else item.parts.push({ type, text })
    return true
  }

  private toolCall(update: SessionUpdate) {
    if (!update.toolCallId) return false
    const input = inputOf(update.rawInput)
    const { summary, full } = summarize(input)
    const name = update.name || update.title || update.kind || "tool"
    const part: ChatPart & { type: "tool" } = { type: "tool", name, summary: summary || update.title || "", status: statusOf(update.status) }
    if (typeof input.command === "string" && input.command.trim()) part.command = input.command.trim()
    else if (full && full !== summary) part.detail = full
    this.tools.set(update.toolCallId, part)
    this.reply().parts.push(part)
    return true
  }

  private toolUpdate(update: SessionUpdate) {
    const part = update.toolCallId ? this.tools.get(update.toolCallId) : undefined
    if (!part) return false
    if (update.status) part.status = statusOf(update.status)
    return true
  }
}

function statusOf(status: string | undefined) {
  return (status && TOOL_STATUS[status]) || "running"
}

/** The item without what only the desktop shows (thinking text, full commands), like opencode's `detail` off. */
function withoutDetail(item: ChatItem): ChatItem {
  if (item.kind !== "assistant") return item
  return {
    ...item,
    parts: item.parts.map((p) => {
      if (p.type === "reasoning") return { type: "reasoning" }
      if (p.type === "tool") {
        const { command: _c, detail: _d, ...rest } = p
        return rest
      }
      return p
    }),
  }
}
