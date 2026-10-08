import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { Unicode11Addon } from "@xterm/addon-unicode11"

export const TERM_BG = "#eff1f5"

// xterm.js doesn't encode these the way native macOS terminals do, so translate
// them into sequences opencode understands.
function translateKey(e: KeyboardEvent): string | null {
  const mods = (e.shiftKey ? "s" : "") + (e.ctrlKey ? "c" : "") + (e.altKey ? "a" : "") + (e.metaKey ? "m" : "")
  switch (`${mods}:${e.key}`) {
    case "s:Enter":
      return "\x1b[13;2u" // CSI-u shift+return → input.newline
    case "m:ArrowLeft":
      return "\x01" // ctrl+a → input.line.home
    case "m:ArrowRight":
      return "\x05" // ctrl+e → input.line.end
    case "m:Backspace":
      return "\x15" // ctrl+u → input.delete.to.line.start
    default:
      return null
  }
}

export type TerminalHandle = { focus(): void }

export const TerminalView = forwardRef<TerminalHandle>(function TerminalView(_props, ref) {
  const el = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({ focus: () => term.current?.focus() }), [])

  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      allowProposedApi: true,
      macOptionIsMeta: true,
      cursorBlink: true,
      scrollback: 0,
      theme: { background: TERM_BG, foreground: "#4c4f69", cursor: "#4c4f69" },
    })
    term.current = t
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = "11"
    t.attachCustomKeyEventHandler((e) => {
      const seq = translateKey(e)
      if (!seq) return true
      // Swallow keydown/keypress/keyup so xterm doesn't also send its own encoding.
      if (e.type === "keydown") window.ctrl.ptyWrite(seq)
      e.preventDefault()
      return false
    })
    t.open(el.current!)
    try {
      t.loadAddon(new WebglAddon())
    } catch {}
    fit.fit()

    // Match the padding around the terminal to the background the TUI paints.
    let sampleTimer: ReturnType<typeof setTimeout> | undefined
    const sampleBg = () => {
      const cell = t.buffer.active.getLine(t.buffer.active.viewportY)?.getCell(0)
      const color = cell?.isBgRGB() ? `#${cell.getBgColor().toString(16).padStart(6, "0")}` : TERM_BG
      wrap.current!.style.background = color
    }
    const offData = window.ctrl.onPtyData((d) =>
      t.write(d, () => {
        clearTimeout(sampleTimer)
        sampleTimer = setTimeout(sampleBg, 100)
      }),
    )
    const offReset = window.ctrl.onPtyReset(() => t.reset())
    const input = t.onData((d) => window.ctrl.ptyWrite(d))
    const resize = t.onResize(({ cols, rows }) => window.ctrl.ptyResize(cols, rows))
    window.ctrl.ptyStart(t.cols, t.rows)
    t.focus()

    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fit.fit())
    })
    ro.observe(el.current!)

    return () => {
      ro.disconnect()
      clearTimeout(sampleTimer)
      offData()
      offReset()
      input.dispose()
      resize.dispose()
      t.dispose()
    }
  }, [])

  return (
    <div className="terminal-wrap" ref={wrap} style={{ background: TERM_BG }}>
      <div className="terminal" ref={el} />
    </div>
  )
})
