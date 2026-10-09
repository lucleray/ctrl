import { useEffect, useRef, useState } from "react"
import type { UiState } from "../shared/types"

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 280

type PanelOptions = {
  /** UiState field the width persists to */
  key: "sidebarWidth" | "resourcesWidth"
  min: number
  max: number
  initial: number
  /** Which edge of the panel the handle sits on */
  edge: "left" | "right"
}

/**
 * Drag handle on a panel's edge. Updates the width live while dragging and
 * persists it on release; double-click resets to the default.
 */
export function usePanelWidth(saved: number, { key, min, max, initial, edge }: PanelOptions) {
  const [width, setWidth] = useState(saved)
  const dragging = useRef(false)
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)))
  const persist = (w: number) => void window.ctrl.setUi({ [key]: w } as Partial<UiState>)

  // Follow the persisted value (initial load, other changes) unless mid-drag.
  useEffect(() => {
    if (!dragging.current) setWidth(saved)
  }, [saved])

  const handle = (
    <div
      className={`resize-handle ${edge}`}
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => {
        setWidth(initial)
        persist(initial)
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
          const dx = ev.clientX - startX
          latest = clamp(edge === "right" ? startW + dx : startW - dx)
          setWidth(latest)
        }
        const onUp = () => {
          dragging.current = false
          document.body.classList.remove("resizing")
          window.removeEventListener("mousemove", onMove)
          window.removeEventListener("mouseup", onUp)
          if (latest !== startW) persist(latest)
        }
        window.addEventListener("mousemove", onMove)
        window.addEventListener("mouseup", onUp)
      }}
    />
  )

  return { width: clamp(width), handle }
}

export function useSidebarWidth(saved: number) {
  return usePanelWidth(saved, {
    key: "sidebarWidth",
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    initial: SIDEBAR_DEFAULT,
    edge: "right",
  })
}
