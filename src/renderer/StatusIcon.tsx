import { STATUS_RANK, type SessionActivity, type SessionItem, type SessionStatus } from "../shared/types"
import { activityText } from "./format"
import { Icon } from "./icons"

export function StatusIcon({ status }: { status: SessionStatus }) {
  if (status === "running") return <span className="spinner" />
  if (status === "idle") return null
  return <span className={`status-dot ${status}`} />
}

/**
 * How loud a session's sidebar icon is: its status first, then background subagents, then shells.
 * needs-input > running > failed > unread > subagents > shells > nothing.
 */
export function signalRank(s: Pick<SessionItem, "status" | "activity">): number {
  if (s.status !== "idle") return 2 + STATUS_RANK[s.status]
  if (s.activity?.subagents) return 2
  if (s.activity?.shells) return 1
  return 0
}

/** Loudest session among sessions, for rolling up into a folded space or parent. */
export function topStatus(sessions: SessionItem[]): SessionItem | undefined {
  let top: SessionItem | undefined
  let rank = 0
  for (const s of sessions) {
    const r = signalRank(s)
    if (r > rank) [top, rank] = [s, r]
  }
  return top
}

/** The status dot or spinner, or the activity icon when the turn is over but work still runs. */
export function SignalIcon({ status, activity }: Pick<SessionItem, "status" | "activity">) {
  if (status === "idle" && activity && (activity.subagents || activity.shells)) return <ActivityIcon activity={activity} />
  return <StatusIcon status={status} />
}

/**
 * A session whose turn is over but still has shells or subagents running: a pulsing icon instead of its
 * age, like the spinner for a running turn. Subagents win when there are both.
 */
export function ActivityIcon({ activity }: { activity: SessionActivity }) {
  return (
    <span className="activity" aria-label={`${activityText(activity)} running`}>
      <Icon name={activity.subagents > 0 ? "subagent" : "terminal"} />
    </span>
  )
}
