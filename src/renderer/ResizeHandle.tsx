import { useEffect, useRef, useState } from "react"

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 280

const clamp = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))

/**
 * Drag handle on the sidebar's right edge. Updates the width live while dragging
 * and persists it on release; double-click resets to the default.
 */
export function useSidebarWidth(saved: number) {
  const [width, setWidth] = useState(saved)
  const dragging = useRef(false)

  // Follow the persisted value (initial load, other changes) unless mid-drag.
  useEffect(() => {
    if (!dragging.current) setWidth(saved)
  }, [saved])

  const handle = (
    <div
      className="resize-handle"
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => {
        setWidth(SIDEBAR_DEFAULT)
        void window.ctrl.setUi({ sidebarWidth: SIDEBAR_DEFAULT })
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        dragging.current = true
        const startX = e.clientX
        const startW = width
        let latest = startW
        document.body.classList.add("resizing")
        const onMove = (ev: MouseEvent) => {
          latest = clamp(startW + ev.clientX - startX)
          setWidth(latest)
        }
        const onUp = () => {
          dragging.current = false
          document.body.classList.remove("resizing")
          window.removeEventListener("mousemove", onMove)
          window.removeEventListener("mouseup", onUp)
          if (latest !== startW) void window.ctrl.setUi({ sidebarWidth: latest })
        }
        window.addEventListener("mousemove", onMove)
        window.addEventListener("mouseup", onUp)
      }}
    />
  )

  return { width: clamp(width), handle }
}
