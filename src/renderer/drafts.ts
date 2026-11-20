/**
 * What's typed in each session's chat composer and not sent. The composer is per session (keyed by its id), so
 * switching sessions shows each one's own draft. Main keeps the text in state.json (AppState.drafts), so drafts
 * survive a restart and the sidebar can show them; this copy is the fresher one while ctrl runs, and keeps what
 * main doesn't: attached images and the composer's tokens (`[Pasted 12 lines]`, `@Title`).
 *
 * Compromise: attachments live only here, so after a restart a draft comes back with its `[Image 1]`
 * placeholder but without the image.
 */

export type Draft = {
  text: string
  attached: { label: string; uri: string }[]
  /** Token label → what it stands for */
  tokens: [string, string][]
}

/** Typing saves to main at most this often per session. */
export const DRAFT_SAVE_MS = 400

const local = new Map<string, Draft>()
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; text: string }>()

/** This run's draft for a session, else the text main kept (`saved`). */
export function readDraft(sessionID: string, saved: string | undefined): Draft | undefined {
  return local.get(sessionID) ?? (saved ? { text: saved, attached: [], tokens: [] } : undefined)
}

/** `expanded`: the text with its tokens swapped back for what they stand for, as main keeps it. */
export function writeDraft(sessionID: string, draft: Draft, expanded: string) {
  if (draft.text.trim()) local.set(sessionID, draft)
  else local.delete(sessionID)
  const was = pending.get(sessionID)
  if (was) clearTimeout(was.timer)
  pending.set(sessionID, { text: expanded, timer: setTimeout(() => flushDraft(sessionID), DRAFT_SAVE_MS) })
}

/** Saves a draft waiting for its turn now (the composer is going away). */
export function flushDraft(sessionID: string) {
  const was = pending.get(sessionID)
  if (!was) return
  clearTimeout(was.timer)
  pending.delete(sessionID)
  window.ctrl.setDraft(sessionID, was.text)
}

/** Drops this run's copy (archived: main dropped its own). */
export function forgetDraft(sessionID: string) {
  local.delete(sessionID)
  const was = pending.get(sessionID)
  if (was) clearTimeout(was.timer)
  pending.delete(sessionID)
}

/** Sessions with a draft in this run. */
export const localDrafts = () => [...local.keys()]
