import { useCallback, useEffect, useRef, useState } from "react"

const HOLD_MS = 300

/**
 * Sessions reachable with ⌘1–9: visible sidebar rows top to bottom, deduped
 * (a session in a space also appears in Recents; the first occurrence counts).
 */
export function jumpTargets(): string[] {
  const ids: string[] = []
  for (const row of document.querySelectorAll<HTMLElement>(".sidebar .row.session[data-session-id]")) {
    const id = row.dataset.sessionId!
    if (!ids.includes(id)) ids.push(id)
    if (ids.length === 9) break
  }
  return ids
}

/**
 * Shows number hints while ⌘ is held. Returns sessionID → number, or null when
 * hidden, plus `cancel` for when ⌘ is used for another shortcut.
 */
export function useJumpHints(onJump: (n: number) => void) {
  const [hints, setHints] = useState<Map<string, number> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const jump = useRef(onJump)
  jump.current = onJump

  const cancel = useCallback(() => {
    clearTimeout(timer.current)
    setHints(null)
  }, [])

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        // Keep it away from the terminal.
        e.preventDefault()
        e.stopPropagation()
        jump.current(Number(e.key))
        return
      }
      if (e.key === "Meta" && !e.repeat) {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          setHints(new Map(jumpTargets().map((id, i) => [id, i + 1])))
        }, HOLD_MS)
      } else if (e.key !== "Meta" && !/^[1-9]$/.test(e.key)) {
        cancel()
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Meta") cancel()
    }
    // Capture phase so the terminal can't swallow the events first.
    window.addEventListener("keydown", onDown, true)
    window.addEventListener("keyup", onUp, true)
    window.addEventListener("blur", cancel)
    return () => {
      window.removeEventListener("keydown", onDown, true)
      window.removeEventListener("keyup", onUp, true)
      window.removeEventListener("blur", cancel)
      clearTimeout(timer.current)
    }
  }, [cancel])

  return { hints, cancel }
}
