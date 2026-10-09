import { useCallback, useEffect, useRef, useState } from "react"
import { shortcutLabel } from "../shared/shortcuts"
import { FONT_SIZE, type AppState } from "../shared/types"
import { jumpTargets, useJumpHints } from "./jump"
import { Palette } from "./Palette"
import { ReferenceDrop } from "./ReferenceDrop"
import { ResourcesPanel } from "./ResourcesPanel"
import { Settings } from "./Settings"
import { Sidebar } from "./Sidebar"
import { SpaceSettings } from "./SpaceSettings"
import { TerminalView, type TerminalHandle } from "./TerminalView"
import { Toasts } from "./Toast"

const EMPTY: AppState = {
  ui: {
    recentsCollapsed: false,
    archivedCollapsed: true,
    sidebarWidth: 280,
    resourcesOpen: true,
    resourcesWidth: 300,
    resourcesScope: "session",
  },
  settings: { appearance: "system", tuiTheme: null, dockBadge: true, notifications: true, fontSize: FONT_SIZE.default, defaultModel: null, defaultModelEnabled: false, shortcuts: {} },
  themes: { builtin: [], custom: [] },
  dark: false,
  spaces: [],
  assignments: {},
  archived: {},
  sessions: [],
  currentSessionID: null,
  bridgeConnected: false,
  mcp: [],
}

export function App() {
  const [state, setState] = useState<AppState>(EMPTY)
  const [palette, setPalette] = useState(false)
  const [settings, setSettings] = useState(false)
  const [spaceSettingsID, setSpaceSettingsID] = useState<string | null>(null)
  const editingSpace = state.spaces.find((s) => s.id === spaceSettingsID)
  // Hints stay up while ⌘ is held, so you can hop ⌘1 → ⌘3 → ⌘2 in one go.
  const { hints, cancel: cancelHints } = useJumpHints((n) => {
    const id = jumpTargets()[n - 1]
    if (id) open(id)
  })
  const terminal = useRef<TerminalHandle>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    void window.ctrl.getState().then(setState)
    return window.ctrl.onState(setState)
  }, [])

  const open = useCallback((id: string) => {
    setSettings(false)
    setSpaceSettingsID(null)
    void window.ctrl.openSession(id)
    terminal.current?.focus()
  }, [])

  const create = useCallback(async (spaceID: string | null) => {
    setSettings(false)
    setSpaceSettingsID(null)
    await window.ctrl.newSession(spaceID)
    terminal.current?.focus()
  }, [])

  const fixMcp = useCallback((name: string) => {
    setPalette(false)
    setSettings(false)
    setSpaceSettingsID(null)
    void window.ctrl.fixMcp(name)
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

  const closeSpaceSettings = useCallback(() => {
    setSpaceSettingsID(null)
    terminal.current?.focus()
  }, [])

  useEffect(
    () =>
      window.ctrl.onSpaceSettings((id) => {
        setSettings(false)
        setSpaceSettingsID(id)
      }),
    [],
  )

  const closePalette = useCallback(() => {
    setPalette(false)
    terminal.current?.focus()
  }, [])

  useEffect(
    () =>
      window.ctrl.onShortcut((name) => {
        cancelHints()
        if (name === "palette") setPalette((p) => !p)
        if (name === "settings") {
          setPalette(false)
          setSpaceSettingsID(null)
          setSettings((v) => !v)
        }
        if (name === "new-chat") {
          setPalette(false)
          void create(null)
        }
        // Main creates the session; just get out of the way.
        if (name === "new-session-here") {
          setPalette(false)
          setSettings(false)
          setSpaceSettingsID(null)
          terminal.current?.focus()
        }
      }),
    [create, cancelHints],
  )

  return (
    <div className="app">
      <Sidebar
        state={state}
        hints={hints}
        onOpen={open}
        onNew={create}
        onSearch={() => setPalette(true)}
        onSettings={() => {
          setSpaceSettingsID(null)
          setSettings((v) => !v)
        }}
        onToggleResources={() => void window.ctrl.setUi({ resourcesOpen: !state.ui.resourcesOpen })}
      />
      <main className="main">
        <div className="main-drag" />
        <TerminalView ref={terminal} dark={state.dark} fontSize={state.settings.fontSize} />
        <ReferenceDrop
          sessions={state.sessions}
          currentSessionID={state.currentSessionID}
          onReference={(text) => {
            // Bracketed paste so the TUI inserts it as text (no submit, no @file search).
            window.ctrl.ptyWrite(`\x1b[200~${text} \x1b[201~`)
            terminal.current?.focus()
          }}
        />
        {settings && <Settings state={state} onClose={closeSettings} onFixMcp={fixMcp} />}
        <Toasts
          onView={open}
          onAction={() => terminal.current?.focus()}
          undoLabel={shortcutLabel("undo", state.settings.shortcuts)}
        />
        {editingSpace && (
          <SpaceSettings
            key={editingSpace.id}
            space={editingSpace}
            appDefault={state.settings.defaultModelEnabled ? state.settings.defaultModel : null}
            onClose={closeSpaceSettings}
          />
        )}
        {state.ui.resourcesOpen && (
          <ResourcesPanel
            state={state}
            onClose={() => {
              void window.ctrl.setUi({ resourcesOpen: false })
              terminal.current?.focus()
            }}
          />
        )}
      </main>
      {palette && (
        <Palette state={state} onClose={closePalette} onOpen={open} onNew={create} onRevealSpace={revealSpace} />
      )}
    </div>
  )
}
