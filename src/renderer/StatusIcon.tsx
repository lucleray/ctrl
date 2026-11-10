import { STATUS_RANK, type SessionActivity, type SessionItem, type SessionStatus } from "../shared/types"
import { activityText } from "./format"
import { Icon } from "./icons"

export function StatusIcon({ status }: { status: SessionStatus }) {
  if (status === "running") return <span className="spinner" />
  if (status === "idle") return null
  return <span className={`status-dot ${status}`} />
}

/** Most urgent status among sessions, for rolling up into a folded space. */
export function topStatus(sessions: SessionItem[]): SessionItem | undefined {
  let top: SessionItem | undefined
  for (const s of sessions) {
    if (s.status === "idle") continue
    if (!top || STATUS_RANK[s.status] > STATUS_RANK[top.status]) top = s
  }
  return top
}

/** A session whose turn is over but still has shells or subagents running: shown instead of its age. */
export function ActivityIcon({ activity }: { activity: SessionActivity }) {
  return (
    <span className="activity" aria-label={`${activityText(activity)} running`}>
      {activity.subagents > 0 && <Icon name="subagent" />}
      {activity.shells > 0 && <Icon name="terminal" />}
    </span>
  )
}
