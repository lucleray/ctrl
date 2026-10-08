// WORKAROUND for URLs that opencode wraps over two rows; see src/main/wrapped-links.ts
// for how to remove it.
import type { IViewportRange, Terminal } from "@xterm/xterm"

// Characters a wrapped URL can continue with on the next row.
const CONTINUATION = /^[\w\-.~:/?#[\]@!$&'()*+,;=%]+/

let hovered: { uri: string; next: string } | null = null

/** Remembers the first word of the row after the hovered link, and warms the lookup if there is one. */
export function onLinkHover(term: Terminal, uri: string, range: IViewportRange) {
  // The addon passes the link's 1-based buffer range despite the typing, so
  // `end.y` is the 0-based index of the following row.
  const line = term.buffer.active.getLine(range.end.y)?.translateToString(true) ?? ""
  const next = line.replace(/^[\s\u2500-\u259f]+/, "").match(CONTINUATION)?.[0] ?? ""
  hovered = { uri, next }
  if (next) void window.ctrl.prefetchLinks()
}

export function onLinkLeave() {
  hovered = null
}

/** The full URL when the link continues on the next row, else `uri` unchanged. */
export async function resolveLink(uri: string): Promise<string> {
  const next = hovered?.uri === uri ? hovered.next : ""
  return next ? window.ctrl.resolveLink(uri, next) : uri
}
