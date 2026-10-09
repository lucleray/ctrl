import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes"
import { WebLinksAddon } from "@xterm/addon-web-links"
import type { Harness, TermInfo } from "../shared/types"
import { onLinkHover, onLinkLeave, resolveLink } from "./wrapped-links" // wrapped-links

/**
 * opencode: fallback colors before the TUI paints; the padding then tracks the TUI's own background.
 * fx: it picks fx-light or fx-dark from the background it reads back (OSC 11), so these decide its look.
 */
const PALETTES: Record<Harness, Record<"light" | "dark", Record<string, string>>> = {
  opencode: {
    light: { background: "#eff1f5", foreground: "#4c4f69", cursor: "#4c4f69" },
    dark: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#cdd6f4" },
  },
  fx: {
    light: { background: "#ffffff", foreground: "#1f1f1f", cursor: "#1f1f1f", selectionBackground: "#cfe0fc" },
    dark: { background: "#1c1c1b", foreground: "#e9e9e7", cursor: "#e9e9e7", selectionBackground: "#3a4a63" },
  },
}

const palette = (harness: Harness, dark: boolean) => PALETTES[harness][dark ? "dark" : "light"]

// xterm.js doesn't encode these the way native macOS terminals do, so translate
// them into sequences opencode and fx understand.
function translateKey(e: KeyboardEvent): string | null {
  const mods = (e.shiftKey ? "s" : "") + (e.ctrlKey ? "c" : "") + (e.altKey ? "a" : "") + (e.metaKey ? "m" : "")
  switch (`${mods}:${e.key}`) {
    case "s:Enter":
      return "\x1b[13;2u" // CSI-u shift+return → newline
    case "m:ArrowLeft":
      return "\x01" // ctrl+a → line start
    case "m:ArrowRight":
      return "\x05" // ctrl+e → line end
    case "m:Backspace":
      return "\x15" // ctrl+u → delete to line start
    default:
      return null
  }
}

// The TUIs own plain clicks (they track the mouse), so links open on ⌘-click like
// iTerm and VS Code.
const openLink = (event: MouseEvent, uri: string) => {
  if (!event.metaKey) return
  event.preventDefault()
  void window.ctrl.openExternal(uri)
}

type Chunk = { data: string; end: number }
type Pane = { term: Terminal; write(data: string, end: number): void }

/** Live terminals by id, so one IPC listener can route output to each. */
const panes = new Map<string, Pane>()
/** Output for terminals whose pane isn't attached yet. */
const early = new Map<string, Chunk[]>()

window.ctrl.onPtyData((termID, data, end) => {
  const pane = panes.get(termID)
  if (pane) return pane.write(data, end)
  const queue = early.get(termID) ?? []
  queue.push({ data, end })
  early.set(termID, queue)
  // Not ours (yet): don't hold onto unbounded output for a pane that may never mount.
  if (queue.length > 2000) queue.shift()
})

window.ctrl.onPtyReset((termID) => panes.get(termID)?.term.reset())

export type TerminalHandle = {
  focus(): void
  /** Bracketed paste into the terminal on screen, so it's inserted as text (no submit, no @file search) */
  paste(text: string): void
}

type Props = { terms: TermInfo[]; activeID: string | null; dark: boolean; fontSize: number }

/**
 * One xterm per terminal (the opencode TUI and each fx process), stacked; only the
 * active one is visible. They all keep the same size, so switching never reflows.
 */
export const TerminalStack = forwardRef<TerminalHandle, Props>(function TerminalStack(
  { terms, activeID, dark, fontSize },
  ref,
) {
  const activeRef = useRef(activeID)
  activeRef.current = activeID

  useImperativeHandle(
    ref,
    () => ({
      focus: () => (activeRef.current ? panes.get(activeRef.current)?.term.focus() : undefined),
      paste: (text) => {
        const id = activeRef.current
        if (!id) return
        window.ctrl.ptyWrite(id, `\x1b[200~${text}\x1b[201~`)
        panes.get(id)?.term.focus()
      },
    }),
    [],
  )

  useEffect(() => {
    if (activeID) requestAnimationFrame(() => panes.get(activeID)?.term.focus())
  }, [activeID])

  const active = terms.find((t) => t.id === activeID)
  return (
    <div className="terminal-stack" style={{ background: palette(active?.harness ?? "fx", dark).background }}>
      {terms.map((t) => (
        <TermPane
          key={t.id}
          id={t.id}
          harness={t.harness}
          active={t.id === activeID}
          dark={dark}
          fontSize={fontSize}
        />
      ))}
      {!active && <EmptyState />}
    </div>
  )
})

const TermPane = memo(function TermPane({
  id,
  harness,
  active,
  dark,
  fontSize,
}: {
  id: string
  harness: Harness
  active: boolean
  dark: boolean
  fontSize: number
}) {
  const el = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal>(null)
  const fitRef = useRef<FitAddon>(null)
  const initial = useRef({ dark, fontSize })
  const fallback = useRef(palette(harness, dark))
  fallback.current = palette(harness, dark)

  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: initial.current.fontSize,
      lineHeight: 1.15,
      allowProposedApi: true,
      macOptionIsMeta: true,
      cursorBlink: true,
      // opencode draws full screen; fx renders inline and leaves the transcript in scrollback.
      scrollback: harness === "fx" ? 10_000 : 0,
      theme: fallback.current,
      // OSC 8 hyperlinks (e.g. markdown links the TUI renders)
      linkHandler: { activate: openLink, allowNonHttpProtocols: true },
    })
    termRef.current = t
    const fit = new FitAddon()
    fitRef.current = fit
    t.loadAddon(fit)
    // Joins ZWJ emoji (🏄‍♂️), flags and accents into one cell group, so widths match what's drawn.
    t.loadAddon(new UnicodeGraphemesAddon())
    // Bare URLs in the output
    t.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (!event.metaKey) return
          event.preventDefault()
          void resolveLink(uri).then(window.ctrl.openExternal) // wrapped-links (was: openLink)
        },
        { hover: (_e, uri, range) => onLinkHover(t, uri, range), leave: onLinkLeave }, // wrapped-links
      ),
    )
    t.attachCustomKeyEventHandler((e) => {
      const seq = translateKey(e)
      if (!seq) return true
      // Swallow keydown/keypress/keyup so xterm doesn't also send its own encoding.
      if (e.type === "keydown") window.ctrl.ptyWrite(id, seq)
      e.preventDefault()
      return false
    })
    t.open(el.current!)
    try {
      t.loadAddon(new WebglAddon())
    } catch {}
    fit.fit()

    // opencode paints its own background: match the padding around the terminal to it.
    let sampleTimer: ReturnType<typeof setTimeout> | undefined
    const sampleBg = () => {
      const cell = t.buffer.active.getLine(t.buffer.active.viewportY)?.getCell(0)
      const color = cell?.isBgRGB() ? `#${cell.getBgColor().toString(16).padStart(6, "0")}` : fallback.current.background
      if (wrap.current) wrap.current.style.background = color
    }
    const written = () => {
      if (harness !== "opencode") return
      clearTimeout(sampleTimer)
      sampleTimer = setTimeout(sampleBg, 100)
    }

    // Chunks before the backlog arrives are queued; afterwards, skip what the backlog already holds.
    let attached = false
    let end = 0
    const write = (data: string, chunkEnd: number) => {
      if (!attached) {
        const queue = early.get(id) ?? []
        queue.push({ data, end: chunkEnd })
        early.set(id, queue)
        return
      }
      if (chunkEnd <= end) return
      t.write(chunkEnd - data.length < end ? data.slice(data.length - (chunkEnd - end)) : data, written)
      end = chunkEnd
    }
    panes.set(id, { term: t, write })
    void window.ctrl.ptyAttach(id).then((backlog) => {
      t.write(backlog.data, written)
      attached = true
      end = backlog.end
      const queued = early.get(id) ?? []
      early.delete(id)
      for (const c of queued) write(c.data, c.end)
    })

    // Debug hook for CTRL_EVAL test runs
    ;(window as unknown as { __terms: Map<string, Pane> }).__terms = panes
    if (harness === "opencode") (window as unknown as { __term: Terminal }).__term = t

    const input = t.onData((d) => window.ctrl.ptyWrite(id, d))
    const resize = t.onResize(({ cols, rows }) => window.ctrl.ptyResize(cols, rows))
    window.ctrl.ptyResize(t.cols, t.rows)

    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fit.fit())
    })
    ro.observe(el.current!)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      clearTimeout(sampleTimer)
      panes.delete(id)
      early.delete(id)
      input.dispose()
      resize.dispose()
      t.dispose()
    }
  }, [id, harness])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = fallback.current
    if (harness === "fx" && wrap.current) wrap.current.style.background = fallback.current.background
  }, [dark, harness])

  useEffect(() => {
    const t = termRef.current
    if (!t || t.options.fontSize === fontSize) return
    t.options.fontSize = fontSize
    // New cell size → new cols/rows; onResize forwards them to the ptys.
    fitRef.current?.fit()
  }, [fontSize])

  useEffect(() => {
    // Hidden panes keep their size, but refit when shown in case the window changed meanwhile.
    if (active) requestAnimationFrame(() => fitRef.current?.fit())
  }, [active])

  return (
    <div
      className={`terminal-pane ${active ? "active" : ""}`}
      ref={wrap}
      style={{ background: fallback.current.background }}
    >
      <div className="terminal" ref={el} />
    </div>
  )
})

function EmptyState() {
  return (
    <div className="terminal-empty">
      <div className="terminal-empty-logo">ctrl</div>
      <div>Pick a session, or start a new one with ⌘N</div>
    </div>
  )
}
