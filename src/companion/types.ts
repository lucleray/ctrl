import type { Harness, SessionStatus } from "../shared/types"

/** What the native helper (native/context.swift) prints, one JSON object per line. */
export type ProbeMessage =
  | { type: "permission"; trusted: boolean }
  | { type: "context"; app: string; bundleId: string; title: string; label?: string; urls: string[] }
  | { type: "hold"; ctrl: boolean }

export type CompanionSession = {
  id: string
  title: string
  harness: Harness
  status: SessionStatus
  archived: boolean
  /** Last time it mentioned the matched resource */
  last: number
  /** The resource it mentioned, e.g. "acme/web#123" or "Thread" */
  via: string
  /** Mentioned the exact thing on screen (vs. its channel) */
  exact: boolean
  /** ⌃N opens it from any app (1–9, top to bottom, archived ones left out) */
  jump?: number
}

export type CompanionView = {
  /** Accessibility granted: needed for Slack, Notion and Linear (not browsers) */
  trusted: boolean
  /** What's on screen; null until the first app is seen */
  context: {
    app: string
    /** Tab, channel or page title */
    label?: string
    /** The resource it recognized, e.g. "acme/web#123"; none when nothing on screen is a link ctrl knows */
    resource?: string
  } | null
  /** The new-session shortcut, formatted ("⌃⌥⌘Space"); "" when unbound */
  shortcut: string
  /** Matching sessions grouped like the sidebar: by space, then Recents (no space), then Archived */
  groups: CompanionGroup[]
}

export type CompanionGroup = {
  /** Space id, "recents" or "archived" */
  id: string
  kind: "space" | "recents" | "archived"
  name: string
  sessions: CompanionSession[]
}

export type CompanionApi = {
  onView(cb: (view: CompanionView) => void): () => void
  /** ⌃ held on its own, in any app: show the ⌃1–9 hints */
  onHold(cb: (held: boolean) => void): () => void
  open(sessionID: string): void
  /** New session with what's on screen typed in */
  newSession(): void
  resize(height: number): void
  /** The ⋯ menu: new session, open ctrl, settings, hide */
  menu(): void
  requestAccess(): void
}
