import { useEffect, useRef } from "react"

type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "defaultPrevented">

/** Something that takes keys itself: a field, the terminal, an open picker or menu. */
function takesKeys(el: Element | null): boolean {
  if (!el || el === document.body || el === document.documentElement) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if ((el as HTMLElement).isContentEditable) return true
  return !!el.closest(".xterm, [role='menu'], [role='listbox'], [role='dialog']")
}

/** A key that should land in the composer: a printable character, or ⌘V, typed with nothing else taking keys. */
export function wantsComposer(e: Key, active: Element | null): boolean {
  if (e.defaultPrevented || e.isComposing || takesKeys(active)) return false
  const paste = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "v"
  const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey
  return paste || printable
}

/**
 * Keeps typing going to the chat composer while `enabled`: a key typed while focus is nowhere in particular moves
 * focus there first (the key then lands in it), and coming back to the window puts the caret back in it.
 */
export function useTypeToFocus(enabled: boolean, focus: () => void) {
  const on = useRef(enabled)
  on.current = enabled
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => on.current && wantsComposer(e, document.activeElement) && focus()
    const onWindowFocus = () => on.current && !takesKeys(document.activeElement) && focus()
    window.addEventListener("keydown", onKey)
    window.addEventListener("focus", onWindowFocus)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("focus", onWindowFocus)
    }
  }, [focus])
}
