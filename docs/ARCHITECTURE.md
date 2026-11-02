# Architecture

How ctrl works inside. For what it does, see [FEATURES.md](FEATURES.md); for running and releasing it,
[DEVELOPMENT.md](DEVELOPMENT.md).

## Principles

- **Fast.** Everything you touch responds instantly. Heavy work (fetching, parsing, indexing) stays off the main
  process, which relays every keystroke and byte of TUI output. Trade completeness for speed when needed, and
  write the compromise down next to the code.
- **Scalable.** ctrl must not get slower as sessions pile up. Work is proportional to what changed, not to how
  much history exists, and queries touch a bounded number of rows. When adding a feature, ask how it behaves with
  10× the sessions.

## Overview

```text
┌─ Electron main ─────────────────────────────────────────┐
│ @opencode/client ──► background service (sessions, SSE) │
│ state.json       ──► spaces + session→space assignments │
│ node-pty         ──► `opencode` TUI (one process)       │
│ ws://127.0.0.1:N ◄─► bridge plugin inside the TUI       │
│ ~/.fx/sessions   ──► fx sessions (scan + fs watcher)    │
│ node-pty         ──► `fx resume` (one per open session) │
└─────────────────────────────────────────────────────────┘
        ▲ IPC                                  │ navigate / route
┌─ renderer ─────────────┐               ┌─ bridge/tui.ts ──────┐
│ React sidebar + xterms │               │ router.navigate(...) │
└────────────────────────┘               └──────────────────────┘
```

Two harnesses, opencode and fx, share everything ctrl owns (spaces, archive, search, resources,
notifications) and differ only in where sessions come from and how their terminals run. What each
supports: [HARNESSES.md](HARNESSES.md).

- **Session ids:** opencode's as they are (`ses_…`), fx's prefixed (`fx:<id>`, `harnessOf()` in
  `src/shared/types.ts`). Older `state.json` files keep working unchanged.
- **One session list:** `src/main/opencode.ts` and `src/main/fx.ts` each keep theirs; main merges them by
  update time, and attention, the dock badge and the renderer only see the merged list.
- **Terminals:** the renderer keeps one xterm per terminal in `AppState.terms`, stacked, with only
  `activeTermID` visible (`src/renderer/TerminalStack.tsx`). The opencode TUI is the terminal `opencode`;
  each open fx session is `fx_N`. Output goes through one `pty:data` channel tagged with the terminal id.

- Switching sessions sends `{type:"navigate"}` to the bridge, so the TUI swaps in place (no restart).
- The bridge reports route changes back, so the sidebar highlight follows navigation done inside the TUI.
- The bridge is injected only into the embedded TUI via `OPENCODE_CLI_CONFIG_CONTENT` (tabs and the TUI's
  own sidebar are turned off there too).
- The sidebar's session list (`src/main/opencode.ts`) does one full sync on launch and whenever the event stream
  reconnects, of the sessions updated in the last 30 days (300 per page). Older ones load once something can show
  or name them: the Archived section opening, a palette search, any CLI command. Pending permissions and questions
  are only asked for in the folders of running sessions: asking a folder makes opencode load it (config, plugins,
  MCP connections), and every worktree that ever had a session would add one. After that, events patch it in memory (renames, moves, deletes, views, permissions, questions), or
  re-read only the session they're about (created, run started/ended), so an update costs the same with 50 or
  5,000 sessions.
- Child sessions are ctrl's own too (`parents` in `state.json`, child → parent), not opencode's `parentID`,
  which opencode uses for subagents and hides from session lists. The sidebar builds each space's tree from it
  when the list changes, proportional to that space's sessions.
- Spaces live in `~/Library/Application Support/ctrl/state.json`. Sessions without a space still show under **Recents**, which lists every non-archived session (foldable, 10 at a time).

## fx

fx has no server and no plugin API, so ctrl works from its files and its terminal output.

```text
~/.fx/sessions/<id>/ ── session.json (title, folder) ┐
                     ── events.jsonl (last line)     ├─► src/main/fx.ts ─► sidebar
                     ── recovery.json (turn running) │
                     ── owner.live (pid)             ┘
fx process in a pty ── OSC 7501 status reports ─────────► running / needs you / failed
```

- **List:** one scan on launch, then a recursive fs watcher re-reads just the session folder that changed.
  Sessions fx creates but never uses stay hidden.
- **Polling live sessions:** fx keeps `events.jsonl` open while it runs, and macOS only reports those
  appends once the file is closed. So sessions with a live fx process (`owner.live`) are also checked on a
  timer, one stat each (2s in main, 5s in the indexer), and re-read when their log grew.
- **Status:** OSC 7501 (Program Status Protocol) reports from the processes ctrl runs give running, needs you
  and failed (fx 0.0.13 sends none). Otherwise `recovery.json` says a turn is in progress: fx writes a turn
  to `events.jsonl` only once it ends, and keeps the one in flight in `recovery.json` until then (the poller
  also notices that file appearing or going away). Read state is
  ctrl's own (`viewed` in `state.json`); turns that ended before ctrl first saw fx count as read.
- **Processes:** `src/main/fx-terminals.ts` runs one `fx resume --id <id>` per open session, up to 12, and
  closes the least recently used idle ones past that. `owner.live` tells which session a process has, so
  `/new` and `/resume` inside fx move the sidebar highlight (`claim()`), and a new session joins the space it
  was started from once fx reports its id.
- **Quit and relaunch:** fx processes die with ctrl. The open ones are saved (`open` in `state.json`) and
  resumed at launch, one at a time in the background.
- **Writes:** renames go into `session.json` (kept `0600`, fx refuses files others can read) only once no
  fx process has the session, since fx rewrites it while it runs. Deletes move the folder to the Trash.

## Search

⌘P matches session titles instantly (in memory) and message text through a local full-text index.

```text
opencode ──events──► indexer (utility process) ──writes──► search.db (SQLite FTS5, WAL)
   ▲   └─ messages newer than each session's watermark            │
   └────────────── session.list on launch (catch-up)              ▼
fx ──fs watcher──► (same indexer)   main: read-only connection ◄── ⌘P query (~1ms)
   └─ events.jsonl from each session's byte offset
```

- **fx:** fx only appends to `events.jsonl`, so each session keeps a byte offset (`sessions.offset`) and a
  pass reads only the new lines. A log that shrank is reindexed from scratch.

- **Indexer** (`src/indexer/indexer.ts`) runs in an Electron utility process with its own opencode client and event
  stream. On launch it lists root sessions and indexes the ones whose `updated` moved since their last pass. Live,
  a delivered prompt or a finished turn re-indexes just that session.
- **Incremental:** each session keeps a time watermark. A pass reads messages newest first and stops at the
  watermark, so an up-to-date session costs one small request. Replies still streaming hold the watermark back and
  get picked up on the next pass. Reverts and edited content rebuild that session.
- **Bounded queries** (`src/main/search-db.ts`): rowids follow message time, and a query ranks only the newest 2000
  matching messages (FTS5 stops early in rowid order). On 300k synthetic messages that's ~5ms for a word in every
  message, versus ~200ms when ranking all matches.
- **Compromises:** indexes your prompts and the assistant's text only (no tool calls, reasoning, or subagent
  sessions). Messages are cut at 16 KB. A word matching more than 2000 messages only reaches the newest ones.
  Words match as prefixes (`xter` finds `xterm`), not in the middle of words.
- The index lives in `search.db` next to `state.json`. Delete it (or bump `INDEX_VERSION`) to rebuild from scratch.

## Resources

The right panel (⇧⌘R, or the panel button next to search) lists the links shared in the current session, or in
every session of its space: PRs, issues, commits, repos, Linear issues, Notion pages, Slack threads and channels,
Vercel deployments and projects.

```text
indexed message text ──extractResources()──► resources          (one row per canonical resource)
                                             resource_mentions  (resource × message, with session + time)
panel ◄── main: GROUP BY resource over the scope's mentions (~3ms)
```

- **Adapters** live in `src/shared/adapters/`, one file per service, listed in `adapters/index.ts`. Each declares
  its link types: parse a URL into a canonical identity, a canonical URL and a few fields (`/pull/1/changes`,
  `/pull/1` and `/pull/1#x` are one PR), plus an icon and an offline title. Order matters: the first type that
  matches wins (PR before repo). URLs no type recognizes are ignored.
- **Live details are optional:** an adapter with a `live` part fetches them through its service's CLI (`gh`,
  `vercel`, `slack-cli`), so ctrl never handles tokens. It returns display-ready details (title, tone, chips)
  plus the same details as plain `fields` for agents, and a cache policy; `src/main/adapters/service.ts` does
  the scheduling and caching for all of them. Linear and Notion have no `live` part, so their links are shown
  as parsed.
- **Two ways in, one cache:** the panel watches the sessions it shows and fetches what's due while the window
  is focused. `ctrl resources list` asks the service directly (`request()`), for the returned items only, with
  the same cache policy and regardless of focus; `resources refresh` does the same with `force`. Both share
  the cache, the pauses (rate limits, backoff, CLI not set up) and in-flight fetches, so nothing is fetched
  twice and whatever one fetches, the other shows.

```text
panel (watch, focused) ─┐                      ┌─► due? → adapter.fetch (batched) ─► resource-meta.db
ctrl resources list ────┼─► AdapterService ────┤
ctrl resources refresh ─┘   (force)            └─► in flight? → wait on that fetch
```
- **Modes and status:** each adapter is Off (links hidden), Links only or Live details in Settings. A live
  adapter's `check()` verifies its CLI is installed and logged in without fetching, so Settings can show
  whether it works and offer a setup prompt built from `live.cli` (install, login, verify commands).

```text
adapter = { id, name, types[], live? }
              │         │
              │         ├─ live.check({ run }) → { account }   ← Settings status
              │         └─ live.fetch(batch, { run }) → { meta, cache: { maxAge, refreshOnMention } }
              └─ parse(url) / describe(data)   ← indexer + renderer, no requests
```

- **Add an adapter:** a new file implementing `ResourceAdapter`, listed in `ADAPTERS`, and bump
  `RESOURCES_VERSION`. The indexer then re-extracts from the stored message text, locally and without
  refetching (~10ms for 1k messages).
- **Session references** aren't links: `extractResources()` also matches `@session[Title](id)` and files it
  under the `sessions` adapter as `ctrl://session/<id>`. The panel fills in title and state (archived,
  running, deleted…) from the sidebar's session list instead of a live fetch, so renames and archiving show
  up without reindexing, and a mention lives as long as the message that holds it.
- **Same pipeline as search:** mentions are written in the same transaction as their message and deleted with it.
  Like search, only your prompts and the assistant's text are read, not tool output.

## ctrl Companion

Settings → ctrl Companion opens a small always-on-top window listing the sessions that mentioned what's on screen.
It's a module of its own: `src/companion/` (main side, helper, preload) and `src/renderer/companion/` (its page).
Main only creates it, turns it on and off, and calls `changed()` when sessions or resources change.

```text
ctrl-context (Swift) ──JSON line on change──► Companion (main) ──view──► companion window
 ├ browser: AppleScript, active tab URL         │ URLs → keys (shared adapters)
 ├ Slack: AX tree + hover (ported from Orchid)  │ mentions_resource lookup (exact + prefix)
 └ Notion, Linear: AX web area URL              └ sessions list → rows
```

- **Off costs nothing:** no helper process, no window. On, the helper scans the frontmost app on activation
  and every second, on its own main thread, and prints only when what it sees changed. Main parses a short
  JSON line and runs two indexed queries (bounded to 200 mentions); refreshes from session/resource changes
  are coalesced to one per 300ms, and the view is sent only when it changed.
- **Slack** (the tricky one): the channel id comes from Slack's own client URL in the AX tree
  (`app.slack.com/client/<team>/<channel>`); an open thread panel is the first permalink after
  `Thread in channel …`; on the Threads page, the card under the pointer gives `threads_view_<channel>-<ts>`.
  A channel also matches the threads in it (`slack-thread:<channel>/` prefix). Switching channels, Slack
  updates the content before the window title, so a scan where the header (`Channel details for #…`) and the
  title disagree is dropped. A DM opened from Activity keeps Activity's client URL, so its channel comes from
  the message links on screen. Keys don't depend on the
  workspace, so a guessed workspace in a rebuilt permalink doesn't matter.
- **Permissions:** the helper inherits ctrl's (TCC follows the responsible app): Accessibility for Slack,
  Notion and Linear, Automation per browser (`NSAppleEventsUsageDescription`). Electron apps only expose
  their tree after `AXManualAccessibility`, which the helper sets on them, never on ctrl.
- **Own window:** an `NSPanel` (`type: "panel"`) at floating level on every Space. Clicking it doesn't
  activate ctrl, so the app you were in stays frontmost and its context stays on screen. When ctrl itself is
  frontmost, the helper keeps the last context.
- **New session from screen:** the New button and the global shortcut (`globalShortcut`, registered only while
  on, and paused while Settings records a shortcut) both call `host.newSession(url)`; main types the URL into
  a new chat without sending it.
- The helper is built by `scripts/build.mjs` (universal, `swiftc`, only when its source changed) into
  `dist/companion/` and shipped in `Contents/Resources/companion`. `ctrl-context --once --debug` prints what
  it sees in the frontmost app after 3s (`--app <bundle id>` reads a background app, without hover).

## CLI

`ctrl` drives the app from agents' shells over a unix socket in the state folder. Details, principles and how
to add a command: [CLI.md](CLI.md).

```text
ctrl (dist/cli/cli.cjs) ──JSON──► ctrl.sock ──► cli-server.ts ──► cli-handlers.ts ──► CliHost (main.ts)
```

- **Same code paths as the UI:** handlers go through `CliHost`, which main implements with the functions IPC
  uses (`newSession`, `archive`, `openSession`, `applySettings`, …).
- **One registry** (`src/shared/cli/commands.ts`) drives argv parsing, `ctrl help`, the generated
  [CLI-REFERENCE.md](CLI-REFERENCE.md), and handler lookup.
- **Cheap for main:** reads come from memory; waits subscribe to state pushes; `session read` runs
  `digest.mjs` in a child process.

## Notifications

ctrl has **one** in-app notification: the toast (`src/renderer/Toast.tsx`). Don't add new banners,
popups or notification types. Raise a toast from main with `toast()` in `src/main/main.ts`:

```ts
toast({ icon: "archive", message: "Archived “x”", viewSessionID }, { undo })      // 8s, ⌘Z undoes
toast({ icon: "alert", message }, { sticky: true, action: { label: "Fix", run } }) // until dismissed
```

- **One at a time.** A newer toast replaces the one showing. The countdown pauses on hover.
- **Buttons:** View (`viewSessionID`), Undo (`undo`, also ⌘Z), and one primary `action` with any label.
  The callbacks stay in main; the renderer only sends back the toast id.
- **Sticky** (`duration: null`) is for problems that last, like a failing MCP server. Whoever raised
  it dismisses it with `dismissToast(id)` once the problem goes away.
- Add an icon to the `Toast["icon"]` union and `icons.tsx` if you need a new one.

The other channels each have a single purpose, so don't use them for anything else:

| Channel | Where | Only for |
|---|---|---|
| Sidebar banner (`problem` / `error` in `AppState`) | bottom of the sidebar | ctrl can't reach opencode or the TUI, or a ctrl action failed |
| macOS notification (`src/main/attention.ts`) | system | a background session needs you, finished or failed, while ctrl isn't focused |
| Sound (`src/main/sound.ts`, via `attention.ts`) | speakers | the same transitions; in the background only unless **Also when ctrl is focused** is on |
| Archived bar (`src/renderer/ArchivedBanner.tsx`) | over the terminal's prompt | the session on screen is archived, so its terminal is read-only. A state of that session, not a notification: it leaves with it |

**MCP servers** (Settings → MCP servers) is the first sticky toast: when a server is `failed` or
`needs_auth`, a toast says so and has a **Fix** button. It opens the TUI's new-session screen with a
prompt to fix that server already typed in (not sent). The toast clears itself when the server
reconnects, and the same error doesn't toast twice. Statuses come from `mcp.list` for `~` and
refresh on `mcp.status.changed` events.
