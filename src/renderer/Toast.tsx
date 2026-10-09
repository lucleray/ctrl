import { useEffect, useRef, useState } from "react"
import type { Toast } from "../shared/types"
import { Icon } from "./icons"

/**
 * ctrl's only in-app notification (README → Notifications): one toast at a time, as a card
 * at the bottom of the sidebar; a newer one replaces it. Sticky toasts (duration null) stay
 * until dismissed.
 */
export function Toasts({
  onView,
  onAction,
  undoLabel,
}: {
  onView(sessionID: string): void
  /** After a toast's action button ran */
  onAction(): void
  undoLabel: string
}) {
  const [toast, setToast] = useState<Toast | null>(null)
  const [hovered, setHovered] = useState(false)
  const remaining = useRef(0)

  useEffect(
    () =>
      window.ctrl.onToast((t) => {
        remaining.current = t.duration ?? 0
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
    if (!toast || hovered || toast.duration === null) return
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
      className={`toast ${toast.icon}`}
      role="status"
      key={toast.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="toast-head">
        <Icon name={toast.icon} />
        <span className="toast-text" title={toast.message}>{toast.message}</span>
        <button className="icon-btn" title="Dismiss" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      {(toast.viewSessionID || toast.action || toast.undo) && (
        <div className="toast-actions">
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
          {toast.action && (
            <button
              className="toast-btn primary"
              onClick={() => {
                close()
                void window.ctrl.toastAction(toast.id)
                onAction()
              }}
            >
              {toast.action}
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
        </div>
      )}
    </div>
  )
}
