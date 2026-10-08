import { STATUS_RANK, type SessionItem, type SessionStatus } from "../shared/types"

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
