/**
 * Every `ctrl` command, in one place. The CLI parses and validates argv against this, `ctrl help`
 * and `ctrl docs` (docs/CLI-REFERENCE.md) are generated from it, and the app looks handlers up by
 * `name`. Adding a command = one entry here + one handler in src/main/cli-handlers.ts.
 */

export type ArgType = "string" | "int" | "bool" | "enum" | "json"

export type ArgSpec = {
  name: string
  type: ArgType
  description: string
  /** enum values */
  values?: readonly string[]
  required?: boolean
  default?: string | number | boolean
  /** Repeatable flag / variadic positional: the value is a list */
  list?: boolean
  /** Positional, in declaration order (a list positional must come last) */
  positional?: boolean
  /** Placeholder in usage lines, e.g. "<session>" */
  placeholder?: string
}

export type CommandSpec = {
  name: string
  summary: string
  details?: string[]
  args: ArgSpec[]
  /** Shape of `data` on success (TypeScript-like, objects are described in `OBJECTS`) */
  returns: string
  examples?: string[]
  /** How opencode and fx differ for this command */
  harness?: string[]
  /** Runs in the CLI, without the app (help, docs, app launch) */
  local?: boolean
  /** Replies with NDJSON lines until the connection closes */
  stream?: boolean
  /** Changes state (visible to the user; an `undo` command in the reply where the UI would offer undo) */
  mutates?: boolean
}

export type AliasSpec = { name: string; target: string }

const session = (description = "Session: id, `self`, `current` or `name:<title>`"): ArgSpec => ({
  name: "session",
  type: "string",
  positional: true,
  required: true,
  placeholder: "<session>",
  description,
})

/** What every space argument accepts (resolveSpace in cli-handlers.ts). */
const SPACES = "id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen)"

const space = (description = `Space: ${SPACES}`): ArgSpec => ({
  name: "space",
  type: "string",
  positional: true,
  required: true,
  placeholder: "<space>",
  description,
})

const limit: ArgSpec = { name: "limit", type: "int", default: 50, description: "Page size (max 500)" }
const cursor: ArgSpec = { name: "cursor", type: "string", description: "`next` from the previous page" }
const harnessArg: ArgSpec = { name: "harness", type: "enum", values: ["opencode", "fx"], description: "Harness" }

const spaceSettingFlags: ArgSpec[] = [
  { name: "directory", type: "string", description: "Folder new sessions start in; \"\" clears it (back to the defaultDirectory setting, else ~)" },
  {
    name: "harness",
    type: "enum",
    values: ["opencode", "fx", "default"],
    description: "Harness for new sessions; `default` follows the app setting",
  },
  {
    name: "model",
    type: "string",
    description: "opencode model for new sessions, `<provider>/<model>[#<variant>]`; \"\" clears it",
  },
  { name: "fx-model", type: "string", description: "fx model for new sessions, `<model>[#<effort>]`; \"\" clears it" },
  {
    name: "model-enabled",
    type: "bool",
    description: "Whether the space's model applies (off: the app default applies)",
  },
  {
    name: "instructions",
    type: "string",
    description: "Instructions attached to new opencode sessions; \"\" clears them. `-` reads stdin",
  },
  {
    name: "ctrl-instructions",
    type: "enum",
    values: ["on", "off", "default"],
    description: "ctrl instruction on this space's opencode sessions; `default` follows the app setting (ctrlInstructions)",
  },
]

export const COMMANDS: CommandSpec[] = [
  // ---------- meta ----------
  {
    name: "help",
    summary: "Usage for every command, or one noun / command",
    args: [
      {
        name: "command",
        type: "string",
        positional: true,
        list: true,
        placeholder: "[<noun> [<verb>]]",
        description: "Limit to this noun or command",
      },
      { name: "json", type: "bool", description: "Machine-readable command tree (the contract agents should use)" },
    ],
    returns: "text, or with --json {version, commands:[CommandSpec], aliases, objects, errors, settings}",
    examples: ["ctrl help --json", "ctrl help session new"],
    local: true,
  },
  {
    name: "docs",
    summary: "The full CLI reference (Markdown) for the installed version",
    args: [],
    returns: "Markdown on stdout",
    local: true,
  },

  // ---------- app ----------
  {
    name: "app status",
    summary: "ctrl's version, harnesses, skill, updates and window",
    args: [],
    returns: "{version, socket, opencode, fx, skill, cliSkill, cli, update, window:{visible,focused}, problem?}",
  },
  {
    name: "app launch",
    summary: "Starts ctrl if it isn't running",
    details: ["Works without the app. `--wait` returns once the app answers on its socket (up to 30s)."],
    args: [{ name: "wait", type: "bool", default: true, description: "Wait until the app answers" }],
    returns: "{launched:boolean, running:boolean}",
    local: true,
  },
  {
    name: "app update check",
    summary: "Checks GitHub Releases for a newer ctrl now",
    args: [],
    returns: "{state, version?}",
  },
  {
    name: "app update install",
    summary: "Downloads the update; ctrl quits, swaps itself and relaunches",
    args: [],
    returns: "{version}",
    mutates: true,
  },

  // ---------- session ----------
  {
    name: "session list",
    summary: "Sessions, newest first",
    details: ["Archived sessions are left out unless --archived or --all."],
    args: [
      {
        name: "space",
        type: "string",
        description: `Only sessions in this space (${SPACES}), or \`none\` for sessions in no space`,
      },
      { name: "archived", type: "bool", description: "Only archived sessions" },
      { name: "all", type: "bool", description: "Archived sessions too" },
      {
        name: "status",
        type: "enum",
        list: true,
        values: ["needs-input", "running", "failed", "unread", "idle"],
        description: "Only these statuses (repeatable)",
      },
      harnessArg,
      { name: "query", type: "string", description: "Title contains this text (case-insensitive)" },
      { name: "directory", type: "string", description: "Only sessions started in this folder" },
      { name: "parent", type: "string", description: "Only child sessions of this session (direct children; selectors as for <session>)" },
      limit,
      cursor,
    ],
    returns: "{items:[Session], next:string|null, total:number}",
    examples: [
      "ctrl session list --status needs-input --fields id,title,statusDetail",
      "ctrl session list --space name:reviews",
      "ctrl session list --parent self --fields id,title,status",
    ],
  },
  {
    name: "session get",
    summary: "One session",
    args: [session()],
    returns: "Session",
    examples: ["ctrl session get self", "ctrl session get current"],
  },
  {
    name: "session new",
    summary: "Starts a session, like the sidebar's + (space folder, harness, model and instructions apply)",
    details: [
      "Created in the background: the screen doesn't change unless --focus.",
      "Flags override the space's settings for this session only.",
      "Replies within 12s: if the harness is stuck, a TIMEOUT error says whether the session was created and what to run next.",
      "Run from a session, it starts as a child of that session by default (`--parent self`), like the sidebar's New child session: in the parent's space, folder and harness unless flags say otherwise. `--parent none` starts a top-level session.",
    ],
    args: [
      {
        name: "space",
        type: "string",
        description: `Space to start it in (${SPACES}); omitted = the parent's space, else no space`,
      },
      {
        name: "parent",
        type: "string",
        description: "Parent session (selectors as for <session>), or `none`. Default: `self` when run from a session, else none",
      },
      { ...harnessArg, description: "Harness (default: the parent's when --space is omitted, else the space's)" },
      {
        name: "directory",
        type: "string",
        description: "Folder to start in (default: the parent's folder when --space is omitted, else the space's folder, else ~)",
      },
      {
        name: "model",
        type: "string",
        description: "Model, `<provider>/<model>[#<variant>]` (opencode) or `<model>[#<effort>]` (fx)",
      },
      { name: "title", type: "string", description: "Title (opencode: right away; fx: once fx lets go of it)" },
      { name: "prompt", type: "string", description: "First message, sent right away. `-` reads stdin (use it for long or multi-line prompts)" },
      { name: "focus", type: "bool", description: "Put it on screen" },
      { name: "raise", type: "bool", description: "With --focus: also bring ctrl's window to the front" },
    ],
    returns: "Session",
    harness: [
      "fx: fx only reports a new session's id once its process is up; `new` waits for it (within its 12s budget). If it doesn't come, `data` is {pending:true, terminal} and the session shows up in `session list` later.",
      "fx: --prompt is typed into the fx prompt and submitted; the reply has `status: running` once the turn started. To know it's over, `ctrl session wait <id> --for done`. fx writes a turn to its log only when it ends, so until then `session read` shows it as `Turn N · running`.",
    ],
    examples: [
      'ctrl session new --space name:reviews --title "Review #42" --prompt "Review PR #42"',
      "ctrl session new --space self --title \"Follow-up\" --prompt - < prompt.md",
      "ctrl session new --focus --raise",
      "ctrl session new --parent none --space name:reviews --title \"Unrelated\"",
    ],
    mutates: true,
  },
  {
    name: "session focus",
    summary: "Puts a session on screen",
    args: [session(), { name: "raise", type: "bool", description: "Also bring ctrl's window to the front" }],
    returns: "Session",
    harness: ["fx: starts `fx resume` if the session has no process yet (about 1s)."],
    mutates: true,
  },
  {
    name: "session rename",
    summary: "Renames a session",
    args: [session(), { name: "title", type: "string", positional: true, required: true, placeholder: "<title>", description: "New title" }],
    returns: "Session & {changed, pending?}",
    harness: ["fx: `pending:true` while an fx process has the session; the title is written once it quits."],
    mutates: true,
  },
  {
    name: "session move",
    summary: "Files a session in a space or under a parent session, or takes it out (`--space none`, `--parent none`)",
    details: [
      "Unarchives it, like the UI.",
      "Pass --space, --parent or both. --parent without --space also moves it into the parent's space; a parent in another space works too (the sidebar shows a link to it instead of nesting).",
      "A session can't go under itself or one of its own children (CONFLICT).",
      "Its children (any depth) that were in the same space move with it, listed in `followed`; a child filed in another space stays there.",
    ],
    args: [
      session(),
      {
        name: "space",
        type: "string",
        description: `Target space (${SPACES}), or \`none\``,
      },
      {
        name: "parent",
        type: "string",
        description: "Parent session (selectors as for <session>), or `none` to make it top-level",
      },
    ],
    returns: "Session & {changed, followed?}",
    examples: ["ctrl session move ses_x --parent self", "ctrl session move ses_x --parent none", "ctrl session move ses_x --space name:reviews"],
    mutates: true,
  },
  {
    name: "session archive",
    summary: "Archives sessions (reply has the `undo` command)",
    args: [{ ...session("Sessions (selectors as for <session>)"), list: true, placeholder: "<session>..." }],
    returns: "{archived:[id], changed, undo?}",
    mutates: true,
  },
  {
    name: "session unarchive",
    summary: "Unarchives sessions",
    args: [{ ...session("Sessions (selectors as for <session>)"), list: true, placeholder: "<session>..." }],
    returns: "{unarchived:[id], changed}",
    mutates: true,
  },
  {
    name: "session send",
    summary: "Sends a message to a session, as if you typed it",
    args: [
      session(),
      { name: "text", type: "string", required: true, description: "Message. `-` reads stdin (use it for long or multi-line text)" },
      {
        name: "submit",
        type: "bool",
        default: true,
        description: "--no-submit only types it into the session's prompt (see harness notes)",
      },
      { name: "focus", type: "bool", description: "Put the session on screen first" },
    ],
    returns: "{id, submitted:boolean}",
    harness: [
      "opencode: sent through the opencode service, works in the background. --no-submit types into the one TUI, so the session must be on screen (pass --focus).",
      "fx: typed into the session's fx process (started in the background if needed). Fails with CONFLICT when fx has it open in another terminal. Taken: the session turns `running` within a second or two (`ctrl session wait <id> --for running`).",
    ],
    mutates: true,
  },
  {
    name: "session wait",
    summary: "Blocks until a session reaches a status",
    details: [
      "`done`: idle, unread, failed or needs-input (the turn is over or needs you).",
      "Returns right away when the session is already there.",
    ],
    args: [
      session(),
      {
        name: "for",
        type: "enum",
        values: ["done", "idle", "needs-input", "running", "failed"],
        default: "done",
        description: "Status to wait for",
      },
      { name: "timeout", type: "int", default: 600000, description: "Give up after this many ms (TIMEOUT)" },
    ],
    returns: "Session",
    harness: [
      "fx: `running` while a turn is in progress, `done` once it ends.",
      "fx: `needs-input` and `failed` only show for sessions open in ctrl, and only with an fx that sends OSC 7501 status reports (fx 0.0.13 doesn't). Without them, a turn stuck on a permission prompt stays `running`, so pass a --timeout.",
    ],
    examples: ["ctrl session wait ses_x --for done --timeout 1800000"],
  },
  {
    name: "session ref",
    summary: "The reference string for a session, to paste into a prompt",
    args: [
      session(),
      {
        name: "for",
        type: "enum",
        values: ["opencode", "fx"],
        default: "opencode",
        description: "Harness that will read it (fx gets no leading @)",
      },
    ],
    returns: "{ref:string, id, title}",
    examples: ["ctrl ref ses_x"],
  },
  {
    name: "session reference",
    summary: "Puts a reference to <source> in another session's prompt, like dropping it on the terminal",
    args: [
      { ...session("Session to reference"), name: "source", placeholder: "<source>" },
      { name: "into", type: "string", default: "current", description: "Session to reference it in" },
      { name: "text", type: "string", description: "Message after the reference. `-` reads stdin" },
      { name: "submit", type: "bool", description: "Send it instead of leaving it in the prompt" },
      { name: "focus", type: "bool", description: "Put the target on screen first" },
    ],
    returns: "{into, ref, submitted}",
    harness: [
      "opencode target without --submit: typed into the one TUI, so the target must be on screen (pass --focus).",
      "opencode target with --submit: sent through the service, works in the background.",
      "fx target: typed into its fx process, in the background if needed.",
    ],
    examples: ['ctrl session reference ses_abc --into self --text "continue this" --submit'],
    mutates: true,
  },
  {
    name: "session read",
    summary: "A digest of a session (turns, final replies, tools, files), to load its context",
    details: ["The same digest the read-session skill prints."],
    args: [session(), { name: "turn", type: "int", description: "Everything said in this turn instead" }],
    returns: "{id, digest:string}",
    harness: ["fx: a turn still in progress shows as `Turn N · running` with what it did so far (fx logs a turn only once it ends)."],
    examples: ["ctrl session read ses_abc | jq -r .data.digest"],
  },
  {
    name: "session stop",
    summary: "Stops the running turn",
    args: [session()],
    returns: "{id, stopped:boolean}",
    harness: ["fx: sends Escape to its fx process; only for sessions open in ctrl."],
    mutates: true,
  },

  // ---------- space ----------
  {
    name: "space list",
    summary: "Spaces in sidebar order",
    args: [],
    returns: "{items:[Space]}",
  },
  {
    name: "space get",
    summary: "One space",
    args: [space(), { name: "sessions", type: "bool", description: "Include its sessions (non-archived)" }],
    returns: "Space & {items?:[Session]}",
  },
  {
    name: "space create",
    summary: "Creates a space (at the top unless --index)",
    args: [
      { name: "name", type: "string", positional: true, required: true, placeholder: "<name>", description: "Name" },
      { name: "index", type: "int", description: "Position, 0 = top" },
      ...spaceSettingFlags,
    ],
    returns: "Space",
    mutates: true,
  },
  {
    name: "space rename",
    summary: "Renames a space",
    args: [space(), { name: "name", type: "string", positional: true, required: true, placeholder: "<name>", description: "New name" }],
    returns: "Space & {changed}",
    mutates: true,
  },
  {
    name: "space set",
    summary: "Space settings for new sessions started in it",
    args: [space(), ...spaceSettingFlags],
    returns: "Space & {changed}",
    harness: ["Instructions apply to opencode sessions only."],
    examples: ['ctrl space set name:front --directory ~/w/vercel/front --harness fx --fx-model "anthropic/claude-x#high"'],
    mutates: true,
  },
  {
    name: "space move",
    summary: "Moves a space to a position in the sidebar",
    args: [space(), { name: "index", type: "int", required: true, description: "Position, 0 = top" }],
    returns: "Space & {changed}",
    mutates: true,
  },
  {
    name: "space fold",
    summary: "Folds a space in the sidebar",
    args: [space()],
    returns: "Space & {changed}",
    mutates: true,
  },
  {
    name: "space unfold",
    summary: "Unfolds a space in the sidebar",
    args: [space()],
    returns: "Space & {changed}",
    mutates: true,
  },
  {
    name: "space archive-all",
    summary: "Archives every session in a space (reply has the `undo` command)",
    args: [space()],
    returns: "{archived:[id], undo?}",
    mutates: true,
  },
  {
    name: "space delete",
    summary: "Deletes a space; its sessions stay, in no space (reply has the `undo` command)",
    details: ["Exact ids only."],
    args: [{ name: "id", type: "string", positional: true, required: true, placeholder: "<id>", description: "Exact space id" }],
    returns: "{id, undo}",
    mutates: true,
  },

  // ---------- settings ----------
  {
    name: "settings list",
    summary: "Every setting: key, type, allowed values, default and current value",
    args: [],
    returns: "{items:[{key, type, values?, default, value, description}]}",
  },
  {
    name: "settings get",
    summary: "One setting",
    args: [{ name: "key", type: "string", positional: true, required: true, placeholder: "<key>", description: "Setting key" }],
    returns: "{key, value}",
  },
  {
    name: "settings set",
    summary: "Changes a setting",
    details: ["The value is read as JSON when it parses (true, 13, null, [\"Cmd+N\"]), else as a string."],
    args: [
      { name: "key", type: "string", positional: true, required: true, placeholder: "<key>", description: "Setting key" },
      { name: "value", type: "string", positional: true, required: true, placeholder: "<value>", description: "New value" },
    ],
    returns: "{key, value, changed}",
    examples: ["ctrl settings set appearance dark", 'ctrl settings set defaultModel "vercel/anthropic/claude-x#high"'],
    mutates: true,
  },
  {
    name: "settings reset",
    summary: "Puts a setting back to its default",
    args: [{ name: "key", type: "string", positional: true, required: true, placeholder: "<key>", description: "Setting key" }],
    returns: "{key, value, changed}",
    mutates: true,
  },

  // ---------- ui ----------
  {
    name: "ui get",
    summary: "What's on screen: current session, terminal, panels, window",
    args: [],
    returns:
      "{currentSessionID, activeTerminal, sidebarWidth, resources:{open,scope,width}, recentsCollapsed, archivedCollapsed, window:{visible,focused}}",
  },
  {
    name: "ui home",
    summary: "Shows opencode's new-session screen, optionally with a prompt typed in (not sent)",
    args: [{ name: "prefill", type: "string", description: "Text to type in. `-` reads stdin" }],
    returns: "{}",
    harness: ["opencode only (fx has no home screen)."],
    mutates: true,
  },
  {
    name: "ui window",
    summary: "Shows, hides or brings ctrl's window to the front",
    args: [
      {
        name: "action",
        type: "enum",
        values: ["show", "hide", "raise"],
        positional: true,
        required: true,
        placeholder: "show|hide|raise",
        description: "raise = show + focus",
      },
    ],
    returns: "{visible, focused}",
    mutates: true,
  },
  {
    name: "ui resources",
    summary: "Opens or closes the resources panel",
    args: [
      { name: "action", type: "enum", values: ["open", "close", "toggle"], positional: true, required: true, placeholder: "open|close|toggle", description: "What to do with the panel" },
      { name: "scope", type: "enum", values: ["session", "space"], description: "Links of the current session or of its whole space" },
    ],
    returns: "{open, scope}",
    mutates: true,
  },
  {
    name: "ui sidebar",
    summary: "Sets the sidebar width",
    args: [{ name: "width", type: "int", required: true, description: "200-520 px" }],
    returns: "{width}",
    mutates: true,
  },
  {
    name: "ui section",
    summary: "Folds or unfolds Recents or Archived",
    args: [
      { name: "section", type: "enum", values: ["recents", "archived"], positional: true, required: true, placeholder: "recents|archived", description: "Sidebar section" },
      { name: "action", type: "enum", values: ["fold", "unfold"], positional: true, required: true, placeholder: "fold|unfold", description: "Fold or unfold it" },
    ],
    returns: "{section, collapsed}",
    mutates: true,
  },
  {
    name: "ui settings",
    summary: "Opens or closes the settings page",
    args: [{ name: "action", type: "enum", values: ["open", "close"], positional: true, default: "open", placeholder: "[open|close]", description: "Open or close the page" }],
    returns: "{open}",
    mutates: true,
  },
  {
    name: "ui palette",
    summary: "Opens the ⌘P search palette, optionally with a query",
    args: [{ name: "query", type: "string", description: "Text to search for" }],
    returns: "{}",
    mutates: true,
  },
  {
    name: "ui toast",
    summary: "Shows a toast (ctrl's one in-app notification), e.g. to say an agent is done",
    args: [
      { name: "message", type: "string", positional: true, required: true, placeholder: "<message>", description: "Text" },
      { name: "view", type: "string", description: "Session the toast's View button opens" },
    ],
    returns: "{id}",
    mutates: true,
  },

  // ---------- search, resources, models ----------
  {
    name: "search",
    summary: "Searches session titles and message text, like ⌘P",
    details: ["Matches in snippets are wrapped in « and ». Words match as prefixes."],
    args: [
      { name: "query", type: "string", positional: true, required: true, list: true, placeholder: "<query>...", description: "Words to search for" },
      { name: "limit", type: "int", default: 20, description: "Max hits" },
      { name: "archived", type: "bool", description: "Include archived sessions" },
    ],
    returns: "{titles:[Session], hits:[{sessionID,title,role,created,snippet}], index:{indexing,done,total}}",
  },
  {
    name: "resources list",
    summary: "Links shared in sessions (PRs, issues, Linear, Slack, Vercel, …) and referenced sessions, most recent first",
    details: [
      "Live details (`live`, with plain values in `live.fields`) are fetched like the resources panel does: only what's due by each adapter's cache policy (never fetched, mentioned again since, or past its max age; merged PRs never again), only for the returned items, through the service's own CLI (gh, vercel, slack-cli).",
      "Waits up to --wait ms for those fetches. Items still fetching come back with `pending: true` and their cached details; the next call has them.",
      "`errors` lists adapters that couldn't fetch (rate limited, CLI not installed or logged in), with `retryAt` or the `hint` that fixes it.",
      "--cached answers from the cache right away, without fetching. `resources refresh` refetches regardless of the cache.",
    ],
    args: [
      { name: "session", type: "string", list: true, description: "Sessions (repeatable; default `current`)" },
      { name: "space", type: "string", description: `Every session in this space instead (${SPACES})` },
      { name: "type", type: "string", list: true, description: "Only these link types, e.g. github-pr (repeatable)" },
      { name: "limit", type: "int", default: 100, description: "Max items (max 500)" },
      { name: "cached", type: "bool", description: "Don't fetch: cached live details only, instant" },
      { name: "wait", type: "int", default: 5000, description: "Most ms to wait for live details (max 60000; raise --timeout past it)" },
    ],
    returns: "{items:[Resource], errors:[{adapter, state, message, retryAt?, hint?}]}",
    examples: [
      "ctrl resources list --space self --type github-pr --fields id,title,live,pending",
      "ctrl resources list --session self --cached",
    ],
  },
  {
    name: "resources refresh",
    summary: "Refetches live details now, ignoring the cache",
    details: [
      "For when cached details look stale (a PR you know just merged). `resources list` already fetches what's due, so this is rarely needed.",
      "Pass resource ids (as `resources list` returns them) or URLs, or a scope like `resources list`. Rate-limit pauses still apply: those adapters show up in `errors` with `retryAt`.",
      "The panel shows the new details too: it shares the cache.",
    ],
    args: [
      { name: "resource", type: "string", positional: true, list: true, placeholder: "[<id|url>...]", description: "Resources to refetch (default: the scope below)" },
      { name: "session", type: "string", list: true, description: "Without ids: these sessions' resources (repeatable; default `current`)" },
      { name: "space", type: "string", description: `Without ids: every session in this space instead (${SPACES})` },
      { name: "type", type: "string", list: true, description: "Only these link types (repeatable)" },
      { name: "limit", type: "int", default: 100, description: "Max items (max 500)" },
      { name: "wait", type: "int", default: 10000, description: "Most ms to wait (max 60000; raise --timeout past it)" },
    ],
    returns: "{items:[Resource], errors:[{adapter, state, message, retryAt?, hint?}]}",
    examples: [
      "ctrl resources refresh github-pr:vercel/next.js#99932",
      "ctrl resources refresh https://github.com/vercel/next.js/pull/99932",
      "ctrl resources refresh --space self --type github-pr",
    ],
  },
  {
    name: "models list",
    summary: "Models and variants a harness offers",
    args: [
      { ...harnessArg, default: "opencode" },
      { name: "directory", type: "string", description: "opencode: folder whose config applies" },
      { name: "query", type: "string", description: "Name or id contains this text" },
    ],
    returns: "{items:[{ref, providerID, id, name, providerName, variants}]}",
    details: ["`ref` is the value to pass to --model or settings."],
  },

  // ---------- mcp, skill ----------
  {
    name: "mcp list",
    summary: "opencode's MCP servers and their status",
    args: [],
    returns: "{items:[{name, status, error?}]}",
  },
  {
    name: "mcp reconnect",
    summary: "Reconnects an MCP server",
    args: [{ name: "name", type: "string", positional: true, required: true, placeholder: "<name>", description: "Server name" }],
    returns: "{name}",
    mutates: true,
  },
  {
    name: "skill status",
    summary: "ctrl's agent skills (read-session, ctrl): installed, outdated, external or missing",
    args: [],
    returns: "{items:[{name, state, path?}]}",
  },
  {
    name: "skill install",
    summary: "Installs one of ctrl's agent skills into opencode's global skills folder (fx reads it too)",
    args: [
      { name: "name", type: "enum", values: ["read-session", "ctrl"], positional: true, required: true, placeholder: "read-session|ctrl", description: "Skill" },
    ],
    returns: "{name, state, path?}",
    mutates: true,
  },
  {
    name: "skill uninstall",
    summary: "Removes ctrl's copy of one of its agent skills",
    args: [
      { name: "name", type: "enum", values: ["read-session", "ctrl"], positional: true, required: true, placeholder: "read-session|ctrl", description: "Skill" },
    ],
    returns: "{name, state, path?}",
    mutates: true,
  },

  // ---------- events ----------
  {
    name: "events",
    summary: "Streams changes as NDJSON, one event per line, until killed",
    details: [
      "Types: session.created, session.updated (title, space, status, archived), session.deleted, focus.changed, spaces.changed, settings.changed.",
      "For a single \"tell me when it's done\", prefer `session wait`.",
    ],
    args: [
      { name: "type", type: "string", list: true, description: "Only these event types (repeatable)" },
      { name: "session", type: "string", list: true, description: "Only events about these sessions (repeatable)" },
    ],
    returns: 'one JSON object per line: {type, at, sessionID?, session?, changes?}',
    stream: true,
  },
]

export const ALIASES: AliasSpec[] = [
  { name: "status", target: "app status" },
  { name: "focus", target: "session focus" },
  { name: "ref", target: "session ref" },
  { name: "ls", target: "session list" },
]

/** Shapes referenced by `returns`. */
export const OBJECTS: Record<string, string> = {
  Session: `{
  id: string                 // "ses_…" (opencode) | "fx:…" (fx)
  harness: "opencode" | "fx"
  title: string
  directory: string
  spaceID: string | null     // null = in no space
  archived: number | null    // archived at (ms); null = not archived
  createdByAgent: {agent: string, by: string | null, at: number} | null   // made by an agent with \`session new\`; by = its own session
  parentID: string | null    // parent session (child sessions); can be in another space, or deleted
  children: string[]         // ids of its direct child sessions, archived ones too
  status: "needs-input" | "running" | "failed" | "unread" | "idle"
  statusDetail?: string      // e.g. "Waiting for permission: bash"
  updated: number            // ms
  current: boolean           // on screen right now
  live?: boolean             // fx: has a running fx process in ctrl
  elsewhere?: boolean        // fx: open in an fx outside ctrl
}`,
  Space: `{
  id: string
  name: string
  index: number              // position in the sidebar, 0 = top
  collapsed: boolean
  directory: string | null   // folder new sessions start in; null = defaultDirectory setting, else ~
  harness: "opencode" | "fx" | null   // null = app default
  model: string | null       // opencode model ref, "<provider>/<model>[#<variant>]"
  fxModel: string | null     // fx model ref, "<model>[#<effort>]"
  modelEnabled: boolean
  instructions: string | null
  ctrlInstructions: boolean | null   // ctrl instruction on its opencode sessions; null = app setting
  sessions: number           // non-archived sessions in it
  status: Session["status"]  // most urgent of its sessions
}`,
  Resource: `{
  id: string                 // canonical key, e.g. "github-pr:vercel/next.js#99932"
  type: string               // e.g. "github-pr", or "session" for a referenced session
  url: string                // sessions: ctrl://session/<id>
  title: string
  subtitle?: string
  mentions: number
  sessions: number           // how many of the queried sessions mention it
  first: number, last: number
  sharedByYou: boolean       // pasted in a prompt (vs only mentioned by the agent)
  session?: Session | null   // type "session": the referenced session (archived ones too), null once deleted
  live?: {title?, subtitle?, tone?, chips?, details?, fields?, missing?, fetched}   // live details, when its adapter has them
  // live.fields: the same details as plain values (null = unknown):
  //   github-pr      {state: open|closed|merged, draft, ci: success|failure|pending, review: approved|changes_requested|review_required,
  //                   mergeable: mergeable|conflicting|unknown, author, additions, deletions}
  //   github-issue   {state: open|closed, stateReason, author}
  //   github-commit  {ci, author}
  //   github-repo    {archived, description}
  //   vercel-deployment {state: ready|error|canceled|building|initializing|queued, target, url, branch, commit, creator}
  //   vercel-project {framework, productionState, productionUrl, productionCommit}
  //   slack-thread   {channel, author, text}      slack-channel {channel}
  pending?: true             // still being fetched when --wait ran out; live is the cached version, if any
}`,
}

export const GLOBAL_FLAGS: ArgSpec[] = [
  { name: "pretty", type: "bool", description: "Indent the JSON (same content)" },
  { name: "fields", type: "string", description: "Comma-separated fields to keep in each object (`items` too), e.g. id,title" },
  { name: "timeout", type: "int", default: 15000, description: "ms to wait for the app (`session wait` has its own)" },
]

export const commandByName = (name: string) => COMMANDS.find((c) => c.name === name)
