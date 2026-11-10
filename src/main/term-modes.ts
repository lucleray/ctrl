// DEC private modes (`ESC [ ? n h` / `l`): alternate screen, mouse tracking and encoding, bracketed paste,
// focus events, cursor visibility.
const MODE = /\x1b\[\?([\d;]+)([hl])/g

/**
 * The private modes a TUI has turned on, so a terminal attaching late (a renderer reload) can be put back in
 * them. Without it, the opencode TUI's attach starts from nothing (it has no backlog), and xterm sends the
 * wheel as arrow keys since it never saw mouse tracking turned on.
 */
export class TermModes {
  private on = new Set<number>()

  feed(data: string) {
    if (!data.includes("\x1b[?")) return
    for (const [, nums, op] of data.matchAll(MODE)) {
      for (const n of nums.split(";").map(Number)) {
        if (op === "h") this.on.add(n)
        else this.on.delete(n)
      }
    }
  }

  reset() {
    this.on.clear()
  }

  /** Escape sequences turning the current modes back on */
  replay() {
    return [...this.on].map((n) => `\x1b[?${n}h`).join("")
  }
}
