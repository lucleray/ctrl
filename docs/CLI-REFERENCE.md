# ctrl CLI reference

> Generated from `src/shared/cli/commands.ts` by `npm run cli-docs`. Don't edit by hand.
> Principles and conventions: [CLI.md](CLI.md).

## Commands

- **help**: [`help`](#help)
- **docs**: [`docs`](#docs)
- **app**: [`app status`](#app-status) · [`app launch`](#app-launch) · [`app update check`](#app-update-check) · [`app update install`](#app-update-install)
- **session**: [`session list`](#session-list) · [`session get`](#session-get) · [`session new`](#session-new) · [`session focus`](#session-focus) · [`session rename`](#session-rename) · [`session move`](#session-move) · [`session archive`](#session-archive) · [`session unarchive`](#session-unarchive) · [`session send`](#session-send) · [`session wait`](#session-wait) · [`session ref`](#session-ref) · [`session reference`](#session-reference) · [`session read`](#session-read) · [`session stop`](#session-stop)
- **space**: [`space list`](#space-list) · [`space get`](#space-get) · [`space create`](#space-create) · [`space rename`](#space-rename) · [`space set`](#space-set) · [`space move`](#space-move) · [`space fold`](#space-fold) · [`space unfold`](#space-unfold) · [`space archive-all`](#space-archive-all) · [`space delete`](#space-delete)
- **settings**: [`settings list`](#settings-list) · [`settings get`](#settings-get) · [`settings set`](#settings-set) · [`settings reset`](#settings-reset)
- **ui**: [`ui get`](#ui-get) · [`ui home`](#ui-home) · [`ui window`](#ui-window) · [`ui resources`](#ui-resources) · [`ui sidebar`](#ui-sidebar) · [`ui section`](#ui-section) · [`ui settings`](#ui-settings) · [`ui palette`](#ui-palette) · [`ui toast`](#ui-toast)
- **search**: [`search`](#search)
- **resources**: [`resources list`](#resources-list) · [`resources refresh`](#resources-refresh) · [`resources archive`](#resources-archive) · [`resources unarchive`](#resources-unarchive)
- **models**: [`models list`](#models-list)
- **mcp**: [`mcp list`](#mcp-list) · [`mcp reconnect`](#mcp-reconnect)
- **tools**: [`tools list`](#tools-list) · [`tools check`](#tools-check) · [`tools scan`](#tools-scan) · [`tools add`](#tools-add) · [`tools remove`](#tools-remove)
- **skill**: [`skill status`](#skill-status) · [`skill install`](#skill-install) · [`skill list`](#skill-list) · [`skill scan`](#skill-scan) · [`skill uninstall`](#skill-uninstall)
- **worktree**: [`worktree up`](#worktree-up) · [`worktree setup`](#worktree-setup) · [`worktree down`](#worktree-down) · [`worktree list`](#worktree-list) · [`worktree config`](#worktree-config) · [`worktree prewarm`](#worktree-prewarm) · [`worktree cleanup`](#worktree-cleanup) · [`worktree update`](#worktree-update)
- **events**: [`events`](#events)

Aliases: `status` = `app status` · `focus` = `session focus` · `ref` = `session ref` · `ls` = `session list`

Global flags:

| Flag | Meaning |
|---|---|
| `--pretty / --no-pretty` | Indent the JSON (same content) |
| `--fields <fields>` | Comma-separated fields to keep in each object (`items` too), e.g. id,title |
| `--timeout <n>` | ms to wait for the app (`session wait` has its own) · default: 15000 |

### help

Usage for every command, or one noun / command

```text
ctrl help [<noun> [<verb>]] [--json]
```

| Argument | Meaning |
|---|---|
| `[<noun> [<verb>]]` | Limit to this noun or command |
| `--json / --no-json` | Machine-readable command tree (the contract agents should use) |

**Returns:** `text, or with --json {version, commands:[CommandSpec], aliases, objects, errors, settings}`

```bash
ctrl help --json
ctrl help session new
```

### docs

The full CLI reference (Markdown) for the installed version

```text
ctrl docs
```

**Returns:** `Markdown on stdout`

### app status

ctrl's version, harnesses, skill, updates and window

```text
ctrl app status
```

**Returns:** `{version, socket, opencode, fx, skill, cliSkill, cli, update, window:{visible,focused}, problem?}`

### app launch

Starts ctrl if it isn't running

```text
ctrl app launch [--wait]
```

- Works without the app. `--wait` returns once the app answers on its socket (up to 30s).

| Argument | Meaning |
|---|---|
| `--wait / --no-wait` | Wait until the app answers · default: true |

**Returns:** `{launched:boolean, running:boolean}`

### app update check

Checks GitHub Releases for a newer ctrl now

```text
ctrl app update check
```

**Returns:** `{state, version?}`

### app update install

Downloads the update; ctrl quits, swaps itself and relaunches *(changes state)*

```text
ctrl app update install
```

**Returns:** `{version}`

### session list

Sessions, newest first

```text
ctrl session list [--space <space>] [--archived] [--all] [--status needs-input|running|failed|unread|idle...] [--harness opencode|fx] [--query <query>] [--directory <directory>] [--parent <parent>] [--limit <n>] [--cursor <cursor>]
```

- Archived sessions are left out unless --archived or --all.

| Argument | Meaning |
|---|---|
| `--space <space>` | Only sessions in this space (id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen)), or `none` for sessions in no space |
| `--archived / --no-archived` | Only archived sessions |
| `--all / --no-all` | Archived sessions too |
| `--status needs-input\|running\|failed\|unread\|idle` | Only these statuses (repeatable) · repeatable |
| `--harness opencode\|fx` | Harness |
| `--query <query>` | Title contains this text (case-insensitive) |
| `--directory <directory>` | Only sessions started in this folder |
| `--parent <parent>` | Only child sessions of this session (direct children; selectors as for <session>) |
| `--limit <n>` | Page size (max 500) · default: 50 |
| `--cursor <cursor>` | `next` from the previous page |

**Returns:** `{items:[Session], next:string|null, total:number}`

```bash
ctrl session list --status needs-input --fields id,title,statusDetail
ctrl session list --space name:reviews
ctrl session list --parent self --fields id,title,status
```

### session get

One session

```text
ctrl session get <session>
```

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |

**Returns:** `Session`

```bash
ctrl session get self
ctrl session get current
```

### session new

Starts a session, like the sidebar's + (space folder, harness, model and instructions apply) *(changes state)*

```text
ctrl session new [--space <space>] [--parent <parent>] [--harness opencode|fx] [--directory <directory>] [--model <model>] [--title <title>] [--prompt <prompt>] [--focus] [--raise]
```

- Created in the background: the screen doesn't change unless --focus.
- Flags override the space's settings for this session only.
- Replies within 12s: if the harness is stuck, a TIMEOUT error says whether the session was created and what to run next.
- Run from a session, it starts as a child of that session by default (`--parent self`), like the sidebar's New child session: in the parent's space, folder and harness unless flags say otherwise. `--parent none` starts a top-level session.

| Argument | Meaning |
|---|---|
| `--space <space>` | Space to start it in (id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen)); omitted = the parent's space, else the defaultSpace setting, else no space |
| `--parent <parent>` | Parent session (selectors as for <session>), or `none`. Default: `self` when run from a session, else none |
| `--harness opencode\|fx` | Harness (default: the parent's when --space is omitted, else the space's) |
| `--directory <directory>` | Folder to start in (default: the parent's folder when --space is omitted, else the space's folder, else the defaultDirectory setting, else ~) |
| `--model <model>` | Model, `<provider>/<model>[#<variant>]` (opencode) or `<model>[#<effort>]` (fx) |
| `--title <title>` | Title (opencode: right away; fx: once fx lets go of it) |
| `--prompt <prompt>` | First message, sent right away. `-` reads stdin (use it for long or multi-line prompts) |
| `--focus / --no-focus` | Put it on screen |
| `--raise / --no-raise` | With --focus: also bring ctrl's window to the front |

**Returns:** `Session`

- **Harness:** fx: fx only reports a new session's id once its process is up; `new` waits for it (within its 12s budget). If it doesn't come, `data` is {pending:true, terminal} and the session shows up in `session list` later.
- **Harness:** fx: --prompt is typed into the fx prompt and submitted; the reply has `status: running` once the turn started. To know it's over, `ctrl session wait <id> --for done`. fx writes a turn to its log only when it ends, so until then `session read` shows it as `Turn N · running`.

```bash
ctrl session new --space name:reviews --title "Review #42" --prompt "Review PR #42"
ctrl session new --space self --title "Follow-up" --prompt - < prompt.md
ctrl session new --focus --raise
ctrl session new --parent none --space name:reviews --title "Unrelated"
```

### session focus

Puts a session on screen *(changes state)*

```text
ctrl session focus <session> [--raise]
```

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |
| `--raise / --no-raise` | Also bring ctrl's window to the front |

**Returns:** `Session`

- **Harness:** fx: starts `fx --resume` if the session has no process yet (about 1s).

### session rename

Renames a session *(changes state)*

```text
ctrl session rename <session> <title>
```

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |
| `<title>` | New title · required |

**Returns:** `Session & {changed, pending?}`

- **Harness:** fx: ctrl keeps the title (fx ≥ 0.0.17 keeps titles in a log only fx writes, so fx's own /resume picker still shows its title). Sessions from fx 0.0.16 and older: `pending:true` while an fx process has the session; the title is written once it quits.

### session move

Files a session in a space or under a parent session, or takes it out (`--space none`, `--parent none`) *(changes state)*

```text
ctrl session move <session> [--space <space>] [--parent <parent>]
```

- Unarchives it, like the UI.
- Pass --space, --parent or both. --parent without --space also moves it into the parent's space; a parent in another space works too (the sidebar shows a link to it instead of nesting).
- A session can't go under itself or one of its own children (CONFLICT).
- Its children (any depth) that were in the same space move with it, listed in `followed`; a child filed in another space stays there.

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |
| `--space <space>` | Target space (id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen)), or `none` |
| `--parent <parent>` | Parent session (selectors as for <session>), or `none` to make it top-level |

**Returns:** `Session & {changed, followed?}`

```bash
ctrl session move ses_x --parent self
ctrl session move ses_x --parent none
ctrl session move ses_x --space name:reviews
```

### session archive

Archives sessions and their sub-sessions (reply has the `undo` command) *(changes state)*

```text
ctrl session archive <session>...
```

- Child sessions (and theirs) are archived too, and listed in `archived`.

| Argument | Meaning |
|---|---|
| `<session>...` | Sessions (selectors as for <session>) · required |

**Returns:** `{archived:[id], changed, undo?}`

### session unarchive

Unarchives sessions *(changes state)*

```text
ctrl session unarchive <session>...
```

| Argument | Meaning |
|---|---|
| `<session>...` | Sessions (selectors as for <session>) · required |

**Returns:** `{unarchived:[id], changed}`

### session send

Sends a message to a session, as if you typed it *(changes state)*

```text
ctrl session send <session> --text <text> [--submit] [--focus]
```

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |
| `--text <text>` | Message. `-` reads stdin (use it for long or multi-line text) · required |
| `--submit / --no-submit` | --no-submit only types it into the session's prompt (see harness notes) · default: true |
| `--focus / --no-focus` | Put the session on screen first |

**Returns:** `{id, submitted:boolean}`

- **Harness:** opencode: sent through the opencode service, works in the background. --no-submit types into the one TUI, so the session must be on screen (pass --focus).
- **Harness:** fx: typed into the session's fx process (started in the background if needed). Fails with CONFLICT when fx has it open in another terminal. Taken: the session turns `running` within a second or two (`ctrl session wait <id> --for running`).

### session wait

Blocks until a session reaches a status

```text
ctrl session wait <session> [--for done|idle|needs-input|running|failed] [--timeout <n>]
```

- `done`: idle, unread, failed or needs-input (the turn is over or needs you).
- Returns right away when the session is already there.
- Keeps waiting through a ctrl restart (an update, say), within the same --timeout. Fails with APP_NOT_RUNNING when ctrl doesn't come back within a minute.

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |
| `--for done\|idle\|needs-input\|running\|failed` | Status to wait for · default: "done" |
| `--timeout <n>` | Give up after this many ms (TIMEOUT) · default: 600000 |

**Returns:** `Session`

- **Harness:** fx: `running` while a turn is in progress, `done` once it ends.
- **Harness:** fx: `needs-input` and `failed` only show for sessions open in ctrl (from fx's OSC 7501 status reports). A session open in another terminal that waits on a permission prompt stays `running`, so pass a --timeout.

```bash
ctrl session wait ses_x --for done --timeout 1800000
```

### session ref

The reference string for a session, to paste into a prompt

```text
ctrl session ref <session> [--for opencode|fx]
```

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |
| `--for opencode\|fx` | Harness that will read it (fx gets no leading @) · default: "opencode" |

**Returns:** `{ref:string, id, title}`

```bash
ctrl ref ses_x
```

### session reference

Puts a reference to <source> in another session's prompt, like dropping it on the terminal *(changes state)*

```text
ctrl session reference <source> [--into <into>] [--text <text>] [--submit] [--focus]
```

| Argument | Meaning |
|---|---|
| `<source>` | Session to reference · required |
| `--into <into>` | Session to reference it in · default: "current" |
| `--text <text>` | Message after the reference. `-` reads stdin |
| `--submit / --no-submit` | Send it instead of leaving it in the prompt |
| `--focus / --no-focus` | Put the target on screen first |

**Returns:** `{into, ref, submitted}`

- **Harness:** opencode target without --submit: typed into the one TUI, so the target must be on screen (pass --focus).
- **Harness:** opencode target with --submit: sent through the service, works in the background.
- **Harness:** fx target: typed into its fx process, in the background if needed.

```bash
ctrl session reference ses_abc --into self --text "continue this" --submit
```

### session read

A digest of a session (turns, final replies, tools, files), to load its context

```text
ctrl session read <session> [--turn <n>]
```

- The same digest the read-session skill prints.

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |
| `--turn <n>` | Everything said in this turn instead |

**Returns:** `{id, digest:string}`

- **Harness:** fx: a turn still in progress shows with what it did so far. fx ≥ 0.0.17 logs each step as it happens; older fx kept the turn in progress in `recovery.json`.

```bash
ctrl session read ses_abc | jq -r .data.digest
```

### session stop

Stops the running turn *(changes state)*

```text
ctrl session stop <session>
```

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |

**Returns:** `{id, stopped:boolean}`

- **Harness:** fx: sends Escape to its fx process; only for sessions open in ctrl.

### space list

Spaces in sidebar order

```text
ctrl space list
```

**Returns:** `{items:[Space]}`

### space get

One space

```text
ctrl space get <space> [--sessions]
```

| Argument | Meaning |
|---|---|
| `<space>` | Space: id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen) · required |
| `--sessions / --no-sessions` | Include its sessions (non-archived) |

**Returns:** `Space & {items?:[Session]}`

### space create

Creates a space (at the top unless --index) *(changes state)*

```text
ctrl space create <name> [--index <n>] [--directory <directory>] [--harness opencode|fx|default] [--model <model>] [--fx-model <fx-model>] [--model-enabled] [--instructions <instructions>] [--ctrl-instructions on|off|default]
```

| Argument | Meaning |
|---|---|
| `<name>` | Name · required |
| `--index <n>` | Position, 0 = top |
| `--directory <directory>` | Folder new sessions start in; "" clears it (back to the defaultDirectory setting, else ~) |
| `--harness opencode\|fx\|default` | Harness for new sessions; `default` follows the app setting |
| `--model <model>` | opencode model for new sessions, `<provider>/<model>[#<variant>]`; "" clears it |
| `--fx-model <fx-model>` | fx model for new sessions, `<model>[#<effort>]`; "" clears it |
| `--model-enabled / --no-model-enabled` | Whether the space's model applies (off: the app default applies) |
| `--instructions <instructions>` | Instructions attached to new opencode sessions; "" clears them. `-` reads stdin |
| `--ctrl-instructions on\|off\|default` | ctrl instruction on this space's opencode sessions; `default` follows the app setting (ctrlInstructions) |

**Returns:** `Space`

### space rename

Renames a space *(changes state)*

```text
ctrl space rename <space> <name>
```

| Argument | Meaning |
|---|---|
| `<space>` | Space: id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen) · required |
| `<name>` | New name · required |

**Returns:** `Space & {changed}`

### space set

Space settings for new sessions started in it *(changes state)*

```text
ctrl space set <space> [--directory <directory>] [--harness opencode|fx|default] [--model <model>] [--fx-model <fx-model>] [--model-enabled] [--instructions <instructions>] [--ctrl-instructions on|off|default]
```

| Argument | Meaning |
|---|---|
| `<space>` | Space: id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen) · required |
| `--directory <directory>` | Folder new sessions start in; "" clears it (back to the defaultDirectory setting, else ~) |
| `--harness opencode\|fx\|default` | Harness for new sessions; `default` follows the app setting |
| `--model <model>` | opencode model for new sessions, `<provider>/<model>[#<variant>]`; "" clears it |
| `--fx-model <fx-model>` | fx model for new sessions, `<model>[#<effort>]`; "" clears it |
| `--model-enabled / --no-model-enabled` | Whether the space's model applies (off: the app default applies) |
| `--instructions <instructions>` | Instructions attached to new opencode sessions; "" clears them. `-` reads stdin |
| `--ctrl-instructions on\|off\|default` | ctrl instruction on this space's opencode sessions; `default` follows the app setting (ctrlInstructions) |

**Returns:** `Space & {changed}`

- **Harness:** Instructions apply to opencode sessions only.

```bash
ctrl space set name:front --directory ~/code/acme-app --harness fx --fx-model "anthropic/claude-x#high"
```

### space move

Moves a space to a position in the sidebar *(changes state)*

```text
ctrl space move <space> --index <n>
```

| Argument | Meaning |
|---|---|
| `<space>` | Space: id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen) · required |
| `--index <n>` | Position, 0 = top · required |

**Returns:** `Space & {changed}`

### space fold

Folds a space in the sidebar *(changes state)*

```text
ctrl space fold <space>
```

| Argument | Meaning |
|---|---|
| `<space>` | Space: id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen) · required |

**Returns:** `Space & {changed}`

### space unfold

Unfolds a space in the sidebar *(changes state)*

```text
ctrl space unfold <space>
```

| Argument | Meaning |
|---|---|
| `<space>` | Space: id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen) · required |

**Returns:** `Space & {changed}`

### space archive-all

Archives every session in a space (reply has the `undo` command) *(changes state)*

```text
ctrl space archive-all <space>
```

| Argument | Meaning |
|---|---|
| `<space>` | Space: id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen) · required |

**Returns:** `{archived:[id], undo?}`

### space delete

Deletes a space; its sessions stay, in no space (reply has the `undo` command) *(changes state)*

```text
ctrl space delete <id>
```

- Exact ids only.

| Argument | Meaning |
|---|---|
| `<id>` | Exact space id · required |

**Returns:** `{id, undo}`

### settings list

Every setting: key, type, allowed values, default and current value

```text
ctrl settings list
```

**Returns:** `{items:[{key, type, values?, default, value, description}]}`

### settings get

One setting

```text
ctrl settings get <key>
```

| Argument | Meaning |
|---|---|
| `<key>` | Setting key · required |

**Returns:** `{key, value}`

### settings set

Changes a setting *(changes state)*

```text
ctrl settings set <key> <value>
```

- The value is read as JSON when it parses (true, 13, null, ["Cmd+N"]), else as a string.

| Argument | Meaning |
|---|---|
| `<key>` | Setting key · required |
| `<value>` | New value · required |

**Returns:** `{key, value, changed}`

```bash
ctrl settings set appearance dark
ctrl settings set defaultModel "openrouter/anthropic/claude-x#high"
```

### settings reset

Puts a setting back to its default *(changes state)*

```text
ctrl settings reset <key>
```

| Argument | Meaning |
|---|---|
| `<key>` | Setting key · required |

**Returns:** `{key, value, changed}`

### ui get

What's on screen: current session, terminal, panels, window

```text
ctrl ui get
```

**Returns:** `{currentSessionID, activeTerminal, sidebarWidth, resources:{open,collapsed,docked,scope,width}, recentsCollapsed, archivedCollapsed, window:{visible,focused}}`

### ui home

Shows opencode's new-session screen, optionally with a prompt typed in (not sent) *(changes state)*

```text
ctrl ui home [--prefill <prefill>]
```

| Argument | Meaning |
|---|---|
| `--prefill <prefill>` | Text to type in. `-` reads stdin |

**Returns:** `{}`

- **Harness:** opencode only (fx has no home screen).

### ui window

Shows, hides or brings ctrl's window to the front *(changes state)*

```text
ctrl ui window show|hide|raise
```

| Argument | Meaning |
|---|---|
| `show\|hide\|raise` | raise = show + focus · required |

**Returns:** `{visible, focused}`

### ui resources

Shows, hides or toggles the resources sidebar *(changes state)*

```text
ctrl ui resources open|close|toggle [--scope session|space]
```

| Argument | Meaning |
|---|---|
| `open\|close\|toggle` | Show it, hide it, or switch · required |
| `--scope session\|space` | Links of the current session or of its whole space (remembered per session) |

**Returns:** `{open, collapsed, docked, scope}`

### ui sidebar

Sets the sidebar width *(changes state)*

```text
ctrl ui sidebar --width <n>
```

| Argument | Meaning |
|---|---|
| `--width <n>` | 200-520 px · required |

**Returns:** `{width}`

### ui section

Folds or unfolds Recents or Archived *(changes state)*

```text
ctrl ui section recents|archived fold|unfold
```

| Argument | Meaning |
|---|---|
| `recents\|archived` | Sidebar section · required |
| `fold\|unfold` | Fold or unfold it · required |

**Returns:** `{section, collapsed}`

### ui settings

Opens or closes the settings page *(changes state)*

```text
ctrl ui settings [open|close]
```

| Argument | Meaning |
|---|---|
| `[open\|close]` | Open or close the page · default: "open" |

**Returns:** `{open}`

### ui palette

Opens the ⌘P search palette, optionally with a query *(changes state)*

```text
ctrl ui palette [--query <query>]
```

| Argument | Meaning |
|---|---|
| `--query <query>` | Text to search for |

**Returns:** `{}`

### ui toast

Shows a toast (ctrl's one in-app notification), e.g. to say an agent is done *(changes state)*

```text
ctrl ui toast <message> [--view <view>]
```

| Argument | Meaning |
|---|---|
| `<message>` | Text · required |
| `--view <view>` | Session the toast's View button opens |

**Returns:** `{id}`

### search

Searches session titles and message text, like ⌘P

```text
ctrl search <query>... [--limit <n>] [--archived]
```

- Matches in snippets are wrapped in « and ». Words match as prefixes.

| Argument | Meaning |
|---|---|
| `<query>...` | Words to search for · required |
| `--limit <n>` | Max hits · default: 20 |
| `--archived / --no-archived` | Include archived sessions |

**Returns:** `{titles:[Session], hits:[{sessionID,title,role,created,snippet}], index:{indexing,done,total}}`

### resources list

Links shared in sessions (PRs, issues, Linear, Slack, Vercel, …) and referenced sessions, most recent first (open and draft PRs before merged, then closed ones)

```text
ctrl resources list [--session <session>...] [--space <space>] [--type <type>...] [--limit <n>] [--cached] [--wait <n>] [--archived]
```

- Live details (`live`, with plain values in `live.fields`) are fetched like the resources panel does: only what's due by each adapter's cache policy (never fetched, mentioned again since, or past its max age; merged PRs never again), only for the returned items, through the service's own CLI (gh, vercel, slack-cli).
- Waits up to --wait ms for those fetches. Items still fetching come back with `pending: true` and their cached details; the next call has them.
- `errors` lists adapters that couldn't fetch (rate limited, CLI not installed or logged in), with `retryAt` or the `hint` that fixes it.
- --cached answers from the cache right away, without fetching. `resources refresh` refetches regardless of the cache.

| Argument | Meaning |
|---|---|
| `--session <session>` | Sessions (repeatable; default `current`) · repeatable |
| `--space <space>` | Every session in this space instead (id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen)) |
| `--type <type>` | Only these link types, e.g. github-pr (repeatable) · repeatable |
| `--limit <n>` | Max items (max 500) · default: 100 |
| `--cached / --no-cached` | Don't fetch: cached live details only, instant |
| `--wait <n>` | Most ms to wait for live details (max 60000; raise --timeout past it) · default: 5000 |
| `--archived / --no-archived` | Include archived resources (they have `archived`) |

**Returns:** `{items:[Resource], errors:[{adapter, state, message, retryAt?, hint?}]}`

```bash
ctrl resources list --space self --type github-pr --fields id,title,live,pending
ctrl resources list --session self --cached
```

### resources refresh

Refetches live details now, ignoring the cache

```text
ctrl resources refresh [<id|url>...] [--session <session>...] [--space <space>] [--type <type>...] [--limit <n>] [--wait <n>]
```

- For when cached details look stale (a PR you know just merged). `resources list` already fetches what's due, so this is rarely needed.
- Pass resource ids (as `resources list` returns them) or URLs, or a scope like `resources list`. Rate-limit pauses still apply: those adapters show up in `errors` with `retryAt`.
- The panel shows the new details too: it shares the cache.

| Argument | Meaning |
|---|---|
| `[<id\|url>...]` | Resources to refetch (default: the scope below) |
| `--session <session>` | Without ids: these sessions' resources (repeatable; default `current`) · repeatable |
| `--space <space>` | Without ids: every session in this space instead (id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen)) |
| `--type <type>` | Only these link types (repeatable) · repeatable |
| `--limit <n>` | Max items (max 500) · default: 100 |
| `--wait <n>` | Most ms to wait (max 60000; raise --timeout past it) · default: 10000 |

**Returns:** `{items:[Resource], errors:[{adapter, state, message, retryAt?, hint?}]}`

```bash
ctrl resources refresh github-pr:vercel/next.js#99932
ctrl resources refresh https://github.com/vercel/next.js/pull/99932
ctrl resources refresh --space self --type github-pr
```

### resources archive

Archives resources until they're mentioned again (reply has the `undo` command) *(changes state)*

```text
ctrl resources archive <id|url>...
```

- Archived resources leave the panel's list for its Archived section, and leave the board and `resources list` (unless --archived). Everywhere, not per space.
- A mention after archiving brings the resource back on its own.

| Argument | Meaning |
|---|---|
| `<id\|url>...` | Resource ids (as `resources list` returns them) or URLs · required |

**Returns:** `{archived:[id], changed, undo?}`

```bash
ctrl resources archive github-pr:acme/app#51
ctrl resources archive https://github.com/acme/app/pull/51
```

### resources unarchive

Unarchives resources *(changes state)*

```text
ctrl resources unarchive <id|url>...
```

| Argument | Meaning |
|---|---|
| `<id\|url>...` | Resource ids or URLs · required |

**Returns:** `{unarchived:[id], changed}`

### models list

Models and variants a harness offers

```text
ctrl models list [--harness opencode|fx] [--directory <directory>] [--query <query>]
```

- `ref` is the value to pass to --model or settings.

| Argument | Meaning |
|---|---|
| `--harness opencode\|fx` | Harness · default: "opencode" |
| `--directory <directory>` | opencode: folder whose config applies |
| `--query <query>` | Name or id contains this text |

**Returns:** `{items:[{ref, providerID, id, name, providerName, variants}]}`

### mcp list

opencode's MCP servers and their status

```text
ctrl mcp list
```

**Returns:** `{items:[{name, status, error?}]}`

### mcp reconnect

Reconnects an MCP server *(changes state)*

```text
ctrl mcp reconnect <name>
```

| Argument | Meaning |
|---|---|
| `<name>` | Server name · required |

**Returns:** `{name}`

### tools list

Watched tools: the MCP servers and CLIs in your tools list, with their state in each harness you use

```text
ctrl tools list
```

- Tell a logged-out CLI (state `broken`, e.g. an expired AWS SSO session) from a real failure: when a command fails, look here before retrying.
- Broken tools also show as a sticky toast with a fix button in the app.

**Returns:** `{items:[Tool]}`

### tools check

Runs CLI checks now and waits for them (MCP ids: checks the server in every harness you use)

```text
ctrl tools check [<id>...]
```

| Argument | Meaning |
|---|---|
| `[<id>...]` | Tool ids (`cli:aws`, or just `aws`); none = every CLI |

**Returns:** `{items:[Tool]}`

```bash
ctrl tools check
ctrl tools check aws-work
```

### tools scan

Detects MCP servers (opencode and fx configs) and CLIs worth watching (AWS SSO sessions, gh, vercel, pup, gcloud) *(changes state)*

```text
ctrl tools scan [--apply] [--skip <skip>...]
```

- Without --apply nothing changes: `watched` says what's in the list already.
- --apply watches everything found except --skip keys. It only adds: what you already watch stays as it is (stop watching one with `ctrl tools remove`).
- The list lives in ~/.config/ctrl/tools.json; the first apply creates it.

| Argument | Meaning |
|---|---|
| `--apply / --no-apply` | Watch what was found |
| `--skip <skip>` | With --apply: keys not to watch (repeatable) · repeatable |

**Returns:** `{items:[{key, kind, name, description, watched}], applied}`

```bash
ctrl tools scan
ctrl tools scan --apply --skip gcloud
```

### tools add

Watches a CLI: ctrl runs its check in the background and offers the fix when it fails *(changes state)*

```text
ctrl tools add --name <name> --check <check> [--fix-command <fix-command>] [--fix-url <fix-url>] [--fix-session] [--fix-prompt <fix-prompt>] [--label <label>] [--every <n>] [--id <id>]
```

- The check runs in /bin/sh with no terminal and must exit 0 while the CLI works.
- Pass exactly one fix: --fix-command (ctrl runs it, e.g. a login that opens the browser), --fix-url (opens a page), or --fix-session (types a fix-it prompt into a new session; --fix-prompt to write your own).
- Saved in ~/.config/ctrl/tools.json; the first check runs right away. Needs a tools list (`tools scan --apply`).

| Argument | Meaning |
|---|---|
| `--name <name>` | Shown in Settings and toasts, e.g. "AWS (work)" · required |
| `--check <check>` | Shell command that exits 0 while the CLI works and is logged in · required |
| `--fix-command <fix-command>` | Fix: run this shell command, then check again |
| `--fix-url <fix-url>` | Fix: open this http(s) page |
| `--fix-session / --no-fix-session` | Fix: start a session with a fix-it prompt |
| `--fix-prompt <fix-prompt>` | Fix: start a session with this prompt (implies --fix-session) |
| `--label <label>` | Fix button label, e.g. "Log in" (default: Run, Open or Fix) |
| `--every <n>` | Minutes between checks (default 10) |
| `--id <id>` | Id to use (default: from the name) |

**Returns:** `{id, item: Tool}`

```bash
ctrl tools add --name "AWS (work)" --check "aws sts get-caller-identity --profile work" --fix-command "aws sso login --profile work" --label "Log in"
ctrl tools add --name "GitHub CLI" --check "gh auth status" --fix-session
```

### tools remove

Stops watching an MCP server or CLI (a scan can find it again) *(changes state)*

```text
ctrl tools remove <id>
```

| Argument | Meaning |
|---|---|
| `<id>` | Tool id (`cli:aws`, `mcp:linear`, or just the name) · required |

**Returns:** `{id, changed}`

### skill status

ctrl's agent skills (read-session, ctrl): installed, outdated, external or missing

```text
ctrl skill status
```

**Returns:** `{items:[{name, state, path?}]}`

### skill install

Installs one of ctrl's agent skills into opencode's global skills folder (fx reads it too) *(changes state)*

```text
ctrl skill install read-session|ctrl
```

| Argument | Meaning |
|---|---|
| `read-session\|ctrl` | Skill · required |

**Returns:** `{name, state, path?}`

### skill list

Every skill on this Mac by name: the folders it's in, and which harness loads it (from the last scan)

```text
ctrl skill list [--partial]
```

- Read only. Each harness reports the global folders it loads skills from: opencode ~/.config/opencode/skills, ~/.claude/skills, ~/.agents/skills; fx ~/.fx/skills and the same three.
- A skill's `harnesses` are the ones that load it. Copies in other agents' folders (Codex, Cursor, installed Claude Code plugins) have no `harnesses`: sessions don't see them.
- ctrl scans a few seconds after launch, when Settings opens and every 6 hours; `ctrl skill scan` scans now.

| Argument | Meaning |
|---|---|
| `--partial / --no-partial` | Only skills some harness doesn't load |

**Returns:** `{scannedAt, home, harnesses:[{harness, folders}], items:[{name, description?, harnesses, copies:[{path, harnesses, link?}]}]}`

```bash
ctrl skill list --partial
```

### skill scan

Scans skill folders now, then answers like `skill list`

```text
ctrl skill scan [--partial]
```

| Argument | Meaning |
|---|---|
| `--partial / --no-partial` | Only skills some harness doesn't load |

**Returns:** `{scannedAt, home, harnesses, items}`

### skill uninstall

Removes ctrl's copy of one of its agent skills *(changes state)*

```text
ctrl skill uninstall read-session|ctrl
```

| Argument | Meaning |
|---|---|
| `read-session\|ctrl` | Skill · required |

**Returns:** `{name, state, path?}`

### worktree up

A ready-to-work git worktree of a repo for this session: checked out at the latest base branch, dependencies installed *(changes state)*

```text
ctrl worktree up <repo> [--session <session>] [--skip-setup] [--timeout <n>]
```

- Instant when the repo's pool has a warm worktree. Otherwise it's built now (checkout + the repo's setup command), which can take minutes: `cold` is true.
- <repo> is the path of a git checkout on this Mac (anywhere inside it works), the name of a repo ctrl already manages, or a GitHub repo (owner/repo or its URL): the checkout ctrl manages with that origin, else ctrl clones it once (gh, else git). A repo seen for the first time is registered on its own: base branch from origin, setup command from its lockfile.
- The worktree is attached to the session (default: the one you run in) and shows in its resources. Each call takes another worktree, so a session can hold several, of one repo or of many: `ctrl worktree list` shows the ones it holds.
- It's on a detached HEAD: create a branch before committing (`git switch -c <branch>`). Work in it with its `path` as working directory; the session itself doesn't move.
- Released when its session is archived or deleted, or with `ctrl worktree down`.
- When the pool is empty it takes over the pool's build closest to done, and while a session waits on a build, no other build of that repo starts.
- A build outlives this call: after a TIMEOUT (90s by default, below most agents' own command limits) or a killed command, run the same command again to keep waiting for the same worktree. One your session never asks for again goes back to the pool 10 minutes after it's ready, unless you changed something in it.

| Argument | Meaning |
|---|---|
| `<repo>` | Path of a git checkout, the name of a repo ctrl manages (`ctrl worktree config`), or owner/repo on GitHub · required |
| `--session <session>` | Session that holds it (selectors as for <session>); default `self` |
| `--skip-setup / --no-skip-setup` | When it has to be built: don't run the repo's setup command, for a checkout in seconds (reading, reviewing, editing); `ctrl worktree setup` installs later |
| `--timeout <n>` | Give up waiting for a build after this many ms (TIMEOUT); the build goes on, run the same command again to keep waiting · default: 90000 |

**Returns:** `Worktree & {cold:boolean, hint?:string}`

```bash
ctrl worktree up ~/code/acme-app
cd "$(ctrl worktree up ~/code/acme-app | jq -r .data.path)" && git switch -c my-feature
ctrl worktree up vercel/next.js
ctrl worktree up ~/code/acme-app --skip-setup
ctrl worktree up acme-app --fields id,path,branch
```

### worktree setup

Runs the repo's setup command (installs dependencies) in a worktree you hold *(changes state)*

```text
ctrl worktree setup [<id|path>] [--timeout <n>]
```

- For a worktree taken with --skip-setup (`setupSkipped`), or whose setup failed (`setupFailed`). Clears those once it succeeds.
- Waits for the command. A run outlives this call: after a TIMEOUT (90s by default) or a killed command, run the same command again to keep waiting for it.
- While it runs, no warm build of that repo starts, so nothing competes with it.

| Argument | Meaning |
|---|---|
| `[<id\|path>]` | Worktree id or path (default: the worktree the current folder is in) |
| `--timeout <n>` | Give up waiting after this many ms (TIMEOUT); the command goes on, run this again to keep waiting · default: 90000 |

**Returns:** `Worktree & {ran:boolean, hint:string}`

```bash
ctrl worktree setup k3x9qd
ctrl worktree setup
```

### worktree down

Gives a worktree back to its repo's pool *(changes state)*

```text
ctrl worktree down [<id|path>] [--force]
```

- Recycling resets it to the base branch, so this refuses (CONFLICT) while it has uncommitted files, commits no remote has, or commits on a detached HEAD: commit and push first, or pass --force to discard (branches stay in the repo, detached commits get a rescue ref under refs/ctrl/rescue/).
- Its folder goes away: don't use the path afterwards.
- Rarely needed: archiving a session releases its worktrees.

| Argument | Meaning |
|---|---|
| `[<id\|path>]` | Worktree id or path (default: the worktree the current folder is in) |
| `--force / --no-force` | Release it even with unsaved work |

**Returns:** `{id, repo, path, released:true, branch:string|null, forced:boolean, rescueRef:string|null}`

```bash
ctrl worktree down
ctrl worktree down k3x9qd
ctrl worktree down ~/.ctrl/worktrees/acme-app-3f9c/k3x9qd --force
```

### worktree list

Worktrees: the ones your session holds, or all of them

```text
ctrl worktree list [--all] [--session <session>] [--repo <repo>] [--status ready|attached|building|released|resetting|removing...] [--limit <n>] [--cursor <cursor>]
```

- Run inside a session: the worktrees it holds (`scope: "session"`). Outside one, or with --all: every worktree, warm ones in the pools included.
- `branch` and `commit` are read from git as you ask.

| Argument | Meaning |
|---|---|
| `--all / --no-all` | Every worktree, not only your session's |
| `--session <session>` | Worktrees this session holds (selectors as for <session>) |
| `--repo <repo>` | Only this repo's (path or name) |
| `--status ready\|attached\|building\|released\|resetting\|removing` | Only these statuses (repeatable) · repeatable |
| `--limit <n>` | Page size (max 500) · default: 50 |
| `--cursor <cursor>` | `next` from the previous page |

**Returns:** `{items:[Worktree], next:string|null, total:number, scope:"session"|"all"}`

```bash
ctrl worktree list --fields id,repo,path,branch
ctrl worktree list --all --status attached
```

### worktree config

Worktree settings: every repo ctrl manages, or one repo (add it, change how its worktrees are made, or forget it) *(changes state)*

```text
ctrl worktree config [<repo>] [--name <name>] [--base <base>] [--setup <setup>] [--warm <warm>] [--max-total <n>] [--forget]
```

- Without <repo>: the worktree folder, the settings (also under `ctrl settings`), the background jobs with what they last did, and every repo with its pool and usage.
- With <repo>: that repo. A new one is added (base branch and setup command detected) and gets a warm worktree right away. Flags change it; --forget removes it.
- Everything in Settings → Worktrees has a command: the folder and the background jobs are settings (`ctrl settings set worktreeRoot <path>`, `worktreePoolAuto`, `worktreeCleanup`, `worktreeUpdateRepos` true|false), and `worktree cleanup --apply` and `worktree update` run the jobs now.
- The pool size (`target`) is sized from the last 7 days of use unless --warm pins it: the smallest pool that would have served 98% of requests instantly, at most 4 (each is a full checkout with its dependencies) and at most the repo's cap (--max-total). One for a repo unused for a week, none after 30 days.

| Argument | Meaning |
|---|---|
| `[<repo>]` | Path of a git checkout, or a managed repo's name |
| `--name <name>` | Short name to use instead of the path; "" clears it |
| `--base <base>` | Branch worktrees start from (default: origin's default branch) |
| `--setup <setup>` | Shell command run in every new worktree, e.g. "pnpm install --frozen-lockfile"; "" for none |
| `--warm <warm>` | Warm pool size: a number, or `auto` to size it from usage |
| `--max-total <n>` | Most worktrees of this repo on disk; warm ones stop being built past it (default 30) |
| `--forget / --no-forget` | Stop managing the repo and remove its idle worktrees (refused while a session holds one) |

**Returns:** `{root, settings, jobs, repos:[WorktreeRepo]}, or with <repo>: WorktreeRepo & {changed}`

```bash
ctrl worktree config
ctrl worktree config ~/code/acme-app
ctrl worktree config ~/code/acme-app --name app --setup "pnpm install --frozen-lockfile"
ctrl worktree config app --warm 3
ctrl worktree config app --warm auto
```

### worktree prewarm

Starts building warm worktrees for a repo now, without waiting for them *(changes state)*

```text
ctrl worktree prewarm <repo> [--count <n>]
```

- Up to the repo's pool size and at least one, or --count. The reply shows the pool as it is right after: `counts.building` are on their way, and `waiting` says why more aren't yet (e.g. queued behind other repos' builds).

| Argument | Meaning |
|---|---|
| `<repo>` | Path of a git checkout, or a managed repo's name · required |
| `--count <n>` | Warm worktrees to have |

**Returns:** `WorktreeRepo`

### worktree cleanup

What the cleanup job would do, or does with --apply *(changes state)*

```text
ctrl worktree cleanup [--apply]
```

- released: worktrees whose session is archived or deleted. dropped: worktrees whose folder is gone. removed: folders in the worktree folder that ctrl doesn't track, older than an hour.
- ctrl runs this itself every hour and after a session is archived (the worktreeCleanup setting), so it's rarely needed.

| Argument | Meaning |
|---|---|
| `--apply / --no-apply` | Do it (default: only list) |

**Returns:** `{released:[{id, path, sessionID, reason}], dropped:[{id, path}], removed:[path], applied:boolean}`

### worktree update

Fetches the repos worktrees come from and fast-forwards your own checkouts, now *(changes state)*

```text
ctrl worktree update
```

- What the hourly job does when the worktreeUpdateRepos setting is on: every repo a worktree was taken from in the last 30 days is fetched, and your checkout of it is fast-forwarded only when it's on its base branch with nothing uncommitted.
- `repos[].result` says what happened to each checkout: Updated to <commit>, Up to date, On <branch>, Has uncommitted changes…

**Returns:** `{summary:string, repos:[{repo, source, result, at}]}`

### events

Streams changes as NDJSON, one event per line, until killed *(streams)*

```text
ctrl events [--type <type>...] [--session <session>...]
```

- Types: session.created, session.updated (title, space, status, archived), session.deleted, focus.changed, spaces.changed, settings.changed, tool.changed (id, state, detail; state null = no longer watched).
- For a single "tell me when it's done", prefer `session wait`.

| Argument | Meaning |
|---|---|
| `--type <type>` | Only these event types (repeatable) · repeatable |
| `--session <session>` | Only events about these sessions (repeatable) · repeatable |

**Returns:** `one JSON object per line: {type, at, sessionID?, session?, changes?, id?, state?, detail?}`

## Objects

### Session

```ts
{
  id: string                 // "ses_…" (opencode) | "fx:…" (fx)
  harness: "opencode" | "fx"
  title: string
  directory: string
  spaceID: string | null     // null = in no space
  archived: number | null    // archived at (ms); null = not archived
  createdByAgent: {agent: string, by: string | null, at: number} | null   // made by an agent with `session new`; by = its own session
  parentID: string | null    // parent session (child sessions); can be in another space, or deleted
  children: string[]         // ids of its direct child sessions, archived ones too
  worktrees: [{id, repo, path}]   // git worktrees it holds (ctrl worktree up)
  status: "needs-input" | "running" | "failed" | "unread" | "idle"
  statusDetail?: string      // e.g. "Waiting for permission: bash"
  updated: number            // ms
  current: boolean           // on screen right now
  live?: boolean             // fx: has a running fx process in ctrl
  elsewhere?: boolean        // fx: open in an fx outside ctrl
}
```

### Tool

```ts
{
  id: string                 // "mcp:<server>" | "cli:<id>"
  kind: "mcp" | "cli"
  name: string
  state: "ok" | "checking" | "pending" | "disabled" | "broken" | "needs-auth" | "missing"   // broken, needs-auth, missing need the user
  detail?: string            // why it's broken: the error, or the check's last line of output
  check?: string             // cli: the check command
  checked?: number           // cli: when the check last finished (ms)
  fix: "command" | "url" | "session"   // what its fix button does (MCP servers: session)
  label: string              // fix button label
  fixing?: boolean           // a fix command is running
  harnesses?: [{harness: "opencode" | "fx", state: Tool["state"] | "not-set-up" | "unused", detail?, label?}]
                             // MCP: per harness; unused = no session of it open, so not checked
  custom?: boolean           // cli: added by hand (scans never touch it)
}
```

### Worktree

```ts
{
  id: string
  repo: string               // repo name
  source: string             // the checkout it's a worktree of
  path: string               // work here: pass it as working directory
  status: "ready" | "attached" | "building" | "released" | "resetting" | "removing"
                             // ready: warm in the pool · attached: a session holds it · released: given back, waiting to be recycled
  sessionID: string | null   // session that holds it
  branch: string | null      // checked out right now; null = detached HEAD
  commit: string | null
  baseBranch: string         // branch it started from
  baseCommit: string | null  // commit of the base branch it was warmed at
  warmedAt: number | null    // when it was last brought up to the base branch (ms)
  attachedAt: number | null
  setupFailed?: true         // the repo's setup command failed in it: run it yourself
  setupSkipped?: true        // taken with --skip-setup: dependencies not installed (ctrl worktree setup)
  settingUp?: true           // ctrl worktree setup is running in it
}
```

### WorktreeRepo

```ts
{
  source: string             // your own checkout: worktrees are created from it
  label: string              // name, else the folder name: `ctrl worktree up <label>`
  name?: string
  baseBranch: string
  setup: string | null       // shell command run in every new worktree
  warm: number | null        // pinned pool size; null = sized from usage
  target: number             // pool size in effect
  auto: boolean
  maxTotal: number
  counts: {ready, attached, building, released, total}
  usage: {taken, instant, buildMs, lastTaken}   // last 7 days: worktrees taken, share that came warm (0-1), median build time
  waiting?: string           // why it's short of warm worktrees with none being built (queued, backoff, cap)
  error?: string             // why the last build failed
  updated?: {at, result}     // what the update job last did to the checkout
}
```

### Space

```ts
{
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
}
```

### Resource

```ts
{
  id: string                 // canonical key, e.g. "github-pr:vercel/next.js#99932"
  type: string               // e.g. "github-pr", "session" for a referenced session, "worktree" for a git worktree it holds
  url: string                // sessions: ctrl://session/<id>
  title: string
  subtitle?: string
  mentions: number
  sessions: number           // how many of the queried sessions mention it
  first: number, last: number
  sharedByYou: boolean       // pasted in a prompt (vs only mentioned by the agent)
  archived?: number          // archived at (ms), until mentioned again; only listed with --archived
  session?: Session | null   // type "session": the referenced session (archived ones too), null once deleted
  live?: {title?, subtitle?, tone?, chips?, details?, fields?, missing?, fetched}   // live details, when its adapter has them
  // live.fields: the same details as plain values (null = unknown):
  //   github-pr      {state: open|closed|merged, draft, ci: success|failure|pending, review: approved|changes_requested|review_required,
  //                   mergeable: mergeable|conflicting|unknown, autoMerge, author, additions, deletions,
  //                   reviewers: pending review requests, comma-separated logins / team slugs}
  //   github-issue   {state: open|closed, stateReason, author}
  //   github-commit  {ci, author}
  //   github-repo    {archived, description}
  //   vercel-deployment {state: ready|error|canceled|building|initializing|queued, target, url, branch, commit, creator}
  //   vercel-project {framework, productionState, productionUrl, productionCommit}
  //   slack-thread   {channel, author, text}      slack-channel {channel}
  //   worktree       {repo, source, path, branch, status, baseCommit}   (a git worktree the session holds, url ctrl://worktree/<id>)
  pending?: true             // still being fetched when --wait ran out; live is the cached version, if any
}
```

## Settings keys

| Key | Type | Meaning |
|---|---|---|
| `appearance` | "system" \| "light" \| "dark" | App light/dark mode |
| `tuiTheme` | string \| null | opencode TUI theme name; null follows opencode's cli.json (choices in `values`) |
| `fontSize` | integer 9-24 | Terminal text size in px |
| `defaultHarness` | "opencode" \| "fx" | Harness new sessions start with; spaces can override |
| `defaultDirectory` | folder path \| null | Folder new sessions start in when their space doesn't set one; null = ~ |
| `defaultSpace` | space id \| name:<name> \| null | Space new chats land in (⌘N, New chat, `session new` with no --space and no parent); null = no space |
| `defaultModelEnabled` | boolean | Off: ctrl passes no model and the harness picks its own |
| `defaultModel` | "<provider>/<model>[#<variant>]" \| {providerID,id,variant?} \| null | opencode model for new sessions, used when defaultModelEnabled |
| `defaultFxModel` | "<model>[#<effort>]" \| {providerID:"fx",id,variant?} \| null | fx model for new sessions, used when defaultModelEnabled |
| `ctrlInstructions` | boolean | Invisible instruction on opencode sessions: tells the agent it runs in ctrl, how to look around with the ctrl CLI and how to take a git worktree; spaces can override |
| `dockBadge` | boolean | Dock badge with the sessions waiting on you |
| `notifications` | boolean | macOS notifications when a background session needs you, finishes or fails |
| `sounds` | boolean | Sounds when a session needs you, fails or finishes |
| `soundsWhenFocused` | boolean | Also play sounds while ctrl is focused |
| `remoteControl` | boolean | Remote control: serve a web page on your Tailscale network to use ctrl from your phone |
| `sessionView` | "terminal" \| "chat" | How opencode sessions show: the embedded TUI (terminal) or a chat view (chat). fx sessions always use their terminal |
| `worktreeRoot` | string \| null | Folder git worktrees are created in (`ctrl worktree up`); null = ~/.ctrl/worktrees. Worktrees that exist stay where they are |
| `worktreePoolAuto` | boolean | Size each repo's warm worktree pool from the last 7 days of use, at most 4; off = one warm worktree per repo (repos with a fixed size keep it) |
| `worktreeCleanup` | boolean | Every hour and after a session is archived: release the worktrees of archived and deleted sessions, remove worktree folders nothing tracks |
| `worktreeUpdateRepos` | boolean | Every hour: fetch the repos worktrees come from and fast-forward your own checkout when it's on its base branch with nothing uncommitted |
| `soundChoices.<event>` | system sound name \| absolute path \| null | Sound per event (needs-input, failed, finished): macOS sound name, absolute file path, or null |
| `shortcuts.<command>` | string[] \| null | Bindings for an app command, e.g. ["Cmd+Shift+N"]; [] disables it, null restores the default |
| `companion` | boolean | ctrl Companion: always-on-top window listing the sessions that mentioned what's on screen (browser tab, Slack thread, Notion page), with a global shortcut for a new session about it |
| `adapterModes.<adapter>` | "off" \| "links" \| "live" | Resource adapter mode: off hides its links, links only, or live details |

## Errors

| Exit | `code` | When |
|---|---|---|
| 1 | `INTERNAL` | A bug or an unexpected failure inside ctrl |
| 2 | `USAGE` | Unknown command or flag, or a bad value (`message` says which, `hint` shows the usage) |
| 3 | `NOT_FOUND` | No session, space, setting, MCP server or tool with that id or name |
| 4 | `AMBIGUOUS` | A selector matched more than one thing (see `candidates`) |
| 4 | `CONFLICT` | Can't be done in the current state, e.g. an fx session open in another terminal |
| 5 | `APP_NOT_RUNNING` | No ctrl app answering on the socket (`hint`: ctrl app launch) |
| 5 | `HARNESS_MISSING` | Needs opencode or fx and it isn't installed (`hint`: the install command) |
| 6 | `UNSUPPORTED_HARNESS` | That harness can't do this (docs/HARNESSES.md) |
| 6 | `NO_SELF` | `self` used outside a session ctrl runs |
| 7 | `TIMEOUT` | --timeout passed before the app answered, or `session wait` ran out |
