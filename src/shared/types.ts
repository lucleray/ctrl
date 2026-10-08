export type ModelRef = { providerID: string; id: string }

export type Space = {
  id: string
  name: string
  directory?: string
  collapsed?: boolean
  /** Model new sessions in this space start with (when modelEnabled isn't false) */
  model?: ModelRef
  /** Off: the space doesn't set a model and the app default applies. Unset = on, for older state. */
  modelEnabled?: boolean
  /** Extra instructions attached to every new session in this space */
  instructions?: string
}

export type ModelOption = ModelRef & {
  name: string
  /** Provider display name, e.g. "Vercel AI Gateway" */
  providerName: string
  /** Model maker for gateway-style ids ("anthropic" in "anthropic/claude-…") */
  vendor?: string
  released: number
}

export type ModelChoices = {
  /** In display order: grouped by provider, then vendor, newest first */
  models: ModelOption[]
  providers: { id: string; name: string }[]
  /** opencode's own default model for the folder */
  default?: ModelOption
}

/** Space settings editable from the renderer; null clears a field. */
export type SpacePatch = {
  name?: string
  directory?: string | null
  model?: ModelRef | null
  modelEnabled?: boolean
  instructions?: string | null
}

/** Ordered by urgency: the first one that applies wins. */
export type SessionStatus = "needs-input" | "running" | "failed" | "unread" | "idle"

export const STATUS_RANK: Record<SessionStatus, number> = {
  "needs-input": 4,
  running: 3,
  failed: 2,
  unread: 1,
  idle: 0,
}

export type SessionItem = {
  id: string
  title: string
  directory: string
  updated: number
  status: SessionStatus
  /** Human-readable explanation for the tooltip, e.g. "Waiting for permission: bash" */
  statusDetail?: string
}

export type UiState = {
  recentsCollapsed: boolean
  archivedCollapsed: boolean
  sidebarWidth: number
}

export type Appearance = "system" | "light" | "dark"

export type Settings = {
  appearance: Appearance
  /** opencode theme for the embedded TUI; null = whatever cli.json says */
  tuiTheme: string | null
  /** Dock badge with the number of sessions waiting on you */
  dockBadge: boolean
  /** macOS notifications when a background session needs you or finishes */
  notifications: boolean
  /** Terminal font size in px */
  fontSize: number
  /** Model for new sessions (spaces can override), used when defaultModelEnabled */
  defaultModel: ModelRef | null
  /** Off: ctrl passes no model and opencode's default applies */
  defaultModelEnabled: boolean
}

export const FONT_SIZE = { min: 9, max: 24, default: 13 }

export type ThemeInfo = {
  builtin: string[]
  custom: string[]
  cliDefault?: string
}

export type AppState = {
  ui: UiState
  settings: Settings
  themes: ThemeInfo
  dark: boolean
  spaces: Space[]
  assignments: Record<string, string>
  archived: Record<string, number>
  sessions: SessionItem[]
  currentSessionID: string | null
  bridgeConnected: boolean
  /** Ongoing connection trouble (opencode service or embedded TUI); clears itself */
  problem?: string
  /** Last failed action; dismissable */
  error?: string
}

export type Shortcut = "palette" | "new-chat" | "settings"

export type CtrlApi = {
  getState(): Promise<AppState>
  dismissError(): Promise<void>
  onState(cb: (state: AppState) => void): () => void
  onRenameSpace(cb: (spaceID: string) => void): () => void
  onRenameSession(cb: (sessionID: string) => void): () => void
  onShortcut(cb: (name: Shortcut) => void): () => void
  createSpace(name: string): Promise<string>
  renameSpace(id: string, name: string): Promise<void>
  onSpaceSettings(cb: (spaceID: string) => void): () => void
  updateSpace(id: string, patch: SpacePatch): Promise<void>
  pickSpaceFolder(id: string): Promise<void>
  listModels(directory?: string): Promise<ModelChoices>
  moveSpace(id: string, index: number): Promise<void>
  renameSession(sessionID: string, title: string): Promise<void>
  setArchived(sessionID: string, archived: boolean): Promise<void>
  setUi(patch: Partial<UiState>): Promise<void>
  setSettings(patch: Partial<Settings>): Promise<void>
  toggleSpace(id: string): Promise<void>
  showSpaceMenu(id: string): Promise<void>
  showSessionMenu(sessionID: string): Promise<void>
  moveSession(sessionID: string, spaceID: string | null): Promise<void>
  newSession(spaceID: string | null): Promise<void>
  openSession(sessionID: string): Promise<void>
  ptyStart(cols: number, rows: number): void
  ptyWrite(data: string): void
  ptyResize(cols: number, rows: number): void
  onPtyData(cb: (data: string) => void): () => void
  onPtyReset(cb: () => void): () => void
}
