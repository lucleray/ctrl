import type { OpenCode } from "@opencode/client"
import type { HarnessChat } from "./harness"
import type { ChatPending, FormAnswer } from "./remote"
import { chatImage, chatInbox, chatPage } from "./remote-chat"
import type { ChatAttachment, ChatStats, ModelRef } from "../shared/types"

type Client = ReturnType<typeof OpenCode.make>

type Deps = {
  /** The connected client; throws while opencode isn't connected. */
  client(): Client
  /** Permissions and questions waiting in a session (OpenCodeService.pendingFor). */
  pending(sessionID: string): ChatPending[]
}

type Assistant = {
  type: string
  model?: ModelRef
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

/**
 * opencode sessions as a chat (src/main/harness.ts → HarnessChat), over its client: the desktop's chat view
 * and remote control's phone view both read and write through here. Messages become chat items in
 * src/main/remote-chat.ts.
 */
export class OpenCodeChat implements HarnessChat {
  /** Context window per model ("provider::id"), read once per run: model.list is too heavy to call per stats. */
  private contextLimits = new Map<string, number | null>()

  onChange?: (sessionID: string, modelChanged: boolean) => void

  constructor(private deps: Deps) {}

  page(sessionID: string, cursor?: string, detail = false) {
    return chatPage(this.deps.client(), sessionID, cursor, detail)
  }

  pending(sessionID: string) {
    return this.deps.pending(sessionID)
  }

  inbox(sessionID: string) {
    return chatInbox(this.deps.client(), sessionID)
  }

  image(sessionID: string, messageID: string, index: number) {
    return chatImage(this.deps.client(), sessionID, messageID, index)
  }

  /** Steer, never queue: a message sent mid-turn reaches the agent at its next step (src/main/chat.ts). */
  async send(sessionID: string, text: string, attachments: ChatAttachment[]) {
    const files = attachments.map(({ uri, label }, i) => {
      const pdf = uri.startsWith("data:application/pdf;")
      const name = pdf ? `document-${i + 1}.pdf` : `photo-${i + 1}.${uri.slice(11, uri.indexOf(";"))}`
      // Where its placeholder sits in the text, like opencode's TUI sends it.
      const start = label ? text.indexOf(label) : -1
      return { uri, name, ...(start >= 0 ? { mention: { start, end: start + label!.length, text: label! } } : {}) }
    })
    const sent = await this.deps.client().session.prompt({ sessionID, text, delivery: "steer", ...(files.length ? { files } : {}) })
    return sent?.id
  }

  async stop(sessionID: string) {
    await this.deps.client().session.interrupt({ sessionID })
  }

  async reply(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
    await this.deps.client().permission.reply({ sessionID, requestID, decision })
  }

  async answer(sessionID: string, formID: string, answer: FormAnswer | null) {
    const client = this.deps.client()
    if (answer) await client.session.form.reply({ sessionID, formID, answer })
    else await client.session.form.cancel({ sessionID, formID })
  }

  model = {
    /** The session's model, else what opencode would use in its folder (a session that never picked one). */
    get: async (sessionID: string): Promise<ModelRef | null> => {
      const client = this.deps.client()
      const session = await client.session.get({ sessionID })
      if (session.model) return { providerID: session.model.providerID, id: session.model.id, variant: session.model.variant }
      const fallback = await client.model.default({ location: { directory: session.location.directory } }).catch(() => null)
      return fallback?.data ? { providerID: fallback.data.providerID, id: fallback.data.id } : null
    },
    set: async (sessionID: string, model: ModelRef) => {
      await this.deps.client().session.switchModel({
        sessionID,
        model: { providerID: String(model.providerID), id: String(model.id), ...(model.variant ? { variant: String(model.variant) } : {}) },
      })
    },
  }

  /** Spend so far and how full the context is, from the newest assistant message that reports tokens. */
  async stats(sessionID: string): Promise<ChatStats> {
    const client = this.deps.client()
    const [session, recent] = await Promise.all([
      client.session.get({ sessionID }),
      client.message.list({ sessionID, limit: 20, order: "desc" }),
    ])
    const used = (m: Assistant) => {
      const t = m.tokens
      return t ? t.input + t.output + t.reasoning + t.cache.read + t.cache.write : 0
    }
    // Interrupted or failed steps report zero tokens: skip back to the newest one that used some.
    const last = (recent.data as unknown as Assistant[]).find((m) => m.type === "assistant" && m.model && used(m) > 0)
    const context: ChatStats["context"] = last?.model
      ? { used: used(last), limit: await this.contextLimit(last.model, session.location.directory) }
      : null
    return { cost: session.cost ?? 0, context }
  }

  private async contextLimit(model: ModelRef, directory: string) {
    const key = `${model.providerID}::${model.id}`
    if (!this.contextLimits.has(key)) {
      const list = await this.deps.client().model.list({ location: { directory } }).catch(() => null)
      for (const m of list?.data ?? []) this.contextLimits.set(`${m.providerID}::${m.id}`, m.limit?.context || null)
      if (!this.contextLimits.has(key)) return null
    }
    return this.contextLimits.get(key) ?? null
  }
}
