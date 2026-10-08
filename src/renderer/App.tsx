import { useCallback, useEffect, useRef, useState } from "react"
import type { AppState } from "../shared/types"
import { shortPath } from "./format"
import { Palette } from "./Palette"
import { Sidebar } from "./Sidebar"
import { TerminalView, type TerminalHandle } from "./TerminalView"

const EMPTY: AppState = {
  spaces: [],
  assignments: {},
  archived: {},
  sessions: [],
  currentSessionID: null,
  bridgeConnected: false,
}

export function App() {
  const [state, setState] = useState<AppState>(EMPTY)
  const [palette, setPalette] = useState(false)
  const terminal = useRef<TerminalHandle>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    void window.ctrl.getState().then(setState)
    return window.ctrl.onState(setState)
  }, [])

  const open = useCallback((id: string) => {
    void window.ctrl.openSession(id)
    terminal.current?.focus()
  }, [])

  const create = useCallback(async (spaceID: string | null) => {
    await window.ctrl.newSession(spaceID)
    terminal.current?.focus()
  }, [])

  const revealSpace = useCallback(async (spaceID: string) => {
    if (stateRef.current.spaces.find((s) => s.id === spaceID)?.collapsed) await window.ctrl.toggleSpace(spaceID)
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-space-id="${spaceID}"]`)
      if (!el) return
      el.scrollIntoView({ block: "nearest", behavior: "smooth" })
      el.classList.remove("flash")
      void el.offsetWidth
      el.classList.add("flash")
    })
  }, [])

  const closePalette = useCallback(() => {
    setPalette(false)
    terminal.current?.focus()
  }, [])

  useEffect(
    () =>
      window.ctrl.onShortcut((name) => {
        if (name === "palette") setPalette((p) => !p)
        if (name === "new-chat") {
          setPalette(false)
          void create(null)
        }
      }),
    [create],
  )

  const current = state.sessions.find((s) => s.id === state.currentSessionID)

  return (
    <div className="app">
      <Sidebar state={state} onOpen={open} onNew={create} onSearch={() => setPalette(true)} />
      <main className="main">
        <header className="titlebar">
          <span className="title">{current?.title ?? "OpenCode"}</span>
          {current && <span className="subtitle">{shortPath(current.directory)}</span>}
          <span className="spacer" />
          {state.error && <span className="error" title={state.error}>⚠ {state.error}</span>}
          <span className={`bridge ${state.bridgeConnected ? "on" : ""}`} title="TUI bridge">
            {state.bridgeConnected ? "connected" : "connecting…"}
          </span>
        </header>
        <TerminalView ref={terminal} />
      </main>
      {palette && (
        <Palette state={state} onClose={closePalette} onOpen={open} onNew={create} onRevealSpace={revealSpace} />
      )}
    </div>
  )
}
