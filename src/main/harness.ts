import type { ChatAttachment, ChatStats, Harness, ModelRef, RunningWork, SessionActivity, SessionItem } from "../shared/types"
import type { ChatPending, FormAnswer } from "./remote"
import type { ChatPage, ChatQueued } from "./remote-chat"

/**
 * What ctrl reads from a harness (opencode: src/main/opencode.ts, fx: src/main/fx.ts). main merges every
 * source into the one session list the sidebar, attention, the CLI and the phone see.
 *
 * Only the required part is needed to show a harness's sessions. Each optional capability powers one piece
 * of UI, and a harness that doesn't implement it just doesn't get that piece: nothing breaks, nothing shows
 * empty. Add support one capability at a time, and update the support table in docs/HARNESSES.md.
 *
 * Adding a harness: docs/HARNESSES.md → Adding a harness.
 */
export interface HarnessSource {
  readonly harness: Harness

  // ---- required ----

  /** Root sessions with their status (running, needs you, unread…), newest first. */
  readonly sessions: SessionItem[]
  /** Set while the harness's sessions can't be read; shown in the sidebar banner. */
  readonly problem: string | null

  // ---- optional capabilities ----

  /**
   * Shells and subagents still running for a session, counted over its subagents too. Shown in the sidebar
   * when the session's own turn is over: a shell or subagent icon instead of its age. Return undefined when
   * nothing runs.
   */
  activity?(sessionID: string): SessionActivity | undefined

  /**
   * What `activity` counts, one by one, and stopping one of them. The chat view lists them when you click
   * the count under its composer, each with a stop button.
   */
  work?: {
    /** Oldest first. */
    list(sessionID: string): Promise<RunningWork[]>
    /** Kills that shell, or stops that subagent (`id`: a RunningWork's). One that's gone is not an error. */
    stop(sessionID: string, id: string): Promise<void>
  }

  /**
   * Moves what holds a session's turn to the background (a shell that hasn't exited, a subagent still
   * working), so the turn goes on. Called when a message you sent to a running session from a chat (desktop
   * or phone) still waits after 3 seconds: the agent reads it then, instead of once that's done. Must leave a
   * turn alone when nothing holds it (the agent is thinking or writing).
   */
  background?(sessionID: string): Promise<void>

  /**
   * The global folders it loads skills from (each skill: a folder with a SKILL.md), for Settings → Skills,
   * which shows what every harness sees (src/main/skills.ts). Without it, the harness has no column there.
   */
  skillFolders?(): string[]

  /**
   * Its sessions as a chat: the desktop's chat view (Settings → Appearance) and remote control's phone view
   * (src/main/chat.ts routes both here). A harness without it keeps its sessions in their terminal.
   */
  chat?: HarnessChat
}

/**
 * A harness's sessions as a chat, in ctrl's own terms (src/main/remote-chat.ts): each harness translates what
 * it has into these types, and the chat views never see the harness. opencode: src/main/opencode-chat.ts.
 *
 * Like HarnessSource, the optional parts each power one piece of the chat view, and are hidden or empty for a
 * harness that doesn't have them.
 */
export interface HarnessChat {
  /** Whether this session opens as a chat. Missing: every session of the harness does. */
  handles?(sessionID: string): boolean
  /** The newest page of messages (no cursor), or the page before `cursor`, oldest first. `detail` adds what
   *  only the desktop shows (thinking text, full commands). */
  page(sessionID: string, cursor?: string, detail?: boolean): Promise<ChatPage>
  /** Permissions and questions waiting on you in this session. */
  pending(sessionID: string): ChatPending[]
  /** Sends a message (a steer when a turn runs); returns its id when the harness gives one. */
  send(sessionID: string, text: string, attachments: ChatAttachment[]): Promise<string | undefined>
  /** Stops the running turn. */
  stop(sessionID: string): Promise<void>
  /** Answers a permission request (`requestID`: a ChatPending's id). */
  reply(sessionID: string, requestID: string, decision: "once" | "always" | "reject"): Promise<void>

  // ---- optional ----

  /** Messages you sent that the agent hasn't read yet, oldest first (the chat's queue). */
  inbox?(sessionID: string): Promise<ChatQueued[]>
  /** Answers a question form (answer null: dismiss it). */
  answer?(sessionID: string, formID: string, answer: FormAnswer | null): Promise<void>
  /** The index-th image attached to a message you sent. */
  image?(sessionID: string, messageID: string, index: number): Promise<{ mime: string; body: Buffer } | null>
  /** The session's model (the chat's model picker). */
  model?: {
    get(sessionID: string): Promise<ModelRef | null>
    set(sessionID: string, model: ModelRef): Promise<void>
  }
  /** Spend so far and how full the context is (under the composer). */
  stats?(sessionID: string): Promise<ChatStats>

  /**
   * Set by main: something happened in a session (text streamed, a tool ran, a message was sent), so chats
   * showing it re-read it. `modelChanged`: its model was picked elsewhere (the TUI), for the model picker.
   */
  onChange?: (sessionID: string, modelChanged: boolean) => void
}

/** The harness's sessions, with what its optional capabilities add. */
export function sessionsOf(source: HarnessSource): SessionItem[] {
  const activity = source.activity?.bind(source)
  if (!activity) return source.sessions
  return source.sessions.map((s) => {
    const a = activity(s.id)
    return a ? { ...s, activity: a } : s
  })
}
