import type { OpenCode } from "@opencode/client"

type Client = ReturnType<typeof OpenCode.make>

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

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "reasoning" }
  | { type: "tool"; name: string; summary: string; status: "running" | "done" | "error" }

export type ChatPage = { items: ChatItem[]; cursor: string | null }

/** Messages per page: the newest on open, then older ones on "Load earlier". */
const PAGE = 40
const SUMMARY_MAX = 140
/** Inputs that say what a tool call is about, most telling first (bash's description before its command). */
const SUMMARY_KEYS = ["description", "command", "filePath", "path", "pattern", "url", "query", "prompt", "id", "name"]

function summarize(input: unknown) {
  let obj: Record<string, unknown> = {}
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input)
    } catch {
      return ""
    }
  } else if (input && typeof input === "object") obj = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const v = obj[key]
    if (typeof v === "string" && v.trim()) {
      const line = v.trim().replace(/\s+/g, " ")
      return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
    }
  }
  return ""
}

type Message = { id: string; type: string; time: { created: number; completed?: number }; [k: string]: any }

type Attachment = { data: string; mime: string }

function imagesOf(m: Message): Attachment[] {
  return ((m.files ?? []) as Attachment[]).filter((f) => typeof f.data === "string" && f.mime?.startsWith("image/"))
}

function toItem(m: Message): ChatItem | null {
  if (m.type === "user") {
    const images = imagesOf(m).length
    if (!m.text?.trim() && !images) return null
    return { id: m.id, kind: "user", time: m.time.created, text: m.text ?? "", ...(images ? { images } : {}) }
  }
  if (m.type !== "assistant") return null
  const parts: ChatPart[] = []
  for (const c of m.content ?? []) {
    if (c.type === "text") {
      if (c.text?.trim()) parts.push({ type: "text", text: c.text })
    } else if (c.type === "reasoning") {
      // One marker for a run of thinking, not one per block.
      if (parts.at(-1)?.type !== "reasoning") parts.push({ type: "reasoning" })
    } else if (c.type === "tool") {
      const status = c.state?.status === "completed" ? "done" : c.state?.status === "error" ? "error" : "running"
      parts.push({ type: "tool", name: c.name, summary: summarize(c.state?.input), status })
    }
  }
  const error = m.error ? String(m.error.message ?? m.error.type ?? "Failed") : undefined
  if (!parts.length && !error && m.time.completed) return null
  return { id: m.id, kind: "assistant", time: m.time.created, live: !m.time.completed, parts, error }
}

/**
 * The newest page of a session's messages (no cursor), or the page before `cursor`. Oldest first, so the
 * phone appends. Bounded: one request of PAGE messages, whatever the session's length.
 */
export async function chatPage(client: Client, sessionID: string, cursor?: string): Promise<ChatPage> {
  const res = cursor
    ? await client.message.list({ sessionID, cursor })
    : await client.message.list({ sessionID, limit: PAGE, order: "desc" })
  const items = (res.data as unknown as Message[]).map(toItem).filter((i): i is ChatItem => !!i)
  items.sort((a, b) => a.time - b.time)
  return { items, cursor: res.cursor.next ?? null }
}

/** The index-th image attached to a message you sent, for the phone's <img> (null when there's none). */
export async function chatImage(client: Client, sessionID: string, messageID: string, index: number) {
  const res = (await client.session.message.get({ sessionID, messageID })) as unknown as Message & { data?: Message }
  const m = res.data ?? res
  const file = m.type === "user" ? imagesOf(m)[index] : undefined
  return file ? { mime: file.mime, body: Buffer.from(file.data, "base64") } : null
}
