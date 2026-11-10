import { useCallback, useEffect, useRef, useState } from "react"
import { shortcutLabel } from "../shared/shortcuts"
import { DEFAULT_SOUND_CHOICES, FONT_SIZE, harnessOf, type AppState } from "../shared/types"
import { ArchivedBanner } from "./ArchivedBanner"
import { ChatHome, ChatView, type ChatHandle } from "./ChatView"
import { Board, loadFilter, onlySpace, saveFilter, type BoardFilter } from "./Board"
import { jumpTargets, useJumpHints } from "./jump"
import { Onboarding } from "./Onboarding"
import { Palette } from "./Palette"
import { ReferenceDrop } from "./ReferenceDrop"
import { ResourcesPanel } from "./ResourcesPanel"
import { Settings } from "./Settings"
import { Sidebar } from "./Sidebar"
import { SpaceSettings } from "./SpaceSettings"
import { TerminalStack, type TerminalHandle } from "./TerminalStack"
import { Toasts } from "./Toast"

const EMPTY: AppState = {
  version: "",
  opencode: { state: "checking" },
  opencodeServer: { state: "checking" },
  fx: { state: "checking" },
  skill: { state: "missing" },
  cli: { state: "missing", link: "", target: "" },
  cliSkill: { state: "missing" },
  update: { state: "idle" },
  ui: {
    recentsCollapsed: false,
    archivedCollapsed: true,
    sidebarWidth: 280,
    resourcesOpen: true,
    resourcesWidth: 300,
    resourcesScope: "session",
    resourcesCollapsed: false,
    resourcesDocked: false,
  },
  settings: { appearance: "system", tuiTheme: null, dockBadge: true, notifications: true, sounds: true, soundsWhenFocused: false, soundChoices: DEFAULT_SOUND_CHOICES, fontSize: FONT_SIZE.default, defaultHarness: "opencode", defaultDirectory: null, defaultSpace: null, defaultModel: null, defaultFxModel: null, defaultModelEnabled: false, ctrlInstructions: true, shortcuts: {}, adapterModes: {}, companion: false, remoteControl: false, sessionView: "terminal" },
  themes: { builtin: [], custom: [] },
  dark: false,
  spaces: [],
  assignments: {},
  createdByAgent: {},
  parents: {},
  archived: {},
  sessions: [],
  currentSessionID: null,
  bridgeConnected: false,
  terms: [],
  activeTermID: null,
  mcp: [],
  adapters: [],
  remote: { state: "off" },
}

export function App() {
  const [state, setState] = useState<AppState>(EMPTY)
  const [palette, setPalette] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState("")
  const [settings, setSettings] = useState(false)
  const [spaceSettingsID, setSpaceSettingsID] = useState<string | null>(null)
  const [board, setBoard] = useState(false)
  // Spaces the board shows, empty = everything. Kept while ctrl runs, so reopening keeps the filter.
  const [boardFilter, setBoardFilterState] = useState<BoardFilter>(loadFilter)
  const setBoardFilter = useCallback((f: BoardFilter) => {
    setBoardFilterState(f)
    saveFilter(f)
  }, [])
  const editingSpace = state.spaces.find((s) => s.id === spaceSettingsID)
  // Hints stay up while ⌘ is held, so you can hop ⌘1 → ⌘3 → ⌘2 in one go.
  const { hints, cancel: cancelHints } = useJumpHints((n) => {
    const id = jumpTargets()[n - 1]
    if (id) open(id)
  })
  const terminal = useRef<TerminalHandle>(null)
  const chat = useRef<ChatHandle>(null)
  // The chat view while it's on screen, else the terminal.
  const focusMain = useCallback(() => (chat.current ? chat.current.focus() : terminal.current?.focus()), [])
  // Either harness is enough: without opencode, ctrl runs fx sessions only (and the other way round).
  const ready = state.opencode.state === "ok" || state.fx.state === "ok"
  const activeTerm = state.terms.find((t) => t.id === state.activeTermID)
  // Its terminal is read-only (TerminalStack) until it's unarchived.
  const archivedOnScreen = activeTerm?.sessionID && state.archived[activeTerm.sessionID] ? activeTerm.sessionID : null
  // Sessions as chat: opencode sessions show as a chat over the TUI, which keeps running underneath.
  const chatID =
    state.settings.sessionView === "chat" &&
    activeTerm?.harness === "opencode" &&
    state.currentSessionID &&
    harnessOf(state.currentSessionID) === "opencode"
      ? state.currentSessionID
      : null
  // No session on screen (the TUI's new-session screen, e.g. after archiving): a centered composer instead.
  const chatHome =
    state.settings.sessionView === "chat" && activeTerm?.harness === "opencode" && !state.currentSessionID && state.opencode.state === "ok"
  const checked = state.opencode.state !== "checking" && state.fx.state !== "checking"
  // First launch, or nothing usable installed. Drawn over the terminals, which keep running underneath.
  const onboarding = checked && (!state.ui.onboarded || !ready)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    void window.ctrl.getState().then(setState)
    return window.ctrl.onState(setState)
  }, [])

  const open = useCallback((id: string) => {
    setSettings(false)
    setSpaceSettingsID(null)
    setBoard(false)
    void window.ctrl.openSession(id)
    focusMain()
  }, [])

  const create = useCallback(async (spaceID: string | null) => {
    setSettings(false)
    setSpaceSettingsID(null)
    setBoard(false)
    await window.ctrl.newSession(spaceID)
    focusMain()
  }, [])

  const fixMcp = useCallback((name: string) => {
    setPalette(false)
    setSettings(false)
    setSpaceSettingsID(null)
    void window.ctrl.fixMcp(name)
    focusMain()
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
    focusMain()
  }, [])

  const closeSpaceSettings = useCallback(() => {
    setSpaceSettingsID(null)
    focusMain()
  }, [])

  useEffect(
    () =>
      window.ctrl.onSpaceSettings((id) => {
        setSettings(false)
        setBoard(false)
        setSpaceSettingsID(id)
      }),
    [],
  )

  useEffect(
    () =>
      window.ctrl.onBoardOpen((id) => {
        setSettings(false)
        setSpaceSettingsID(null)
        setBoardFilter(onlySpace(id))
        setBoard(true)
      }),
    [setBoardFilter],
  )

  const toggleBoard = useCallback(() => {
    setSettings(false)
    setSpaceSettingsID(null)
    setBoard((b) => !b)
  }, [])

  const closeBoard = useCallback(() => {
    setBoard(false)
    focusMain()
  }, [])

  // The CLI (`ctrl ui settings`, `ctrl ui palette`) drives these too.
  useEffect(
    () =>
      window.ctrl.onUiSettings((open) => {
        setPalette(false)
        setSpaceSettingsID(null)
        setBoard(false)
        setSettings(open)
      }),
    [],
  )
  useEffect(
    () =>
      window.ctrl.onUiPalette((query) => {
        setSettings(false)
        setSpaceSettingsID(null)
        setPaletteQuery(query)
        setPalette(true)
      }),
    [],
  )

  const closePalette = useCallback(() => {
    setPaletteQuery("")
    setPalette(false)
    focusMain()
  }, [])

  useEffect(
    () =>
      window.ctrl.onShortcut((name) => {
        cancelHints()
        if (name === "palette") setPalette((p) => !p)
        if (name === "settings") {
          setPalette(false)
          setSpaceSettingsID(null)
          setBoard(false)
          setSettings((v) => !v)
        }
        if (name === "new-chat") {
          setPalette(false)
          void create(null)
        }
        // Main creates the session; just get out of the way.
        if (name === "new-session-here" || name === "companion-new-session") {
          setPalette(false)
          setSettings(false)
          setSpaceSettingsID(null)
          focusMain()
        }
      }),
    [create, cancelHints],
  )

  const showResources = state.ui.resourcesOpen && !settings && !editingSpace && !board && ready && !onboarding
  // Floating, it sits over the terminal inside main; docked, it's a column next to main.
  const resources = (
    <ResourcesPanel
      state={state}
      onClose={() => {
        void window.ctrl.setUi({ resourcesOpen: false })
        focusMain()
      }}
    />
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
          setBoard(false)
          setSettings((v) => !v)
        }}
        boardOpen={!!board}
        onToggleBoard={toggleBoard}
        onToggleResources={() => void window.ctrl.setUi({ resourcesOpen: !state.ui.resourcesOpen })}
        footer={
          <Toasts
            onView={open}
            onAction={() => focusMain()}
            undoLabel={shortcutLabel("undo", state.settings.shortcuts)}
          />
        }
      />
      <main className="main">
        <div className="main-drag" />
        {ready && (
          <>
            <TerminalStack
              ref={terminal}
              terms={state.terms}
              activeID={state.activeTermID}
              dark={state.dark}
              fontSize={state.settings.fontSize}
              opencodeOpensLinks={state.opencode.state === "ok" && state.opencode.opensLinks}
              archived={state.archived}
              concealed={!!chatID || chatHome}
            />
            {chatID && (
              <ChatView
                ref={chat}
                sessionID={chatID}
                session={state.sessions.find((s) => s.id === chatID)}
                archived={!!state.archived[chatID]}
              />
            )}
            {chatHome && <ChatHome ref={chat} />}
            {archivedOnScreen && !onboarding && (
              <ArchivedBanner
                onUnarchive={() => {
                  void window.ctrl.setArchived(archivedOnScreen, false)
                  focusMain()
                }}
              />
            )}
            {activeTerm && !archivedOnScreen && (
              <ReferenceDrop
                sessions={state.sessions}
                currentSessionID={state.currentSessionID}
                target={activeTerm.harness}
                onReference={(text, kind) => {
                  if (chat.current) chat.current.paste(`${text} `)
                  else terminal.current?.paste(`${text} `)
                  if (kind === "session") void window.ctrl.sessionReferenced()
                }}
              />
            )}
          </>
        )}
        {onboarding && (
          <Onboarding
            opencode={state.opencode}
            fx={state.fx}
            defaultHarness={state.settings.defaultHarness}
            onDone={(defaultHarness) => {
              void window.ctrl.setSettings({ defaultHarness })
              void window.ctrl.setUi({ onboarded: true })
              focusMain()
            }}
          />
        )}
        {board && !settings && !editingSpace && ready && !onboarding && (
          <Board state={state} filter={boardFilter} onFilter={setBoardFilter} onClose={closeBoard} onOpenSession={open} />
        )}
        {settings && <Settings state={state} onClose={closeSettings} onFixMcp={fixMcp} />}
        {editingSpace && (
          <SpaceSettings
            key={editingSpace.id}
            space={editingSpace}
            settings={state.settings}
            fx={state.fx}
            onClose={closeSpaceSettings}
          />
        )}
        {showResources && !state.ui.resourcesDocked && resources}
      </main>
      {showResources && state.ui.resourcesDocked && resources}
      {palette && (
        <Palette
          key={paletteQuery}
          state={state}
          initialQuery={paletteQuery}
          onClose={closePalette}
          onOpen={open}
          onNew={create}
          onRevealSpace={revealSpace}
        />
      )}
    </div>
  )
}
