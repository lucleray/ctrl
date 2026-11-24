import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { AcpClient, AcpError, type AcpTransport } from "./acp/client"
import { Transcript, type SessionUpdate } from "./acp/transcript"
import { fxID, rawID, type LiveStatus } from "./fx"
import type { HarnessChat } from "./harness"
import type { ChatPending, FormAnswer } from "./remote"
import type { ChatQueued } from "./remote-chat"
import type { ChatAttachment, ChatStats, ModelRef } from "../shared/types"

/**
 * fx sessions as a chat (src/main/harness.ts → HarnessChat), over `fx acp`: one fx process per open chat
 * session, speaking the Agent Client Protocol on its stdio (src/main/acp/client.ts). The process loads the
 * session (`session/load` replays it into a Transcript), runs its turns (`session/prompt`), and answers its
 * permission requests from the chat. fx holds the session's lock while the process runs, like a terminal would,
 * so a session is a chat one or a terminal one, never both at once: ctrl decides when it creates the session
 * (`isChat`), and the choice sticks.
 *
 * The process stands in for a pty in FxTerminals (`ChatProc`), so the screen, status and restore logic treat
 * chat sessions like terminal ones. Errors from fx are plain errors with fx's message.
 */

/** What FxTerminals keeps of the process (src/main/fx-terminals.ts). */
export type ChatProc = { pid: number; kill(): void }

type Deps = {
  /** fx's binary, when found (src/main/fx.ts findFx). */
  bin(): string | undefined
  /** Environment for the process (child-env + FX_ENV), like a terminal's. */
  env(): Record<string, string>
  /** Whether this fx session is a chat one (decided when it was created). */
  isChat(sessionID: string): boolean
  /** A session's folder, for `session/load` (undefined: unknown session). */
  directory(sessionID: string): string | undefined
  /** A process started for a session: FxTerminals registers it as the session's pane. */
  onOpen(sessionID: string, proc: ChatProc, cwd: string, background: boolean): void
  /** Its status changed (working, blocked, done, error), for the sidebar. */
  onStatus(sessionID: string, status: LiveStatus | undefined): void
  /** The process is gone. */
  onExit(sessionID: string, code: number | null): void
  /** Tests: a fake agent instead of a real process. */
  spawn?: (bin: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ChildProcessWithoutNullStreams
  now?: () => number
}

type Permission = {
  id: string
  detail: string
  options: { optionId: string; kind: string }[]
  resolve(result: unknown): void
}

type ConfigOption = { id: string; currentValue?: unknown; options?: { value: string; name?: string }[] }

type Open = {
  sessionID: string
  proc: ChildProcessWithoutNullStreams
  client: AcpClient
  transcript: Transcript
  /** initialize + session/load (or session/new) done */
  ready: Promise<void>
  /** The running turn's prompt request */
  turn: Promise<unknown> | null
  pending: Permission[]
  /** Steers sent during a turn, not yet taken by it (shown as the chat's queue) */
  steers: { id: string; text: string }[]
  status: LiveStatus | undefined
  config: ConfigOption[]
  usage: { used: number; size: number } | null
  cwd: string
  /** FxTerminals knows this process (onOpen), so it hears when it's gone (onExit) */
  registered: boolean
  gone: boolean
}

export type NewChatOptions = {
  cwd: string
  model?: ModelRef
  /** Appended to fx's system prompt, kept with the session (space instructions, the ctrl instruction). */
  instructions?: string
}

const STEER_MAX = 64 * 1024

/** fx's error when another process holds the session (its lock): a terminal, or another ctrl. */
const isBusy = (err: unknown) => err instanceof AcpError && /busy/i.test(err.message)

export class FxChat implements HarnessChat {
  private open = new Map<string, Open>()
  private seq = 0
  private version: string
  /** The process started ahead of time for the next new session (warm) */
  private spare?: { session: Open; bin: string | undefined; ready: Promise<void> }
  private keepWarm = false

  onChange?: (sessionID: string, modelChanged: boolean) => void

  constructor(
    private deps: Deps,
    version = "0",
  ) {
    this.version = version
  }

  handles(sessionID: string) {
    return this.deps.isChat(sessionID)
  }

  // ---------- processes ----------

  /** The chat sessions with a process now. */
  sessions() {
    return [...this.open.keys()]
  }

  status(sessionID: string) {
    return this.open.get(sessionID)?.status
  }

  pids() {
    return [...this.open.values()].map((o) => o.proc.pid).filter((p): p is number => typeof p === "number")
  }

  /**
   * Starts the session's process when none runs (and loads the session into it), else returns the one that
   * does. `background`: without putting it on screen (restoring at launch). Fails when fx holds the session
   * elsewhere ("Session is busy"), or when fx isn't installed.
   */
  async ensure(sessionID: string, background = false): Promise<Open> {
    const existing = this.open.get(sessionID)
    if (existing) {
      await existing.ready
      return existing
    }
    const cwd = this.deps.directory(sessionID)
    if (cwd === undefined) throw new Error("This session doesn't exist anymore")
    const session = this.start(sessionID, cwd, [], background)
    session.ready = (async () => {
      await this.initialize(session)
      try {
        const result = await session.client.request<{ configOptions?: ConfigOption[] }>("session/load", {
          sessionId: rawID(sessionID),
          cwd: session.cwd,
          mcpServers: [],
        })
        session.config = result?.configOptions ?? []
      } catch (err) {
        throw isBusy(err) ? new Error("This session is open in fx elsewhere") : err
      }
      // A replay doesn't end turns: whatever it drew is history.
      session.transcript.endTurn()
    })()
    await session.ready.catch((err) => {
      this.kill(session)
      throw err
    })
    return session
  }

  /**
   * Keeps one `fx acp` process started and initialized ahead of time, for the next new chat session: fx takes
   * about a second (more when cold) to answer `initialize`, and `session/new` is instant after that. It holds
   * no session, so it serves any folder and model (create sets both per session). Called again after each use.
   */
  warm() {
    this.keepWarm = true
    if (this.spare || !this.deps.bin()) return
    let session: Open
    try {
      session = this.start(`spare_${++this.seq}`, homedir(), [], false, false)
    } catch (err) {
      console.error("[ctrl] fx acp spare failed to start", err)
      return
    }
    this.open.delete(session.sessionID)
    const spare = { session, bin: this.deps.bin(), ready: this.initialize(session) }
    this.spare = spare
    spare.ready.catch((err) => {
      console.error("[ctrl] fx acp spare failed to initialize", err)
      if (this.spare === spare) this.spare = undefined
      session.proc.kill()
    })
  }

  /** No spare process anymore (chat mode turned off). */
  cool() {
    this.keepWarm = false
    this.spare?.session.proc.kill()
    this.spare = undefined
  }

  /** The spare process, ready, when there's one (and fx hasn't moved since it started). */
  private async takeSpare(): Promise<Open | undefined> {
    const spare = this.spare
    if (!spare) return undefined
    this.spare = undefined
    if (spare.bin !== this.deps.bin() || spare.session.gone) {
      spare.session.proc.kill()
      return undefined
    }
    try {
      await spare.ready
    } catch {
      return undefined
    }
    return spare.session.gone ? undefined : spare.session
  }

  /** A new chat session in `cwd`: its process (the spare one when ready), `session/new`, and its ctrl id. */
  async create(opts: NewChatOptions): Promise<string> {
    try {
      return await this.createIn(await this.takeSpare(), opts)
    } finally {
      if (this.keepWarm) this.warm()
    }
  }

  private async createIn(spare: Open | undefined, opts: NewChatOptions): Promise<string> {
    if (spare) {
      try {
        return await this.newSession(spare, opts, true)
      } catch (err) {
        console.error("[ctrl] fx acp spare couldn't take the session, starting a new process", err)
      }
    }
    const args: string[] = []
    if (opts.model) {
      args.push("--model", opts.model.id)
      if (opts.model.variant) args.push("--effort", opts.model.variant)
    }
    const temp = `new_${++this.seq}`
    const session = this.start(temp, opts.cwd, args, false, false)
    await this.initialize(session).catch((err) => {
      this.kill(session)
      throw err
    })
    return this.newSession(session, opts, false)
  }

  /**
   * `session/new` in an initialized process, which then becomes the session's. `setModel`: the process was
   * started without the model flags (the spare one), so the model goes through set_config_option.
   */
  private async newSession(session: Open, opts: NewChatOptions, setModel: boolean): Promise<string> {
    const temp = session.sessionID
    try {
      const text = opts.instructions?.trim()
      const result = await session.client.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", {
        cwd: opts.cwd,
        mcpServers: [],
        ...(text ? { systemPrompt: [{ type: "text", text }] } : {}),
      })
      if (!result?.sessionId) throw new Error("fx returned no session id")
      session.config = result.configOptions ?? []
      if (setModel && opts.model) {
        const set = async (configId: string, value: string) => {
          const r = await session.client.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
            sessionId: result.sessionId,
            configId,
            value,
          })
          if (r?.configOptions) session.config = r.configOptions
        }
        await set("model", opts.model.id)
        if (opts.model.variant) await set("effort", opts.model.variant)
      }
      const id = fxID(result.sessionId)
      session.sessionID = id
      // The process now runs in the session's folder, as far as ctrl's pane is concerned.
      session.cwd = existsSync(opts.cwd) ? opts.cwd : session.cwd
      if (this.open.get(temp) === session) this.open.delete(temp)
      this.open.set(id, session)
      this.register(session, false)
      return id
    } catch (err) {
      this.kill(session)
      throw err
    }
  }

  /** Stops the session's process (its turn with it); the session stays on disk. */
  close(sessionID: string) {
    const session = this.open.get(sessionID)
    if (session) this.kill(session)
  }

  dispose() {
    this.cool()
    for (const s of this.open.values()) s.proc.kill()
    this.open.clear()
  }

  private start(sessionID: string, cwd: string, args: string[], background: boolean, register = true): Open {
    const bin = this.deps.bin()
    if (!bin) throw new Error("fx isn't installed")
    const dir = existsSync(cwd) ? cwd : homedir()
    const spawn = this.deps.spawn ?? ((b, a, o) => spawnProcess(b, a, { ...o, stdio: ["pipe", "pipe", "pipe"] }))
    const proc = spawn(bin, ["acp", ...args], { cwd: dir, env: this.deps.env() })
    proc.stderr?.on("data", (d: Buffer) => console.error(`[fx acp ${sessionID}] ${String(d).trimEnd()}`))
    const client = new AcpClient(proc as unknown as AcpTransport)
    const session: Open = {
      sessionID,
      proc,
      client,
      transcript: new Transcript(this.deps.now),
      ready: Promise.resolve(),
      turn: null,
      pending: [],
      steers: [],
      status: undefined,
      config: [],
      usage: null,
      cwd: dir,
      registered: false,
      gone: false,
    }
    this.open.set(sessionID, session)
    client.onNotification = (method, params) => this.notification(session, method, params)
    client.onRequest = (method, params) => this.request(session, method, params)
    client.onClose = (code) => {
      if (session.gone) return
      session.gone = true
      if (this.spare?.session === session) this.spare = undefined
      if (this.open.get(session.sessionID) === session) this.open.delete(session.sessionID)
      for (const p of session.pending) p.resolve({ outcome: { outcome: "cancelled" } })
      session.pending = []
      this.setStatus(session, undefined)
      if (session.registered) this.deps.onExit(session.sessionID, code)
    }
    if (register) this.register(session, background)
    return session
  }

  private register(session: Open, background: boolean) {
    session.registered = true
    this.deps.onOpen(session.sessionID, { pid: session.proc.pid ?? 0, kill: () => this.kill(session) }, session.cwd, background)
  }

  private async initialize(session: Open) {
    await session.client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "ctrl", version: this.version },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // Context notices come as their own updates, not as reply text.
        session: { notices: true },
      },
    })
  }

  /** Stops the process; its close ends the session (client.onClose). */
  private kill(session: Open) {
    if (this.open.get(session.sessionID) === session) this.open.delete(session.sessionID)
    session.proc.kill()
  }

  private setStatus(session: Open, status: LiveStatus | undefined) {
    if (JSON.stringify(status) === JSON.stringify(session.status)) return
    session.status = status
    this.deps.onStatus(session.sessionID, status)
  }

  // ---------- from fx ----------

  private notification(session: Open, method: string, params: unknown) {
    if (method !== "session/update") {
      if (method === "$/cancel_request") this.cancelled(session, (params as { requestId?: unknown })?.requestId)
      return
    }
    const update = (params as { update?: SessionUpdate })?.update
    if (!update) return
    if (update.sessionUpdate === "usage_update") {
      const u = update as unknown as { used?: number; size?: number }
      if (typeof u.used === "number" && typeof u.size === "number") session.usage = { used: u.used, size: u.size }
      return
    }
    if (update.sessionUpdate === "config_option_update") {
      const u = update as unknown as { configOptions?: ConfigOption[] }
      if (u.configOptions) session.config = u.configOptions
      this.onChange?.(session.sessionID, true)
      return
    }
    // A steer the turn took shows as a user message: it leaves the queue.
    if (update.sessionUpdate === "user_message_chunk" && (update._meta as { fx?: { steering?: unknown } })?.fx?.steering) {
      session.steers.shift()
    }
    const changed = session.transcript.apply(update)
    if (changed) this.onChange?.(session.sessionID, false)
  }

  private async request(session: Open, method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") throw new AcpError(-32601, `Method not found: ${method}`)
    const p = params as {
      toolCall?: { toolCallId?: string; title?: string; name?: string; rawInput?: unknown }
      options?: { optionId: string; kind: string; name?: string }[]
    }
    const title = p.toolCall?.title || p.toolCall?.name || "an action"
    const text = `Waiting for permission: ${title}`
    const detail = text.length > 90 ? `${text.slice(0, 89)}…` : text
    return new Promise((resolve) => {
      const permission: Permission = {
        id: `perm_${++this.seq}`,
        detail,
        options: p.options ?? [],
        resolve: (result) => {
          session.pending = session.pending.filter((x) => x !== permission)
          this.setStatus(session, session.pending.length ? session.status : { state: "working" })
          resolve(result)
        },
      }
      session.pending.push(permission)
      this.setStatus(session, { state: "blocked", msg: detail })
    })
  }

  private cancelled(session: Open, requestId: unknown) {
    // fx withdrew a request (the turn was cancelled): the permission goes away unanswered.
    void requestId
    for (const p of session.pending.splice(0)) p.resolve({ outcome: { outcome: "cancelled" } })
    if (session.turn) this.setStatus(session, { state: "working" })
  }

  // ---------- HarnessChat ----------

  async page(sessionID: string, cursor?: string, detail = false) {
    const session = await this.ensure(sessionID)
    return session.transcript.page(cursor, detail)
  }

  pending(sessionID: string): ChatPending[] {
    return (this.open.get(sessionID)?.pending ?? []).map((p) => ({ id: p.id, kind: "permission", detail: p.detail }))
  }

  async inbox(sessionID: string): Promise<ChatQueued[]> {
    return (this.open.get(sessionID)?.steers ?? []).map((s) => ({ id: s.id, text: s.text, images: 0 }))
  }

  async image(sessionID: string, messageID: string, index: number) {
    const found = this.open.get(sessionID)?.transcript.image(messageID, index)
    return found ? { mime: found.mime, body: Buffer.from(found.data, "base64") } : null
  }

  /**
   * A prompt, or a steer when a turn runs (fx takes it at its next step). Images can't steer: a message with
   * them waits for the turn to end, then goes as a prompt.
   */
  async send(sessionID: string, text: string, attachments: ChatAttachment[]) {
    const session = await this.ensure(sessionID)
    const blocks = contentBlocks(text, attachments)
    if (session.turn && !attachments.length && Buffer.byteLength(text) <= STEER_MAX) {
      const steer = { id: `steer_${++this.seq}`, text }
      session.steers.push(steer)
      this.onChange?.(sessionID, false)
      const turn = session.turn
      void session.client
        .request<{ _meta?: { fx?: { steering?: string } } }>("session/prompt", {
          sessionId: rawID(session.sessionID),
          prompt: blocks,
          _meta: { fx: { steer: true } },
        })
        .catch(async (err) => {
          // The turn ended before taking it: it goes as the next prompt.
          session.steers = session.steers.filter((s) => s !== steer)
          if (err instanceof AcpError && err.code === -32600) {
            await turn.catch(() => {})
            await this.prompt(session, blocks, text, attachments)
          } else console.error("[ctrl] fx steer failed", err)
        })
      return steer.id
    }
    if (session.turn) await session.turn.catch(() => {})
    return this.prompt(session, blocks, text, attachments)
  }

  private async prompt(session: Open, blocks: unknown[], text: string, attachments: ChatAttachment[]) {
    // fx doesn't echo a prompt to its sender: the chat shows it from here.
    const messageId = `local_${++this.seq}`
    session.transcript.apply({ sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text } })
    for (const a of attachments) {
      const image = dataURL(a.uri)
      if (image?.mime.startsWith("image/"))
        session.transcript.apply({ sessionUpdate: "user_message_chunk", messageId, content: { type: "image", data: image.data, mimeType: image.mime } })
    }
    const id = session.transcript.items.at(-1)!.id
    this.setStatus(session, { state: "working" })
    this.onChange?.(session.sessionID, false)
    const turn = session.client.request<{ stopReason?: string }>("session/prompt", { sessionId: rawID(session.sessionID), prompt: blocks })
    session.turn = turn
    turn
      .then(() => session.transcript.endTurn())
      .catch((err) => session.transcript.endTurn(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (session.turn === turn) session.turn = null
        for (const p of session.pending.splice(0)) p.resolve({ outcome: { outcome: "cancelled" } })
        session.steers = []
        if (this.open.get(session.sessionID) === session) {
          const last = session.transcript.items.at(-1)
          const failed = last?.kind === "assistant" && !!last.error
          this.setStatus(session, { state: failed ? "error" : "done" })
        }
        this.onChange?.(session.sessionID, false)
      })
    return id
  }

  async stop(sessionID: string) {
    const session = this.open.get(sessionID)
    if (!session?.turn) return
    session.client.notify("session/cancel", { sessionId: rawID(sessionID) })
  }

  async reply(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
    const session = this.open.get(sessionID)
    const permission = session?.pending.find((p) => p.id === requestID)
    if (!permission) return
    const kind = decision === "once" ? "allow_once" : decision === "always" ? "allow_always" : "reject_once"
    const option = permission.options.find((o) => o.kind === kind) ?? permission.options.find((o) => o.kind.startsWith(decision === "reject" ? "reject" : "allow"))
    permission.resolve(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } })
  }

  async answer(_sessionID: string, _formID: string, _answer: FormAnswer | null) {
    // fx 0.0.17 asks its questions in plain text (vercel-labs/fx#1879 brings forms).
  }

  model = {
    get: async (sessionID: string): Promise<ModelRef | null> => {
      const session = await this.ensure(sessionID).catch(() => undefined)
      if (!session) return null
      const model = session.config.find((c) => c.id === "model")?.currentValue
      if (typeof model !== "string" || !model) return null
      const effort = session.config.find((c) => c.id === "effort")?.currentValue
      return { providerID: "fx", id: model, ...(typeof effort === "string" && effort ? { variant: effort } : {}) }
    },
    set: async (sessionID: string, model: ModelRef) => {
      const session = await this.ensure(sessionID)
      const set = (configId: string, value: string) =>
        session.client
          .request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId: rawID(sessionID), configId, value })
          .then((r) => {
            if (r?.configOptions) session.config = r.configOptions
          })
      await set("model", String(model.id))
      if (model.variant) await set("effort", String(model.variant))
      this.onChange?.(sessionID, true)
    },
  }

  async stats(sessionID: string): Promise<ChatStats> {
    const usage = this.open.get(sessionID)?.usage
    return { cost: 0, context: usage ? { used: usage.used, limit: usage.size || null } : null }
  }
}

function dataURL(uri: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri)
  return m ? { mime: m[1], data: m[2] } : null
}

/** ACP content blocks for a message: its text, then each image inline (PDFs as embedded resources). */
function contentBlocks(text: string, attachments: ChatAttachment[]) {
  const blocks: unknown[] = []
  if (text) blocks.push({ type: "text", text })
  attachments.forEach((a, i) => {
    const parsed = dataURL(a.uri)
    if (!parsed) return
    if (parsed.mime.startsWith("image/")) blocks.push({ type: "image", data: parsed.data, mimeType: parsed.mime })
    else blocks.push({ type: "resource", resource: { uri: `file:///document-${i + 1}.pdf`, mimeType: parsed.mime, blob: parsed.data } })
  })
  return blocks
}
