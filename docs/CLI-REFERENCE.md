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
- **resources**: [`resources list`](#resources-list) · [`resources refresh`](#resources-refresh)
- **models**: [`models list`](#models-list)
- **mcp**: [`mcp list`](#mcp-list) · [`mcp reconnect`](#mcp-reconnect)
- **skill**: [`skill status`](#skill-status) · [`skill install`](#skill-install) · [`skill uninstall`](#skill-uninstall)
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
| `--space <space>` | Space to start it in (id, `name:<name>`, `self` (the space of the session you run in) or `current` (the space of the session on screen)); omitted = the parent's space, else no space |
| `--parent <parent>` | Parent session (selectors as for <session>), or `none`. Default: `self` when run from a session, else none |
| `--harness opencode\|fx` | Harness (default: the parent's when --space is omitted, else the space's) |
| `--directory <directory>` | Folder to start in (default: the parent's folder when --space is omitted, else the space's folder, else ~) |
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

- **Harness:** fx: starts `fx resume` if the session has no process yet (about 1s).

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

- **Harness:** fx: `pending:true` while an fx process has the session; the title is written once it quits.

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

Archives sessions (reply has the `undo` command) *(changes state)*

```text
ctrl session archive <session>...
```

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

| Argument | Meaning |
|---|---|
| `<session>` | Session: id, `self`, `current` or `name:<title>` · required |
| `--for done\|idle\|needs-input\|running\|failed` | Status to wait for · default: "done" |
| `--timeout <n>` | Give up after this many ms (TIMEOUT) · default: 600000 |

**Returns:** `Session`

- **Harness:** fx: `running` while a turn is in progress, `done` once it ends.
- **Harness:** fx: `needs-input` and `failed` only show for sessions open in ctrl, and only with an fx that sends OSC 7501 status reports (fx 0.0.13 doesn't). Without them, a turn stuck on a permission prompt stays `running`, so pass a --timeout.

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

- **Harness:** fx: a turn still in progress shows as `Turn N · running` with what it did so far (fx logs a turn only once it ends).

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
| `--directory <directory>` | Folder new sessions start in; "" clears it (back to ~) |
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
| `--directory <directory>` | Folder new sessions start in; "" clears it (back to ~) |
| `--harness opencode\|fx\|default` | Harness for new sessions; `default` follows the app setting |
| `--model <model>` | opencode model for new sessions, `<provider>/<model>[#<variant>]`; "" clears it |
| `--fx-model <fx-model>` | fx model for new sessions, `<model>[#<effort>]`; "" clears it |
| `--model-enabled / --no-model-enabled` | Whether the space's model applies (off: the app default applies) |
| `--instructions <instructions>` | Instructions attached to new opencode sessions; "" clears them. `-` reads stdin |
| `--ctrl-instructions on\|off\|default` | ctrl instruction on this space's opencode sessions; `default` follows the app setting (ctrlInstructions) |

**Returns:** `Space & {changed}`

- **Harness:** Instructions apply to opencode sessions only.

```bash
ctrl space set name:front --directory ~/w/vercel/front --harness fx --fx-model "anthropic/claude-x#high"
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
ctrl settings set defaultModel "vercel/anthropic/claude-x#high"
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

**Returns:** `{currentSessionID, activeTerminal, sidebarWidth, resources:{open,scope,width}, recentsCollapsed, archivedCollapsed, window:{visible,focused}}`

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

Opens or closes the resources panel *(changes state)*

```text
ctrl ui resources open|close|toggle [--scope session|space]
```

| Argument | Meaning |
|---|---|
| `open\|close\|toggle` | What to do with the panel · required |
| `--scope session\|space` | Links of the current session or of its whole space |

**Returns:** `{open, scope}`

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

Links shared in sessions (PRs, issues, Linear, Slack, Vercel, …) and referenced sessions, most recent first

```text
ctrl resources list [--session <session>...] [--space <space>] [--type <type>...] [--limit <n>] [--cached] [--wait <n>]
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

### skill uninstall

Removes ctrl's copy of one of its agent skills *(changes state)*

```text
ctrl skill uninstall read-session|ctrl
```

| Argument | Meaning |
|---|---|
| `read-session\|ctrl` | Skill · required |

**Returns:** `{name, state, path?}`

### events

Streams changes as NDJSON, one event per line, until killed *(streams)*

```text
ctrl events [--type <type>...] [--session <session>...]
```

- Types: session.created, session.updated (title, space, status, archived), session.deleted, focus.changed, spaces.changed, settings.changed.
- For a single "tell me when it's done", prefer `session wait`.

| Argument | Meaning |
|---|---|
| `--type <type>` | Only these event types (repeatable) · repeatable |
| `--session <session>` | Only events about these sessions (repeatable) · repeatable |

**Returns:** `one JSON object per line: {type, at, sessionID?, session?, changes?}`

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
  status: "needs-input" | "running" | "failed" | "unread" | "idle"
  statusDetail?: string      // e.g. "Waiting for permission: bash"
  updated: number            // ms
  current: boolean           // on screen right now
  live?: boolean             // fx: has a running fx process in ctrl
  elsewhere?: boolean        // fx: open in an fx outside ctrl
}
```

### Space

```ts
{
  id: string
  name: string
  index: number              // position in the sidebar, 0 = top
  collapsed: boolean
  directory: string | null   // folder new sessions start in; null = ~
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
}
```

## Settings keys

| Key | Type | Meaning |
|---|---|---|
| `appearance` | "system" \| "light" \| "dark" | App light/dark mode |
| `tuiTheme` | string \| null | opencode TUI theme name; null follows opencode's cli.json (choices in `values`) |
| `fontSize` | integer 9-24 | Terminal text size in px |
| `defaultHarness` | "opencode" \| "fx" | Harness new sessions start with; spaces can override |
| `defaultModelEnabled` | boolean | Off: ctrl passes no model and the harness picks its own |
| `defaultModel` | "<provider>/<model>[#<variant>]" \| {providerID,id,variant?} \| null | opencode model for new sessions, used when defaultModelEnabled |
| `defaultFxModel` | "<model>[#<effort>]" \| {providerID:"fx",id,variant?} \| null | fx model for new sessions, used when defaultModelEnabled |
| `ctrlInstructions` | boolean | Invisible instruction on opencode sessions: tells the agent it runs in ctrl and how to look around with the ctrl CLI; spaces can override |
| `dockBadge` | boolean | Dock badge with the sessions waiting on you |
| `notifications` | boolean | macOS notifications when a background session needs you, finishes or fails |
| `sounds` | boolean | Sounds when a session needs you, fails or finishes |
| `soundsWhenFocused` | boolean | Also play sounds while ctrl is focused |
| `soundChoices.<event>` | system sound name \| absolute path \| null | Sound per event (needs-input, failed, finished): macOS sound name, absolute file path, or null |
| `shortcuts.<command>` | string[] \| null | Bindings for an app command, e.g. ["Cmd+Shift+N"]; [] disables it, null restores the default |
| `companion` | boolean | ctrl Companion: always-on-top window listing the sessions that mentioned what's on screen (browser tab, Slack thread, Notion page), with a global shortcut for a new session about it |
| `adapterModes.<adapter>` | "off" \| "links" \| "live" | Resource adapter mode: off hides its links, links only, or live details |

## Errors

| Exit | `code` | When |
|---|---|---|
| 1 | `INTERNAL` | A bug or an unexpected failure inside ctrl |
| 2 | `USAGE` | Unknown command or flag, or a bad value (`message` says which, `hint` shows the usage) |
| 3 | `NOT_FOUND` | No session, space, setting or MCP server with that id or name |
| 4 | `AMBIGUOUS` | A selector matched more than one thing (see `candidates`) |
| 4 | `CONFLICT` | Can't be done in the current state, e.g. an fx session open in another terminal |
| 5 | `APP_NOT_RUNNING` | No ctrl app answering on the socket (`hint`: ctrl app launch) |
| 5 | `HARNESS_MISSING` | Needs opencode or fx and it isn't installed (`hint`: the install command) |
| 6 | `UNSUPPORTED_HARNESS` | That harness can't do this (docs/HARNESSES.md) |
| 6 | `NO_SELF` | `self` used outside a session ctrl runs |
| 7 | `TIMEOUT` | --timeout passed before the app answered, or `session wait` ran out |
