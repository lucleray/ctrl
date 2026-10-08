export type CommandID =
  | "palette"
  | "new-chat"
  | "new-session-here"
  | "archive-session"
  | "undo"
  | "settings"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"

export type Command = { id: CommandID; label: string; desc?: string; defaults: string[] }

export const COMMANDS: Command[] = [
  { id: "palette", label: "Search", defaults: ["Cmd+P", "Cmd+K"] },
  { id: "new-chat", label: "New chat", desc: "In your home folder", defaults: ["Cmd+N"] },
  {
    id: "new-session-here",
    label: "New session here",
    desc: "Same folder and space as the current session",
    defaults: ["Cmd+T"],
  },
  { id: "archive-session", label: "Archive session", desc: "Archives the current session", defaults: ["Cmd+W"] },
  { id: "undo", label: "Undo", desc: "While an undo notice is showing", defaults: ["Cmd+Z"] },
  { id: "settings", label: "Settings", defaults: ["Cmd+,"] },
  { id: "zoom-in", label: "Larger text", defaults: ["Cmd+=", "Cmd++"] },
  { id: "zoom-out", label: "Smaller text", defaults: ["Cmd+-"] },
  { id: "zoom-reset", label: "Reset text size", defaults: ["Cmd+0"] },
]

/** commandID → its bindings; an empty list disables the command. Missing = defaults. */
export type ShortcutOverrides = Partial<Record<CommandID, string[]>>

export function bindings(id: CommandID, overrides: ShortcutOverrides = {}): string[] {
  return overrides[id] ?? COMMANDS.find((c) => c.id === id)?.defaults ?? []
}

export function commandFor(accel: string, overrides: ShortcutOverrides = {}): CommandID | undefined {
  return COMMANDS.find((c) => bindings(c.id, overrides).includes(accel))?.id
}

/** ⌘1–9 jump to sessions; ⌘Q quits. */
export function reservedReason(accel: string): string | undefined {
  if (/^Cmd\+[1-9]$/.test(accel)) return "⌘1–9 jump to sessions"
  if (accel === "Cmd+Q") return "⌘Q quits ctrl"
}

type KeyInput = { key: string; code?: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"])

/**
 * Canonical accelerator for a key press ("Cmd+Shift+P", "Cmd++"), or null for a
 * lone modifier. Letters and digits come from the physical key so ⌥ doesn't turn
 * them into symbols; other printable keys use the produced character, which
 * already reflects Shift ("Cmd++" rather than "Cmd+Shift+=").
 */
export function accelFromInput(input: KeyInput): string | null {
  if (MODIFIER_KEYS.has(input.key)) return null
  let key = input.key
  let shift = input.shift
  const code = input.code ?? ""
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (key.length === 1) {
    key = key.toUpperCase()
    if (!/[A-Z]/.test(key)) shift = false
  }
  if (key === " ") key = "Space"
  const parts = []
  if (input.control) parts.push("Ctrl")
  if (input.alt) parts.push("Alt")
  if (shift) parts.push("Shift")
  if (input.meta) parts.push("Cmd")
  parts.push(key)
  return parts.join("+")
}

/** Shortcuts need a modifier (or an F-key) so they can't swallow typing. */
export function isUsable(accel: string): boolean {
  const parts = accel.split("+")
  const key = parts.at(-1) || "+"
  return /^F\d+$/.test(key) || parts.slice(0, -1).some((m) => m === "Cmd" || m === "Ctrl" || m === "Alt")
}

const SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" }
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Escape: "⎋",
  Tab: "⇥",
  Space: "Space",
  "-": "−",
}

/** "Cmd+Shift+P" → "⇧⌘P" (macOS order: ⌃⌥⇧⌘). */
export function formatAccel(accel: string): string {
  // A trailing "+" is the key itself ("Cmd++").
  const plusKey = accel.endsWith("++")
  const parts = (plusKey ? accel.slice(0, -2) : accel).split("+").filter(Boolean)
  const key = plusKey ? "+" : parts.pop()!
  return parts.map((m) => SYMBOLS[m] ?? m).join("") + (KEY_NAMES[key] ?? key)
}

/** First binding of a command, formatted for tooltips; "" when unbound. */
export function shortcutLabel(id: CommandID, overrides?: ShortcutOverrides): string {
  const first = bindings(id, overrides)[0]
  return first ? formatAccel(first) : ""
}
