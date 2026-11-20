import { randomBytes } from "node:crypto"
import { FX_PREFIX, type Harness, type ModelRef, type SessionItem } from "../shared/types"

/**
 * New sessions the harness hasn't written anywhere yet. fx only creates a session at its first prompt (a
 * terminal one has no id before that; a chat one has an id from `session/new` but nothing on disk), while
 * opencode creates one right away. ctrl keeps a record of each new session until its harness lists it, so a
 * new session shows in the sidebar ("New session") whatever the harness, keeps its space, parent and draft,
 * and survives switching away and ctrl restarting, with or without a process behind it.
 *
 * Its id: the harness's when it has one (fx chat), else a placeholder in the harness's namespace (`fx:new-…`)
 * that main re-keys to the real id once the harness reports it (Store.rekey).
 */
export type Unstarted = {
  harness: Harness
  directory: string
  created: number
  /** fx: runs as a chat (fx acp), else in a terminal */
  chat?: boolean
  /** Model picked when it was created, used again when it has to be started anew (its space's instructions are read then) */
  model?: ModelRef
}

const PLACEHOLDER = "new-"

/** A placeholder id for a session whose harness gives none yet. */
export const placeholderID = (harness: Harness) =>
  `${harness === "fx" ? FX_PREFIX : "ses_"}${PLACEHOLDER}${randomBytes(6).toString("base64url")}`

/** Whether the id is one of ctrl's placeholders (the harness has never heard of it). */
export const isPlaceholder = (id: string) => id.startsWith(`${FX_PREFIX}${PLACEHOLDER}`) || id.startsWith(`ses_${PLACEHOLDER}`)

/**
 * The harnesses' sessions plus the unstarted ones none of them lists yet (unsorted). `started`: the unstarted
 * sessions the harness now has for good (their record can go). A session the harness lists but hasn't started
 * (fx shows an empty session while its process holds it) keeps its record, so it's still listed once that
 * process is gone.
 */
export function withUnstarted(
  listed: SessionItem[],
  unstarted: Record<string, Unstarted>,
  opts: { title(id: string): string | undefined; started(id: string): boolean },
): { sessions: SessionItem[]; started: string[] } {
  const ids = new Set(listed.map((s) => s.id))
  const extra: SessionItem[] = []
  const started: string[] = []
  for (const [id, u] of Object.entries(unstarted)) {
    if (ids.has(id)) {
      if (opts.started(id)) started.push(id)
      continue
    }
    extra.push({
      id,
      harness: u.harness,
      title: opts.title(id) ?? "New session",
      directory: u.directory,
      updated: u.created,
      status: "idle",
      ...(u.chat ? { view: "chat" as const } : {}),
    })
  }
  return { sessions: extra.length ? [...listed, ...extra] : listed, started }
}
