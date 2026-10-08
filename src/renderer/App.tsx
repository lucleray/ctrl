import { useCallback, useEffect, useRef, useState } from "react"
import type { AppState } from "../shared/types"
import { Palette } from "./Palette"
import { Settings } from "./Settings"
import { Sidebar } from "./Sidebar"
import { TerminalView, type TerminalHandle } from "./TerminalView"

const EMPTY: AppState = {
  ui: { recentsCollapsed: false, archivedCollapsed: true, sidebarWidth: 280 },
  settings: { appearance: "system", tuiTheme: null, dockBadge: true, notifications: true },
  themes: { builtin: [], custom: [] },
  dark: false,
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
  const [settings, setSettings] = useState(false)
  const terminal = useRef<TerminalHandle>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    void window.ctrl.getState().then(setState)
    return window.ctrl.onState(setState)
  }, [])

  const open = useCallback((id: string) => {
    setSettings(false)
    void window.ctrl.openSession(id)
    terminal.current?.focus()
  }, [])

  const create = useCallback(async (spaceID: string | null) => {
    setSettings(false)
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

  const closeSettings = useCallback(() => {
    setSettings(false)
    terminal.current?.focus()
  }, [])

  const closePalette = useCallback(() => {
    setPalette(false)
    terminal.current?.focus()
  }, [])

  useEffect(
    () =>
      window.ctrl.onShortcut((name) => {
        if (name === "palette") setPalette((p) => !p)
        if (name === "settings") {
          setPalette(false)
          setSettings((v) => !v)
        }
        if (name === "new-chat") {
          setPalette(false)
          void create(null)
        }
      }),
    [create],
  )

  return (
    <div className="app">
      <Sidebar
        state={state}
        onOpen={open}
        onNew={create}
        onSearch={() => setPalette(true)}
        onSettings={() => setSettings((v) => !v)}
      />
      <main className="main">
        <div className="main-drag" />
        <TerminalView ref={terminal} dark={state.dark} />
        {settings && <Settings state={state} onClose={closeSettings} />}
      </main>
      {palette && (
        <Palette state={state} onClose={closePalette} onOpen={open} onNew={create} onRevealSpace={revealSpace} />
      )}
    </div>
  )
}
