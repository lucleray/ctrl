import type { CommandID, ShortcutOverrides } from "./shortcuts"

/** variant: opencode model variant (e.g. reasoning effort "high"); unset = the model's default */
export type ModelRef = { providerID: string; id: string; variant?: string }

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
  /** Selectable variant ids, in opencode's order */
  variants: string[]
}

export type ModelChoices = {
  /** In display order: grouped by provider, then vendor, newest first */
  models: ModelOption[]
  providers: { id: string; name: string }[]
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
  /** Right-hand resources panel */
  resourcesOpen: boolean
  resourcesWidth: number
  /** Resources of the current session, or of every session in its space */
  resourcesScope: "session" | "space"
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
  /** Play a sound when a session needs you, finishes or fails */
  sounds: boolean
  /** Also play sounds while ctrl is focused (otherwise only in the background, like notifications) */
  soundsWhenFocused: boolean
  /** Per event: a macOS system sound name (SYSTEM_SOUNDS), an absolute file path, or null for silence */
  soundChoices: Record<SoundEvent, string | null>
  /** Terminal font size in px */
  fontSize: number
  /** Model for new sessions (spaces can override), used when defaultModelEnabled */
  defaultModel: ModelRef | null
  /** Off: ctrl passes no model and opencode's default applies */
  defaultModelEnabled: boolean
  /** Rebound shortcuts; commands not listed use their defaults */
  shortcuts: ShortcutOverrides
  /** Per resource adapter id; adapters not listed use defaultAdapterMode */
  adapterModes: Record<string, AdapterMode>
}

export const FONT_SIZE = { min: 9, max: 24, default: 13 }

/** Session transitions that can play a sound, most urgent first. */
export type SoundEvent = "needs-input" | "failed" | "finished"

export const SOUND_EVENTS: { id: SoundEvent; label: string }[] = [
  { id: "needs-input", label: "Needs your input" },
  { id: "failed", label: "Failed" },
  { id: "finished", label: "Finished" },
]

/** In /System/Library/Sounds/<name>.aiff */
export const SYSTEM_SOUNDS = [
  "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
  "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
]

export const DEFAULT_SOUND_CHOICES: Record<SoundEvent, string | null> = {
  "needs-input": "Glass",
  failed: "Basso",
  finished: "Hero",
}

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
  /** MCP servers as opencode reports them for the TUI's folder (~) */
  mcp: McpServerItem[]
  /** Resource adapters (live details for links), in Settings order */
  adapters: AdapterInfo[]
  /** Ongoing connection trouble (opencode service or embedded TUI); clears itself */
  problem?: string
  /** Last failed action; dismissable */
  error?: string
}

/** A session whose messages match a search, with its best-matching message. */
export type SearchHit = {
  sessionID: string
  /** From the index; prefer the live title when the session is loaded */
  title: string
  role: "user" | "assistant"
  created: number
  /** Excerpt around the match; matches are wrapped in \uE000…\uE001 */
  snippet: string
}

export type IndexStatus = { indexing: boolean; done: number; total: number }

/** A resource (see src/shared/adapters) and how it was mentioned in the queried sessions. */
export type ResourceItem = {
  /** Canonical key, e.g. "github-pr:vercel/infra#36612" */
  id: string
  type: string
  url: string
  data: Record<string, string>
  mentions: number
  /** How many of the queried sessions mention it */
  sessions: number
  first: number
  last: number
  /** You pasted it in a prompt (vs only the assistant mentioning it) */
  sharedByYou: boolean
  /** Live details from its adapter, when that adapter has a live part (src/shared/adapters) */
  meta?: ResourceMeta
}

/** Colors for a resource's icon and chips. */
export type Tone = "open" | "good" | "done" | "bad" | "warn" | "muted"

/**
 * Live details of a resource, from its adapter's live part
 * (src/shared/adapters). Display-ready, so the panel needs no per-service code.
 */
export type ResourceMeta = {
  /** Replaces the title parsed from the URL */
  title?: string
  /** Replaces the subtitle parsed from the URL */
  subtitle?: string
  /** Icon color: open/good green, done purple, bad red, warn amber, muted grey */
  tone?: Tone
  chips?: { text: string; tone: Tone; title?: string }[]
  /** Extra tooltip lines */
  details?: string[]
  /** Not found, or not visible to the CLI's account */
  missing?: boolean
  fetched: number
}

/** Settings: hide its links, show links only, or also fetch live details. */
export type AdapterMode = "off" | "links" | "live"

/** The CLI a live adapter fetches with. Commands are shown in Settings' setup prompt. */
export type CliInfo = {
  command: string
  /** Shell command that installs it */
  install: string
  /** Shell command that logs in (usually interactive) */
  login: string
  /** Shell command that prints who it's logged in as */
  verify: string
}

export type AdapterStatus = {
  /**
   * checking: first check running · ok: CLI ready · no-cli: not installed ·
   * logged-out: not logged in · paused: rate limited · error: last fetch or check failed
   */
  state: "checking" | "ok" | "no-cli" | "logged-out" | "error" | "paused"
  /** Who the CLI is logged in as */
  account?: string
  detail?: string
}

/** A resource adapter (src/shared/adapters) as Settings lists it. */
export type AdapterInfo = {
  id: string
  name: string
  /** What it adds, e.g. "PR, issue and CI status" */
  description: string
  /** Link types it recognizes */
  types: string[]
  /** The CLI it fetches live details with; none = links only */
  cli?: CliInfo
  /** Never "live" without a CLI */
  mode: AdapterMode
  /** Live adapters only */
  status?: AdapterStatus
}

export type SearchResult = { hits: SearchHit[]; status: IndexStatus }

/** Messages from the indexer utility process to main. */
export type IndexerMessage =
  | { type: "ready" }
  | { type: "status"; status: IndexStatus }
  /** Resources changed in these sessions; null = possibly all of them (re-extraction) */
  | { type: "resources"; sessionIDs: string[] | null }

export type Shortcut = CommandID

/**
 * The one in-app notification: a toast at the top of the main area (see README → Notifications).
 * Raise it from main with `toast()`; buttons call back into main by toast id.
 */
export type Toast = {
  id: string
  icon: "archive" | "trash" | "alert"
  message: string
  /** Show an Undo button */
  undo: boolean
  /** Show a View button that opens this session */
  viewSessionID?: string
  /** Label of a primary button that runs the action registered with the toast */
  action?: string
  /** How long it stays up, in ms; null = until dismissed (or main dismisses it) */
  duration: number | null
}

export type McpStatus = "connected" | "pending" | "disabled" | "failed" | "needs_auth"

export type McpServerItem = {
  name: string
  status: McpStatus
  /** Set for failed / needs_auth */
  error?: string
}

export type CtrlApi = {
  getState(): Promise<AppState>
  dismissError(): Promise<void>
  onState(cb: (state: AppState) => void): () => void
  onRenameSpace(cb: (spaceID: string) => void): () => void
  onRenameSession(cb: (sessionID: string) => void): () => void
  onShortcut(cb: (name: Shortcut) => void): () => void
  onToast(cb: (toast: Toast) => void): () => void
  /** A toast was handled elsewhere (⌘Z); undefined = whichever is showing */
  onToastDismiss(cb: (toastID?: string) => void): () => void
  undo(toastID: string): Promise<void>
  /** Runs the action behind a toast's primary button */
  toastAction(toastID: string): Promise<void>
  /** Starts a new session with a prompt to fix this MCP server, ready to send */
  fixMcp(name: string): Promise<void>
  reconnectMcp(name: string): Promise<void>
  /** While on, key presses are reported to onRecordedKey instead of running shortcuts */
  recordShortcut(on: boolean): Promise<void>
  onRecordedKey(cb: (accel: string) => void): () => void
  newSessionHere(): Promise<void>
  /** Opens an http(s)/mailto link in the default browser */
  openExternal(url: string): Promise<void>
  /** Absolute path of a file dropped from Finder ("" if it has none). */
  pathForFile(file: File): string
  /** wrapped-links: full URL for a link cut at the row's end */
  resolveLink(url: string, next: string): Promise<string>
  prefetchLinks(): Promise<void>
  archiveCurrent(): Promise<void>
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
  /** Plays a sound choice (system sound name or file path) as a preview */
  playSound(choice: string): Promise<void>
  /** Picks an audio file for this event and saves it; resolves to its path, or null if canceled */
  pickSoundFile(event: SoundEvent): Promise<string | null>
  toggleSpace(id: string): Promise<void>
  showSpaceMenu(id: string): Promise<void>
  showSessionMenu(sessionID: string): Promise<void>
  moveSession(sessionID: string, spaceID: string | null): Promise<void>
  newSession(spaceID: string | null): Promise<void>
  openSession(sessionID: string): Promise<void>
  /** Full-text search over session messages */
  search(query: string): Promise<SearchResult>
  /** Resources mentioned in these sessions, most recently mentioned first */
  listResources(sessionIDs: string[]): Promise<ResourceItem[]>
  /** Resources changed in these sessions; null = possibly all */
  onResourcesChanged(cb: (sessionIDs: string[] | null) => void): () => void
  /** Keep live details of these sessions' resources fresh while shown; [] when the panel is hidden */
  watchResources(sessionIDs: string[]): void
  onResourceMeta(cb: (metas: Record<string, ResourceMeta>) => void): () => void
  /** Re-checks the adapter's CLI (installed, logged in) and resumes fetching */
  retryAdapter(id: string): Promise<void>
  /** Checks every live adapter's CLI, e.g. when Settings opens */
  checkAdapters(): Promise<void>
  ptyStart(cols: number, rows: number): void
  ptyWrite(data: string): void
  ptyResize(cols: number, rows: number): void
  onPtyData(cb: (data: string) => void): () => void
  onPtyReset(cb: () => void): () => void
}
