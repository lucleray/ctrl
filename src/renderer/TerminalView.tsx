import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { Unicode11Addon } from "@xterm/addon-unicode11"

export const TERM_BG = "#eff1f5"

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
