import { useEffect, useState } from "react"
import { sessionMention } from "../shared/mentions"
import type { SessionItem } from "../shared/types"
import { Icon } from "./icons"

export const SESSION_DRAG = "application/x-ctrl-session"

export { sessionMention }

/**
 * Drop zone over the terminal, shown while a session is dragged from the sidebar.
 * Dropping pastes a mention into the TUI prompt so the agent can read that session.
 */
export function ReferenceDrop(props: {
  sessions: SessionItem[]
  currentSessionID: string | null
  onReference(mention: string): void
}) {
  const [dragging, setDragging] = useState(false)
  const [over, setOver] = useState(false)

  useEffect(() => {
    const start = (e: DragEvent) => setDragging(!!e.dataTransfer?.types.includes(SESSION_DRAG))
    const end = () => {
      setDragging(false)
      setOver(false)
    }
    document.addEventListener("dragstart", start)
    document.addEventListener("dragend", end)
    document.addEventListener("drop", end)
    return () => {
      document.removeEventListener("dragstart", start)
      document.removeEventListener("dragend", end)
      document.removeEventListener("drop", end)
    }
  }, [])

  if (!dragging) return null
  return (
    <div
      className={`reference-drop ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        if (!over) setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        const id = e.dataTransfer.getData(SESSION_DRAG)
        const session = props.sessions.find((s) => s.id === id)
        if (session && id !== props.currentSessionID) props.onReference(sessionMention(session))
      }}
    >
      <div className="reference-card">
        <Icon name="link" />
        <div>
          <div className="reference-title">Reference in this session</div>
          <div className="reference-desc">Adds an @session mention so the agent can read its context</div>
        </div>
      </div>
    </div>
  )
}
