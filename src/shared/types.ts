import type { ChatPending, FormAnswer } from "../main/remote"
import type { ChatItem, ChatPage, ChatQueued } from "../main/remote-chat"
import type { CommandID, ShortcutOverrides } from "./shortcuts"
import type { WorktreeJobID, WorktreeRepoConfig, WorktreesView } from "./worktrees"

/** variant: opencode model variant, or fx reasoning effort (`--effort`); unset = the model's default */
export type ModelRef = { providerID: string; id: string; variant?: string }

/**
 * An image or PDF sent with a chat message, as a data: URL. `label` is its placeholder in the message text
 * (`[Image 1]`, `[PDF 1]`, like opencode's TUI), so the agent sees where it goes.
 */
export type ChatAttachment = { uri: string; label?: string }

/** The coding agent behind a session. Sessions of both kinds live side by side, even in one space. */
export type Harness = "opencode" | "fx"

export const HARNESSES: { id: Harness; name: string }[] = [
  { id: "opencode", name: "opencode" },
  { id: "fx", name: "fx" },
]

/** fx session ids are prefixed in ctrl ("fx:KvHksYqL8l0C"); opencode ids ("ses_…") aren't, so older state still matches. */
export const FX_PREFIX = "fx:"

export const harnessOf = (sessionID: string): Harness => (sessionID.startsWith(FX_PREFIX) ? "fx" : "opencode")

export type Space = {
  id: string
  name: string
  directory?: string
  collapsed?: boolean
  /** Harness new sessions in this space start with; unset = the app default */
  harness?: Harness
  /** opencode model new sessions in this space start with (when modelEnabled isn't false) */
  model?: ModelRef
  /** fx model, same rules */
  fxModel?: ModelRef
  /** Off: the space doesn't set a model and the app default applies. Unset = on, for older state. */
  modelEnabled?: boolean
  /** Extra instructions attached to every new opencode session in this space (fx has no way to take them) */
  instructions?: string
  /** ctrl instruction (CTRL_INSTRUCTIONS) on this space's opencode sessions; unset = the app setting */
  ctrlInstructions?: boolean
}

export type ModelOption = ModelRef & {
  name: string
  /** Provider display name, e.g. "Vercel AI Gateway" */
  providerName: string
  /** Model maker for gateway-style ids ("anthropic" in "anthropic/claude-…") */
  vendor?: string
  released: number
  /** Selectable variant ids, in opencode's order (fx: reasoning efforts besides auto) */
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
  harness?: Harness | null
  model?: ModelRef | null
  fxModel?: ModelRef | null
  modelEnabled?: boolean
  instructions?: string | null
  ctrlInstructions?: boolean | null
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

/** A session an agent created through the `ctrl` CLI */
export type AgentOrigin = {
  /** e.g. "opencode", "fx", "claude-code" */
  agent: string
  /** Session the agent ran in, when the CLI could tell */
  by: string | null
  at: number
}

export type SessionItem = {
  /** opencode: "ses_…" · fx: "fx:<id>" */
  id: string
  harness: Harness
  title: string
  directory: string
  updated: number
  status: SessionStatus
  /** Human-readable explanation for the tooltip, e.g. "Waiting for permission: bash" */
  statusDetail?: string
  /** fx: open in an fx outside ctrl (another terminal), so it can't be opened here */
  elsewhere?: boolean
  /** Work still going on in the background. Unset when nothing runs, or the harness can't tell (src/main/harness.ts) */
  activity?: SessionActivity
}

/** Shells and subagents a session (or any of its subagents) still has running. Counts are > 0 when set. */
export type SessionActivity = { shells: number; subagents: number }

/** One of the shells and subagents SessionActivity counts. title: the shell's command, the subagent's title */
export type RunningWork = { id: string; kind: "shell" | "subagent"; title: string; started: number }

/**
 * One terminal on the right. "opencode" is the single embedded opencode TUI, switched between
 * sessions in place. fx has no way to do that, so each open fx session gets its own process.
 */
export type TermInfo = { id: string; harness: Harness; sessionID: string | null; exited?: number }

export type UiState = {
  recentsCollapsed: boolean
  archivedCollapsed: boolean
  sidebarWidth: number
  /** Right-hand resources panel */
  resourcesOpen: boolean
  resourcesWidth: number
  /** Resources of the current session, or of every session in its space */
  resourcesScope: "session" | "space"
  /** Resources panel folded to its header, so it stops covering the terminal */
  resourcesCollapsed: boolean
  /** Resources panel docked as a column on the right (resizable, the terminal narrows) instead of floating over it */
  resourcesDocked: boolean
  /** The "install the read-session skill" toast was shown at launch once already */
  skillPrompted?: boolean
  /** The "set up agents" toast (skills + ctrl command) was shown once already */
  agentsPrompted?: boolean
  /** Sessions whose children are folded in the sidebar */
  collapsedSessions?: string[]
  /** The welcome screen (pick a harness) was completed; Settings → About can show it again */
  onboarded?: boolean
  /** The "watch your tools" toast was shown once already (users onboarded before tools existed) */
  toolsPrompted?: boolean
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
  /** Harness for new sessions; spaces can override */
  defaultHarness: Harness
  /** Folder new sessions start in when their space doesn't set one; null = ~ */
  defaultDirectory: string | null
  /** Space new chats (⌘N, New chat) land in; null = no space. A deleted space falls back to none. */
  defaultSpace: string | null
  /** opencode model for new sessions (spaces can override), used when defaultModelEnabled */
  defaultModel: ModelRef | null
  /** fx model for new sessions, same rules */
  defaultFxModel: ModelRef | null
  /** Off: ctrl passes no model and the harness's own default applies */
  defaultModelEnabled: boolean
  /** Attach the ctrl instruction (CTRL_INSTRUCTIONS) to opencode sessions; spaces can override */
  ctrlInstructions: boolean
  /** Rebound shortcuts; commands not listed use their defaults */
  shortcuts: ShortcutOverrides
  /** Per resource adapter id; adapters not listed use defaultAdapterMode */
  adapterModes: Record<string, AdapterMode>
  /** ctrl Companion: always-on-top window with the sessions that mentioned what's on screen (src/companion), macOS only */
  companion: boolean
  /** Remote control: a web page on your Tailscale network to use ctrl from your phone (src/main/remote.ts) */
  remoteControl: boolean
  /** How opencode sessions show: the embedded TUI, or a chat view like the phone's (src/renderer/ChatView.tsx) */
  sessionView: SessionView
  /** Folder git worktrees are created in (src/main/worktrees); null = ~/.ctrl/worktrees */
  worktreeRoot: string | null
  /** Size each repo's warm pool from how often its worktrees are taken; off = one warm worktree per repo */
  worktreePoolAuto: boolean
  /** Most warm worktrees a pool sized from usage keeps */
  worktreePoolMax: number
  /** Release the worktrees of archived and deleted sessions, and remove worktree folders nothing tracks */
  worktreeCleanup: boolean
  /** Fetch your own checkouts every hour and fast-forward their base branch when it's safe */
  worktreeUpdateRepos: boolean
}

export type SessionView = "terminal" | "chat"


/**
 * The remote control server. on: listening on a Tailscale address, `urls` open it on the phone (they carry
 * the access token) · local: no Tailscale address, so only this Mac can reach it · error: couldn't listen
 */
export type RemoteStatus =
  | { state: "off" }
  | { state: "on" | "local"; urls: string[]; port: number }
  | { state: "error"; detail: string }

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

/** Installs opencode V2 (https://opencode.ai/v2/docs/) */
export const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/v2/install | bash"
export const OPENCODE_UPGRADE = "opencode upgrade"

/** Whether a usable opencode CLI is installed; ctrl only starts the TUI once it's "ok". */
export type OpencodeCheck =
  | { state: "checking" }
  | {
      state: "ok"
      version: string
      bin: string
      /** The TUI opens clicked links itself (incl. wrapped ones), so ctrl must not open them too */
      opensLinks: boolean
    }
  | { state: "missing"; detail?: string }
  | { state: "outdated"; version: string; min: string; bin: string }

/**
 * The read-session skill, which lets agents read a session dropped onto the terminal.
 * installed: ctrl's copy, current · outdated: ctrl's copy from another ctrl version (refreshed at launch) ·
 * external: a copy ctrl doesn't manage (e.g. a dev symlink), left alone · missing: not installed
 */
export type SkillStatus = { state: "installed" | "outdated" | "external" | "missing"; path?: string }

/**
 * The `ctrl` CLI on PATH: a symlink at `link` (~/.local/bin/ctrl) to the launcher in the app.
 * stale: links to another copy of ctrl (installing relinks it) · other: something else is at `link`, left alone ·
 * shadowedBy: another `ctrl` comes first in PATH · notOnPath: `link`'s folder isn't in PATH
 */
export type CliStatus = {
  state: "installed" | "missing" | "stale" | "other"
  link: string
  target: string
  shadowedBy?: string
  notOnPath?: boolean
}

/** Whether fx is installed. Only needed for fx sessions; ctrl works without it. */
export type FxCheck = { state: "checking" } | { state: "ok"; version: string; bin: string } | { state: "missing" }

export const FX_INSTALL = "curl -fsSL https://fx.sh/setup.sh | bash"

/** ctrl updates from GitHub Releases (src/main/updater.ts). */
export type UpdateStatus =
  | { state: "idle" | "checking" | "up-to-date" }
  | { state: "available" | "downloading"; version: string }
  | { state: "error"; detail: string }

/**
 * Whether the running opencode service still works. A service that outlived its macOS login
 * session keeps serving ctrl, but every command it runs loses DNS, user lookups, TLS and the keychain.
 */
export type OpencodeServer =
  | { state: "checking" | "restarting" }
  | { state: "ok"; version: string; pid: number }
  | { state: "broken"; version: string; pid: number }

export type AppState = {
  /** ctrl's own version */
  version: string
  /** Shown next to the name to tell dev runs apart (CTRL_LABEL, set by `npm run preview`) */
  label?: string
  opencode: OpencodeCheck
  opencodeServer: OpencodeServer
  fx: FxCheck
  skill: SkillStatus
  /** The `ctrl` CLI: its PATH symlink and the ctrl skill that teaches agents about it */
  cli: CliStatus
  cliSkill: SkillStatus
  update: UpdateStatus
  ui: UiState
  settings: Settings
  themes: ThemeInfo
  dark: boolean
  spaces: Space[]
  assignments: Record<string, string>
  archived: Record<string, number>
  /** resource id → archived-at timestamp; see isResourceArchived */
  archivedResources: Record<string, number>
  /** sessionID → the agent that created it */
  createdByAgent: Record<string, AgentOrigin>
  /** sessionID → parent sessionID (child sessions) */
  parents: Record<string, string>
  sessions: SessionItem[]
  currentSessionID: string | null
  bridgeConnected: boolean
  /** Terminals the renderer keeps one xterm for: the opencode TUI and each live fx process */
  terms: TermInfo[]
  /** The terminal on screen; null = nothing open (empty state) */
  activeTermID: string | null
  /** Watched tools: the MCP servers and CLIs in tools.json (before it exists: opencode's MCP servers) */
  tools: ToolItem[]
  /** tools.json exists: you went through the tools scan (onboarding or Settings) */
  toolsSetUp: boolean
  /** Git worktrees agents take with `ctrl worktree up`: repos, pool sizes, usage and background jobs (Settings → Worktrees) */
  worktrees: WorktreesView
  /** Resource adapters (live details for links), in Settings order */
  adapters: AdapterInfo[]
  /** Ongoing connection trouble (opencode service or embedded TUI); clears itself */
  problem?: string
  /** Last failed action; dismissable */
  error?: string
  remote: RemoteStatus
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
  /** Canonical key, e.g. "github-pr:vercel/next.js#99932" */
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
  /** Which of the queried sessions mention it (board only) */
  sessionIDs?: string[]
  /** Live details from its adapter, when that adapter has a live part (src/shared/adapters) */
  meta?: ResourceMeta
}

/** Archived until mentioned again: a mention newer than the archive brings the resource back. */
export const isResourceArchived = (archivedResources: Record<string, number>, item: Pick<ResourceItem, "id" | "last">) =>
  (archivedResources[item.id] ?? 0) >= item.last

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
  /**
   * The same details as plain values, for agents (`ctrl resources list`): e.g. a PR's
   * {state:"open", draft:false, ci:"pending", review:"approved", author:"luc"}. Keys per type in docs/CLI.md.
   */
  fields?: Record<string, string | number | boolean | null>
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
 * The one in-app notification: a toast at the top of the main area (see docs/ARCHITECTURE.md → Notifications).
 * Raise it from main with `toast()`; buttons call back into main by toast id.
 */
export type Toast = {
  id: string
  icon: "archive" | "trash" | "alert" | "download" | "link" | "check" | "terminal"
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

/** What fixes a broken CLI: run a shell command, open a page, or start a session with a fix-it prompt typed in. */
export type ToolFix =
  | { kind: "command"; command: string }
  | { kind: "url"; url: string }
  /** prompt: unset = one ctrl writes from the check and its error */
  | { kind: "session"; prompt?: string }

/** A CLI whose access ctrl watches (Settings → Tools), e.g. an AWS SSO profile that expires. */
export type CliToolConfig = {
  id: string
  /** Detection key, e.g. "aws:sso:vercel"; unset = added by hand, never touched by a scan */
  key?: string
  name: string
  /** Shell command that exits 0 while the CLI works and is logged in */
  check: string
  fix: ToolFix
  /** Fix button label, e.g. "Log in"; unset = per fix kind (Run, Open, Fix) */
  label?: string
  /** Minutes between checks; unset = CLI_TOOL_EVERY */
  every?: number
}

export const CLI_TOOL_EVERY = 10

/** An MCP server in ctrl's list, written into each harness its own way (opencode: mcp.add, fx: fx mcp add). */
export type McpServerConfig =
  | { name: string; type: "remote"; url: string; headers?: Record<string, string> }
  | { name: string; type: "local"; command: string[]; env?: Record<string, string> }

/** ~/.config/ctrl/tools.json: the MCP servers and CLIs you watch. Only what's in it is watched. */
export type ToolsConfig = { version: 1; mcp: McpServerConfig[]; cli: CliToolConfig[] }

/** One thing a scan found. `watched`: already in your list (a scan keeps your edits to it). */
export type DetectedTool = {
  key: string
  kind: "mcp" | "cli"
  name: string
  /** e.g. "opencode, fx" or "aws sts get-caller-identity --profile vercel" */
  description: string
  watched: boolean
}

/**
 * Where a watched tool stands. broken, needs-auth and missing need you (sticky toast + Fix);
 * pending (an MCP server reconnecting) and checking keep whatever toast is up until they settle.
 */
export type ToolState = "ok" | "checking" | "pending" | "disabled" | "broken" | "needs-auth" | "missing"

/**
 * An MCP server in one harness. not-set-up: in your list but not in that harness's config (fix: add it) ·
 * unused: you have no session of that harness open, so ctrl doesn't check it (lazy)
 */
export type ToolHarnessState = ToolState | "not-set-up" | "unused"

export type ToolHarness = {
  harness: Harness
  state: ToolHarnessState
  detail?: string
  /** Fix button for this harness, when it needs one ("Add", "Log in", "Fix"); fixTool(`${tool.id}@${harness}`) */
  label?: string
}

export const TOOL_BROKEN: readonly ToolState[] = ["broken", "needs-auth", "missing"]

/** One watched tool: an MCP server opencode reports, or a CLI check from Settings (src/main/tools). */
export type ToolItem = {
  /** "mcp:<server>" or "cli:<id>" */
  id: string
  kind: "mcp" | "cli"
  name: string
  state: ToolState
  /** Why it's broken (the error, or the check's last line of output) */
  detail?: string
  /** CLIs: the check command, and when it last finished */
  check?: string
  checked?: number
  fix: ToolFix["kind"]
  /** Fix button label */
  label: string
  /** A fix command is running */
  fixing?: boolean
  /** MCP servers: where it stands in each harness ctrl knows. The item's state is the worst of the used ones */
  harnesses?: ToolHarness[]
  /** CLIs added by hand (no detection key) */
  custom?: boolean
  /** CLIs: the whole entry from tools.json (what Edit starts from) */
  config?: CliToolConfig
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
  /**
   * Runs a fix by id: `cli:x`, `mcp:x`, `mcp:x@fx` (that harness), `setup@fx` (add every missing server).
   * Resolves to true when it typed a fix-it prompt into the TUI (so the TUI should come on screen).
   */
  fixTool(id: string): Promise<boolean>
  /** Checks a CLI again, or an MCP server in every harness you use (opencode: reconnects it) */
  checkTool(id: string): Promise<void>
  /** Runs detection: MCP servers in your harnesses' configs, CLIs installed. Nothing changes until applyToolScan */
  scanTools(): Promise<DetectedTool[]>
  /** Watches the checked keys of the last scan and stops watching its unchecked ones (writes tools.json) */
  applyToolScan(checked: string[]): Promise<void>
  /** Adds (new id) or replaces a CLI check */
  saveCliTool(config: CliToolConfig): Promise<void>
  /** Stops watching an MCP server or CLI (a scan can find it again) */
  removeTool(id: string): Promise<void>
  /** Changes a repo's worktree settings (Settings → Worktrees); null clears name / setup, or sizes the pool from usage */
  configureWorktreeRepo(source: string, patch: Partial<Pick<WorktreeRepoConfig, "baseBranch" | "maxTotal">> & { name?: string | null; setup?: string | null; warm?: number | null }): Promise<void>
  /** Stops managing a repo and removes its idle worktrees */
  forgetWorktreeRepo(source: string): Promise<void>
  /** Runs a worktree background job now */
  runWorktreeJob(id: WorktreeJobID): Promise<void>
  /** Settings → Worktrees → Folder */
  pickWorktreeRoot(): Promise<void>
  /** Shows a folder in Finder (a worktree in the resources panel) */
  revealPath(path: string): Promise<void>
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
  /** The CLI opens (true) or closes (false) the settings page */
  /** The CLI opens (true) or closes (false) the settings page; a section id opens it on that section */
  onUiSettings(cb: (open: boolean | string) => void): () => void
  /** The CLI opens the search palette with this query */
  onUiPalette(cb: (query: string) => void): () => void
  updateSpace(id: string, patch: SpacePatch): Promise<void>
  pickSpaceFolder(id: string): Promise<void>
  /** Settings → Sessions → Folder */
  pickDefaultFolder(): Promise<void>
  listModels(harness: Harness, directory?: string): Promise<ModelChoices>
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
  /** Makes it a child of parentID (and moves it into the parent's space); null detaches it */
  setParent(sessionID: string, parentID: string | null): Promise<void>
  /** New session under this one: same space, folder and harness */
  newChildSession(parentID: string): Promise<void>
  openSession(sessionID: string): Promise<void>
  /** Full-text search over session messages */
  search(query: string): Promise<SearchResult>
  /** Resources mentioned in these sessions, most recently mentioned first */
  listResources(sessionIDs: string[]): Promise<ResourceItem[]>
  /** listResources() plus the sessions mentioning each one, for the board */
  listBoard(sessionIDs: string[]): Promise<ResourceItem[]>
  /** Archives resources until they're mentioned again (state.archivedResources), or unarchives them */
  setResourcesArchived(ids: string[], archived: boolean): Promise<void>
  /** Open the board on this space (space ⋯ menu) */
  onBoardOpen(cb: (spaceID: string) => void): () => void
  /** Resources changed in these sessions; null = possibly all */
  onResourcesChanged(cb: (sessionIDs: string[] | null) => void): () => void
  /** Keep live details of these sessions' resources fresh while shown; [] when the panel is hidden */
  watchResources(sessionIDs: string[]): void
  onResourceMeta(cb: (metas: Record<string, ResourceMeta>) => void): () => void
  /** Re-checks the adapter's CLI (installed, logged in) and resumes fetching */
  retryAdapter(id: string): Promise<void>
  /** Checks every live adapter's CLI, e.g. when Settings opens */
  checkAdapters(): Promise<void>
  /** Looks for opencode again (after installing or upgrading it) */
  recheckOpencode(): Promise<void>
  /** Replaces the running opencode service with a fresh one (stops runs in progress) */
  restartOpencode(): Promise<void>
  installSkill(): Promise<void>
  uninstallSkill(): Promise<void>
  /** Puts `ctrl` on PATH (~/.local/bin) and installs the ctrl skill */
  installCli(): Promise<void>
  uninstallCli(): Promise<void>
  /** A session was referenced: suggests installing the skill if it's missing (once per launch) */
  sessionReferenced(): Promise<void>
  checkForUpdates(): Promise<void>
  /** Downloads the latest release, replaces the app and relaunches */
  installUpdate(): Promise<void>
  /** Output the terminal produced so far (bounded), then live data arrives through onPtyData */
  ptyAttach(termID: string): Promise<{ data: string; end: number }>
  ptyWrite(termID: string, data: string): void
  /** Size of the terminal area; every terminal gets it so switching never reflows */
  ptyResize(cols: number, rows: number): void
  /** `end`: characters the terminal has output so far, including `data` */
  onPtyData(cb: (termID: string, data: string, end: number) => void): () => void
  /** The terminal restarted: clear it */
  onPtyReset(cb: (termID: string) => void): () => void
  /** Chat view (Settings → Appearance → Sessions as chat): the newest page of an opencode session, and watch it */
  chatOpen(sessionID: string): Promise<ChatOpened>
  /** Stop watching (the chat view went away) */
  chatClose(): Promise<void>
  chatMore(sessionID: string, cursor: string): Promise<ChatPage>
  /** Steers a running turn, moving a shell or subagent that holds it to the background. Resolves with the message's id (it shows in the inbox until delivered) */
  chatSend(sessionID: string, text: string, attachments: ChatAttachment[]): Promise<string | undefined>
  /** A new opencode session in the default space, opened, with this first message */
  chatNew(text: string, attachments: ChatAttachment[]): Promise<void>
  chatStop(sessionID: string): Promise<void>
  chatReply(sessionID: string, requestID: string, decision: "once" | "always" | "reject"): Promise<void>
  /** Answer a question form (null: dismiss it) */
  chatAnswer(sessionID: string, formID: string, answer: FormAnswer | null): Promise<void>
  /** The model the session's next turn uses (null: opencode has none to offer) */
  chatModel(sessionID: string): Promise<ModelRef | null>
  chatSetModel(sessionID: string, model: ModelRef): Promise<void>
  chatStats(sessionID: string): Promise<ChatStats>
  /** The shells and subagents the session still has running, oldest first (null: its harness can't list them) */
  chatWork(sessionID: string): Promise<RunningWork[] | null>
  /** Kills that shell, or stops that subagent (id: a RunningWork's) */
  chatStopWork(sessionID: string, id: string): Promise<void>
  /** The session's model changed (picked in the TUI, or here) */
  onChatModelChanged(cb: (sessionID: string) => void): () => void
  /** An image attached to a message you sent, as a data: URL */
  chatImage(sessionID: string, messageID: string, index: number): Promise<string | null>
  /** Newer messages of the watched session (replace by id) */
  onChatUpdate(cb: (sessionID: string, items: ChatItem[]) => void): () => void
  onChatPending(cb: (sessionID: string, pending: ChatPending[]) => void): () => void
  /** Messages sent but not handed to the agent yet (they steer at its next step) */
  onChatInbox(cb: (sessionID: string, inbox: ChatQueued[]) => void): () => void
  /** A prompt for the new-session composer (a fix-it prompt, the companion's text), typed in, not sent */
  onChatDraft(cb: (text: string) => void): () => void
}

export type ChatOpened = ChatPage & { pending: ChatPending[]; inbox: ChatQueued[] }

/** Under the chat composer: spend so far (USD) and context used (limit null: unknown) */
export type ChatStats = { cost: number; context: { used: number; limit: number | null } | null }
