import { useEffect, useRef, useState } from "react"
import type { AppState } from "../shared/types"
import { Sidebar } from "./Sidebar"
import { TerminalView, type TerminalHandle } from "./TerminalView"

const EMPTY: AppState = {
  spaces: [],
  assignments: {},
  sessions: [],
  currentSessionID: null,
  bridgeConnected: false,
}

export function App() {
  const [state, setState] = useState<AppState>(EMPTY)
  const terminal = useRef<TerminalHandle>(null)

  useEffect(() => {
    void window.ctrl.getState().then(setState)
    return window.ctrl.onState(setState)
  }, [])

  const current = state.sessions.find((s) => s.id === state.currentSessionID)

  const open = (id: string) => {
    void window.ctrl.openSession(id)
    terminal.current?.focus()
  }
  const create = async (spaceID: string | null) => {
    await window.ctrl.newSession(spaceID)
    terminal.current?.focus()
  }

  return (
    <div className="app">
      <Sidebar state={state} onOpen={open} onNew={create} />
      <main className="main">
        <header className="titlebar">
          <span className="title">{current?.title ?? "OpenCode"}</span>
          {current && <span className="subtitle">{current.directory.replace(/^\/Users\/[^/]+/, "~")}</span>}
          <span className="spacer" />
          {state.error && <span className="error" title={state.error}>⚠ {state.error}</span>}
          <span className={`bridge ${state.bridgeConnected ? "on" : ""}`} title="TUI bridge">
            {state.bridgeConnected ? "connected" : "connecting…"}
          </span>
        </header>
        <TerminalView ref={terminal} />
      </main>
    </div>
  )
}
