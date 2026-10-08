import { useEffect, useRef, useState } from "react"
import type { Toast } from "../shared/types"
import { Icon } from "./icons"

/** One toast at a time at the top of the main area; a newer one replaces it. */
export function Toasts({ onView, undoLabel }: { onView(sessionID: string): void; undoLabel: string }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const [hovered, setHovered] = useState(false)
  const remaining = useRef(0)

  useEffect(
    () =>
      window.ctrl.onToast((t) => {
        remaining.current = t.duration
        setToast(t)
      }),
    [],
  )
  useEffect(
    () => window.ctrl.onToastDismiss((id) => setToast((t) => (!id || t?.id === id ? null : t))),
    [],
  )

  // Count down only while not hovered, so it doesn't vanish under the cursor.
  useEffect(() => {
    if (!toast || hovered) return
    const started = Date.now()
    const timer = setTimeout(() => setToast(null), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(1500, remaining.current - (Date.now() - started))
    }
  }, [toast, hovered])

  if (!toast) return null
  const close = () => {
    setToast(null)
    setHovered(false)
  }
  return (
    <div
      className="toast"
      role="status"
      key={toast.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Icon name={toast.icon} />
      <span className="toast-text">{toast.message}</span>
      {toast.viewSessionID && (
        <button
          className="toast-btn"
          onClick={() => {
            close()
            onView(toast.viewSessionID!)
          }}
        >
          View
        </button>
      )}
      {toast.undo && (
        <button
          className="toast-btn primary"
          title={undoLabel ? `Undo (${undoLabel})` : "Undo"}
          onClick={() => {
            close()
            void window.ctrl.undo(toast.id)
          }}
        >
          Undo
        </button>
      )}
      <button className="icon-btn" title="Dismiss" onClick={close}>
        <Icon name="close" />
      </button>
    </div>
  )
}
