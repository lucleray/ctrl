import type { SessionActivity, SessionItem } from "../shared/types"

export function age(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (86400 * 30))}mo`
}

/** Tooltip line for a session's status, e.g. "Failed · 3m ago". */
export function statusText(s: SessionItem) {
  if (!s.statusDetail) return undefined
  return s.status === "failed" || s.status === "unread" ? `${s.statusDetail} · ${age(s.updated)} ago` : s.statusDetail
}

/** statusText, or what still runs in the background once the turn is over */
export function signalText(s: SessionItem) {
  if (s.status === "idle" && s.activity && (s.activity.subagents || s.activity.shells))
    return `Running in the background: ${activityText(s.activity)}`
  return statusText(s)
}

/** "1 shell · 2 subagents" */
export function activityText(a: SessionActivity) {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  return [a.subagents && plural(a.subagents, "subagent"), a.shells && plural(a.shells, "shell")].filter(Boolean).join(" · ")
}

export function shortPath(p: string) {
  return p.replace(/^\/Users\/[^/]+/, "~")
}
