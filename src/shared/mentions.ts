import type { PinnedSession } from "./types"

/** `@session[Title](ses_…)`: resolved by the read-session skill on the agent side. */
export function sessionMention(s: PinnedSession) {
  const title = s.title.replace(/[[\]()\n\r]/g, " ").replace(/\s+/g, " ").trim()
  return `@session[${title}](${s.id})`
}

/** Instructions a space's pinned sessions add to its new sessions; empty when there are none. */
export function pinnedInstructions(pins: PinnedSession[] | undefined) {
  if (!pins?.length) return ""
  return [
    "This space builds on the earlier sessions below. When you need background on this work (goals, decisions, past changes), read them with the read-session skill instead of asking the user to repeat it:",
    ...pins.map((p) => `- ${sessionMention(p)}`),
  ].join("\n")
}
