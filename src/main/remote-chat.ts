import type { OpenCode } from "@opencode/client"

type Client = ReturnType<typeof OpenCode.make>

/** What opencode moves to the background (`session.background`), and tells the agent about once it ends. */
type Backgrounded = "shell" | "subagent"

/** One message as the phone's chat view draws it (src/remote/client.ts). */
export type ChatItem =
  | {
      id: string
      kind: "user"
      time: number
      text: string
      /** Images attached to it, fetched one by one from /file/<session>/<message>/<index> (src/main/remote.ts) */
      images?: number
    }
  | {
      id: string
      kind: "assistant"
      time: number
      /** Still streaming */
      live: boolean
      parts: ChatPart[]
      error?: string
    }
  /** A shell or subagent that ran in the background ended: what opencode tells the agent, which starts a turn. */
  | { id: string; kind: "note"; time: number; source: Backgrounded; failed: boolean; text: string }

export type ChatPart =
  | { type: "text"; text: string }
  /** text: what it thought, desktop only (`detail`) */
  | { type: "reasoning"; text?: string }
  | {
      type: "tool"
      name: string
      summary: string
      /** background: it was moved to the background and its turn went on (it may have ended since) */
      status: "running" | "background" | "done" | "error"
      /** Desktop only (`detail`): the full shell command, else the summary's input in full when it was cut */
      command?: string
      detail?: string
    }

export type ChatPage = { items: ChatItem[]; cursor: string | null }

/** A message you sent that opencode hasn't handed to the agent yet (its inbox): it steers at the next step. */
export type ChatQueued = { id: string; text: string; images: number }

/** Messages per page: the newest on open, then older ones on "Load earlier". */
const PAGE = 40
const SUMMARY_MAX = 140
/** Inputs that say what a tool call is about, most telling first (bash's description before its command). */
const SUMMARY_KEYS = ["description", "command", "filePath", "path", "pattern", "url", "query", "prompt", "id", "name"]
const BACKGROUNDED: Record<string, Backgrounded> = { shell: "shell", subagent: "subagent" }

function inputOf(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return JSON.parse(input)
    } catch {
      return {}
    }
  }
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

function summarize(obj: Record<string, unknown>) {
  for (const key of SUMMARY_KEYS) {
    const v = obj[key]
    if (typeof v === "string" && v.trim()) {
      const full = v.trim()
      const line = full.replace(/\s+/g, " ")
      return { summary: line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line, full }
    }
  }
  return { summary: "", full: "" }
}

type Message = { id: string; type: string; time: { created: number; completed?: number }; [k: string]: any }

type Attachment = { data: string; mime: string }

function imagesOf(m: Message): Attachment[] {
  return ((m.files ?? []) as Attachment[]).filter((f) => typeof f.data === "string" && f.mime?.startsWith("image/"))
}

function toItem(m: Message, detail: boolean): ChatItem | null {
  if (m.type === "user") {
    const images = imagesOf(m).length
    if (!m.text?.trim() && !images) return null
    return { id: m.id, kind: "user", time: m.time.created, text: m.text ?? "", ...(images ? { images } : {}) }
  }
  if (m.type === "synthetic") {
    // Only the ones about background work: opencode also sends the agent instructions this way.
    const source = BACKGROUNDED[m.metadata?.source]
    if (!source) return null
    const failed = m.metadata.state !== "completed" || (typeof m.metadata.exit === "number" && m.metadata.exit !== 0)
    return { id: m.id, kind: "note", time: m.time.created, source, failed, text: summarize({ description: m.description }).summary }
  }
  if (m.type !== "assistant") return null
  const parts: ChatPart[] = []
  for (const c of m.content ?? []) {
    if (c.type === "text") {
      if (c.text?.trim()) parts.push({ type: "text", text: c.text })
    } else if (c.type === "reasoning") {
      // One marker for a run of thinking, not one per block.
      const last = parts.at(-1)
      const text = detail && typeof c.text === "string" ? c.text.trim() : ""
      if (last?.type !== "reasoning") parts.push(detail ? { type: "reasoning", text } : { type: "reasoning" })
      else if (text) last.text = last.text ? `${last.text}\n\n${text}` : text
    } else if (c.type === "tool") {
      // Moved to the background: the call is over for the turn, while what it started kept running.
      const moved = c.state?.status === "completed" && c.state.metadata?.status === "running"
      const status = moved ? "background" : c.state?.status === "completed" ? "done" : c.state?.status === "error" ? "error" : "running"
      const input = inputOf(c.state?.input)
      const { summary, full } = summarize(input)
      const part: ChatPart = { type: "tool", name: c.name, summary, status }
      if (detail) {
        if (typeof input.command === "string" && input.command.trim()) part.command = input.command.trim()
        else if (full && full !== summary) part.detail = full
      }
      parts.push(part)
    }
  }
  const error = m.error ? String(m.error.message ?? m.error.type ?? "Failed") : undefined
  if (!parts.length && !error && m.time.completed) return null
  return { id: m.id, kind: "assistant", time: m.time.created, live: !m.time.completed, parts, error }
}

/**
 * The newest page of a session's messages (no cursor), or the page before `cursor`. Oldest first, so the
 * phone appends. Bounded: one request of PAGE messages, whatever the session's length. `detail` adds what
 * only the desktop shows (thinking text, full commands), kept off the phone's refreshes.
 */
export async function chatPage(client: Client, sessionID: string, cursor?: string, detail = false): Promise<ChatPage> {
  const res = cursor
    ? await client.message.list({ sessionID, cursor })
    : await client.message.list({ sessionID, limit: PAGE, order: "desc" })
  const items = (res.data as unknown as Message[]).map((m) => toItem(m, detail)).filter((i): i is ChatItem => !!i)
  items.sort((a, b) => a.time - b.time)
  // A short page is the whole history: no "Load earlier" for a cursor that leads nowhere.
  const short = !cursor && res.data.length < PAGE
  return { items, cursor: short ? null : (res.cursor.next ?? null) }
}

/** Messages waiting in the session's inbox, oldest first. */
export async function chatInbox(client: Client, sessionID: string): Promise<ChatQueued[]> {
  const res = (await client.session.inbox.list({ sessionID })) as unknown
  const list = (Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? [])) as Array<Record<string, any>>
  return list
    .filter((i) => i.type === "user")
    .sort((a, b) => a.time.created - b.time.created)
    .map((i) => ({
      id: String(i.id),
      text: String(i.payload?.text ?? ""),
      images: ((i.payload?.files ?? []) as Attachment[]).filter((f) => f.mime?.startsWith("image/")).length,
    }))
}

/** The index-th image attached to a message you sent, for the phone's <img> (null when there's none). */
export async function chatImage(client: Client, sessionID: string, messageID: string, index: number) {
  const res = (await client.session.message.get({ sessionID, messageID })) as unknown as Message & { data?: Message }
  const m = res.data ?? res
  const file = m.type === "user" ? imagesOf(m)[index] : undefined
  return file ? { mime: file.mime, body: Buffer.from(file.data, "base64") } : null
}
