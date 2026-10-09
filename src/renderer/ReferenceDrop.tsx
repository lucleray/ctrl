import { useEffect, useRef, useState } from "react"
import type { SessionItem } from "../shared/types"
import { Icon } from "./icons"

export const SESSION_DRAG = "application/x-ctrl-session"

/** `@session[Title](ses_…)`: resolved by the read-session skill on the agent side. */
export function sessionMention(s: Pick<SessionItem, "id" | "title">) {
  const title = s.title.replace(/[[\]()\n\r]/g, " ").replace(/\s+/g, " ").trim()
  return `@session[${title}](${s.id})`
}

/** Backslash-escape like Terminal.app does when you drop a file on it. */
const escapePath = (path: string) => path.replace(/([\s\\'"()[\]{}$`!&*?;<>|#~])/g, "\\$1")

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files")

/**
 * Drop zone over the terminal, shown while a session is dragged from the sidebar or files
 * are dragged in from Finder. Dropping pastes a session mention or the file paths into the
 * TUI prompt.
 */
export function ReferenceDrop(props: {
  sessions: SessionItem[]
  currentSessionID: string | null
  onReference(text: string, kind: "session" | "files"): void
}) {
  const [dragging, setDragging] = useState<"session" | "files" | null>(null)
  const [over, setOver] = useState(false)
  // Drags from outside the window never fire dragstart/dragend, so count enter/leave instead.
  const depth = useRef(0)

  useEffect(() => {
    const reset = () => {
      depth.current = 0
      setDragging(null)
      setOver(false)
    }
    const start = (e: DragEvent) => setDragging(e.dataTransfer?.types.includes(SESSION_DRAG) ? "session" : null)
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current++
      setDragging("files")
    }
    const leave = (e: DragEvent) => {
      if (hasFiles(e) && --depth.current <= 0) reset()
    }
    // Outside the drop zone (which stops propagation): refuse the drop, otherwise Chromium
    // navigates the window to file://… and will-navigate opens the file externally.
    const dragover = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = "none"
    }
    const drop = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
      reset()
    }
    document.addEventListener("dragstart", start)
    document.addEventListener("dragenter", enter)
    document.addEventListener("dragleave", leave)
    document.addEventListener("dragover", dragover)
    document.addEventListener("dragend", reset)
    document.addEventListener("drop", drop)
    return () => {
      document.removeEventListener("dragstart", start)
      document.removeEventListener("dragenter", enter)
      document.removeEventListener("dragleave", leave)
      document.removeEventListener("dragover", dragover)
      document.removeEventListener("dragend", reset)
      document.removeEventListener("drop", drop)
    }
  }, [])

  if (!dragging) return null
  return (
    <div
      className={`reference-drop ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = "copy"
        if (!over) setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (dragging === "files") {
          const paths = [...e.dataTransfer.files].map((f) => window.ctrl.pathForFile(f)).filter(Boolean)
          if (paths.length) props.onReference(paths.map(escapePath).join(" "), "files")
          return
        }
        const id = e.dataTransfer.getData(SESSION_DRAG)
        const session = props.sessions.find((s) => s.id === id)
        if (session && id !== props.currentSessionID) props.onReference(sessionMention(session), "session")
      }}
    >
      <div className="reference-card">
        <Icon name={dragging === "files" ? "doc" : "link"} />
        {dragging === "files" ? (
          <div>
            <div className="reference-title">Add to prompt</div>
            <div className="reference-desc">Pastes the file paths into the prompt</div>
          </div>
        ) : (
          <div>
            <div className="reference-title">Reference in this session</div>
            <div className="reference-desc">Adds an @session mention so the agent can read its context</div>
          </div>
        )}
      </div>
    </div>
  )
}
