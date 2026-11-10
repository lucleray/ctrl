import type { Harness, SessionActivity, SessionItem } from "../shared/types"

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
