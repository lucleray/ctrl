# Features

Every user-facing feature in ctrl, grouped by area. Keep this list current: when you add, change or
remove a feature, update this file in the same commit. One line per feature, with the main file(s)
where it lives.

## Harnesses

- Two harnesses, opencode and fx, side by side: both kinds of session in the sidebar, Recents and the same
  space. What each supports: [HARNESSES.md](HARNESSES.md)
- Harness for new sessions in Settings → Sessions, overridable per space; the space ⋯ menu also offers a
  new session with the other one (`src/main/main.ts`)
- Either harness is enough: ctrl shows the sessions of whichever it finds, and Settings → Sessions shows
  what's installed with the install command (`src/main/fx.ts`, `src/main/opencode-bin.ts`)
- fx sessions have an `fx` tag in the sidebar (`src/renderer/Sidebar.tsx`)
- fx session ids are prefixed in ctrl (`fx:<id>`), so opencode ids and older state stay as they were
  (`src/shared/types.ts`)

## Shell

- Terminals stacked on the right, one xterm each, only the active one visible, all the same size so
  switching never reflows (`src/renderer/TerminalStack.tsx`)
- One long-lived opencode TUI (xterm.js + node-pty). Switching opencode sessions navigates
  it in place through the bridge plugin, no restart (`src/main/terminal.ts`, `bridge/tui.ts`)
- One fx process per open fx session (`fx resume --id <id>`), kept alive so switching is instant and running
  turns keep going; up to 12, the least recently used idle ones closed past that (`src/main/fx-terminals.ts`)
- fx's `/new` and `/resume` are followed: the sidebar highlight and space move with the pty (`owner.live` →
  `claim()` in `src/main/fx-terminals.ts`)
- When fx exits, its pane stays with an `[fx exited]` line; Enter or reopening the session restarts it
- fx sessions open at quit come back at launch, in the background one at a time, and so does whichever
  session was on screen. Running fx turns don't survive (send `continue`) (`restoreOpen()` in `src/main/main.ts`)
- Empty state when nothing is open (e.g. after archiving the fx session on screen)
- Sidebar highlight follows navigation done inside the TUI (`bridge/tui.ts`)
- The TUI auto-restarts if it exits (`src/main/terminal.ts`)
- The TUI's own tabs and sidebar are hidden, so it fills the right side; no header bar (`src/main/terminal.ts`)
- Closing the window hides the app instead of quitting (`src/main/main.ts`)

## Spaces

- Create, rename (double-click or ⋯ menu), delete spaces; new spaces go to the top (`src/renderer/Sidebar.tsx`)
- Reorder spaces by drag and drop
- Fold / unfold spaces (state saved)
- Move sessions between spaces by drag and drop, onto Recents to unassign, or via right-click → Move to
- ⋯ menu: new session in space, rename, space settings, archive all sessions, delete space (`src/main/main.ts`)
- Space settings for new sessions started from ctrl in that space: folder (unset follows Settings → Sessions →
  Folder), harness, model (toggle + variant,
  one per harness), instructions attached as an invisible session instruction (opencode only), ctrl
  instructions Default / On / Off
  (`src/renderer/SpaceSettings.tsx`)
- Status rollup on a space: shows the most urgent status of its sessions (`src/renderer/StatusIcon.tsx`)

## Sessions

- Rename from the sidebar (right-click → Rename). fx: writes `session.json` (0600) once no fx process has
  the session, the new title waits in `state.json` until then
- Delete (right-click → Delete session), held back until the undo toast expires. fx: the session folder goes
  to the Trash
- fx: right-click → Reveal session folder, Quit fx process
- Archive / unarchive: hover button, right-click, ⌘W, or "Archive all sessions" on a space. Archiving a session
  archives its sub-sessions too (undo brings them all back). Stored in
  ctrl's `state.json`, opencode is untouched (`src/main/store.ts`) apart from archiving marking the session
  read. Archived rows never show the unread / failed dot
- Opening an archived session shows it read-only: a bar over the prompt says it's archived with an **Unarchive**
  button, and its terminal only scrolls (keys, clicks, pastes and drops are dropped) until it's unarchived
  (`src/renderer/ArchivedBanner.tsx`, `locked` in `src/renderer/TerminalStack.tsx`)
- **Recents**: every non-archived session, newest first, 10 at a time with Show more, foldable (state saved)
- **Created by an agent**: sessions an agent makes with `ctrl session new` show a small bot icon, and the
  tooltip names the agent and the session it ran in. Stored in `state.json` (`createdByAgent`), returned by the CLI
- **Child sessions**: any session can have child sessions, any depth (right-click → New child session: same
  space, folder and harness). Inside a space, children nest under their parent, with a chevron to fold them
  (folded parents show their children's most urgent status); siblings are ordered by their subtree's latest
  activity. Drop a session onto another one in a space to nest it (it joins that space); right-click → Open
  parent / Detach from parent. Moving a session to another space (menu, drag, CLI) takes its children along,
  except those filed in a different space. A child whose parent is in another space, or archived, stays at the top of its
  space with a small link icon: hovering shows a card with the parent and its space, clicking opens the parent and reveals it in the sidebar (unfolds its space and parents, scrolls to it, flashes it). Recents and Archived stay flat. Children of
  a deleted session move up to its parent. Stored in `state.json` (`parents`), returned by the CLI
- **Archived**: most recently archived first, 10 at a time with Show more, foldable (state saved)
- Status per row, most urgent first: needs input (permission / question), running, failed (unread),
  finished (unread), otherwise time since last update (`src/renderer/StatusIcon.tsx`). fx: from OSC 7501
  reports of the processes ctrl runs, else `recovery.json` (turn in progress) or the last line of
  `events.jsonl`; read state kept by ctrl
  (`src/main/fx.ts`)
- Sidebar list patched from opencode events instead of re-listing (`src/main/opencode.ts`). The sync on launch and
  reconnect loads opencode sessions updated in the last 30 days and checks pending input only in running sessions'
  folders; older sessions load when the Archived section opens, the palette searches or a CLI command runs; fx sessions
  from one scan of `~/.fx/sessions`, then an fs watcher re-reads only the folder that changed (`src/main/fx.ts`)

## Navigation & search

- ⌘1–9 jumps to the Nth visible session; hold ⌘ to show number badges (`src/renderer/jump.ts`)
- ⌘P / ⌘K search palette: session titles (in memory) + full-text over message content via a SQLite FTS5
  index built in a utility process, for both harnesses (fx: tails each `events.jsonl` by byte offset)
  (`src/renderer/Palette.tsx`, `src/indexer/indexer.ts`, `src/main/search-db.ts`)
- ⌘N new chat in the default space (Settings → Sessions → Space, else none) and folder (the space's, else Settings → Sessions → Folder, else ~), ⌘T new session in the current session's folder, space and harness
- Search and settings icons at the top of the sidebar

## Resources panel

- Floating card over the terminal's top-right corner (⇧⌘R) listing links shared in the current session or its whole space: PRs, issues,
  commits, repos, Linear, Notion, Slack, Vercel deployments/projects. Shown by default, resizable,
  hidden while Settings or space settings are open (`src/renderer/ResourcesPanel.tsx`)
- Most recently mentioned first, except pull requests: open and draft ones come first, then merged, then closed
  (each type's `rank`, `src/shared/adapters`). `ctrl resources list` orders them the same way
- Click the panel's title to fold it to a small header pill with the link count, so a long list stops covering
  the terminal. Click again to unfold. Remembered across restarts (`ui.resourcesCollapsed`), agents fold it with
  `ctrl ui resources fold|unfold`
- Dock button in the panel's header: turns the card into a column on the right, the terminal narrows instead of
  being covered. Resizable (`ui.resourcesWidth`), folds to a thin side tab with the link count. Click again to
  float it back. Remembered across restarts (`ui.resourcesDocked`), agents switch with `ctrl ui resources dock|float`
- Resource adapters, one file per service in `src/shared/adapters/`, registered in `adapters/index.ts`: each
  declares the link types it recognizes (URL → canonical key, icon, offline title) and, optionally, a `live`
  part that fetches details through the service's own CLI (ctrl never handles tokens). Live results are
  display-ready (title, subtitle, tone, chips), carry the same details as plain `fields` for agents (PR state,
  draft, CI, review, mergeable, author; deployment state, target, branch; Slack channel, author, text), and a
  cache policy (max age, refetch when mentioned again); one scheduler fetches only while the panel is open and
  the window focused, and caches on disk (`src/main/adapters/service.ts`). The CLI shares that cache and its
  pauses (see Command line). Settings → Resource adapters lists them with a status
  dot (CLI checked on launch and when Settings opens: ready, not installed, not logged in), a mode select
  (Off hides its links, Links only, Live details) and, when the CLI isn't set up, a copyable agent prompt to
  install and log it in, plus Check again
  - GitHub (live, `gh api graphql`, ~40 per request): PR state, CI, reviews, conflicts; merged PRs are final
  - Vercel (live, `vercel api`): deployment commit/branch/build state (15s while building), projects' latest production
  - Slack (live, `slack-cli`): thread root message, channel, author; channel names; kept until mentioned again
  - Linear, Notion: links only
  - Sessions (`src/shared/adapters/sessions.ts`): `@session[Title](id)` references, as dropped on the terminal,
    list the referenced session with its current title, space and folder, plus `archived`, `running`,
    `needs you`, `failed` or `deleted` chips from the sidebar's list. Archiving the referenced session keeps the
    row. Click opens it in ctrl, the copy button copies the reference, dragging it onto the terminal pastes
    the reference. A session never lists itself.
    `ctrl resources list` returns them as type `session` with the referenced session (or `null` once deleted)

## Board (experimental)

- Board (sidebar button, or space ⋯ menu → Board to open it filtered on that space): one board for the
  resources of every session, filtered by space and by type (GitHub, Slack, Vercel,
  Linear) with legend-style chips: click shows only that one (again: all), ⌘/⇧-click shows or hides it,
  ⌥-click shows all except it. Hidden ones are struck through, new spaces show up unless you picked "only",
  the filter is saved across restarts (localStorage). Rows combine, each chip counts the open cards it would show; cards name
  their spaces when the filter mixes them, as four columns by whose turn it is: **Needs you**, **Waiting on others**, **In progress**, **Done** (faded, 10 at
  a time). Each card says why it's there (CI failed, Changes requested, Waiting on @vvo, Approved, ready to
  merge…) and links back to up to two sessions that mention it. Click opens the link, a session chip opens the
  session, Esc closes (`src/renderer/Board.tsx`)
- Each link type decides its column with `stage()` (`src/shared/adapters/`). PRs compare their author and
  requested reviewers with the `gh` login (`reviewers` field); deployments go by build state; commits only
  show while CI fails or runs; Slack threads and Linear issues have no live state, so they count as in progress
  while mentioned recently. Repos, Notion pages, channels, projects and sessions stay off the board

## ctrl Companion (experimental)

- Always-on-top window, off by default and marked Experimental (last section of Settings, or `ctrl settings set companion true`), that
  lists the sessions that mentioned what's on screen, laid out like the sidebar (Spaces with a folder per space,
  then Recents, open by default, and Archived, folded, both foldable) with the same rows (fx tag, status, age) and colors, newest first: the PR, issue or page in the browser tab
  (Chrome, Arc, Brave, Edge, Dia, Vivaldi, Safari), the Slack thread (side panel, or the one under the pointer
  on the Threads page) or channel, the Notion page, the Linear issue. A Slack channel also lists sessions that
  mentioned threads in it (marked with #). Click a row to open it in ctrl. Draggable, sized to its content,
  remembers its position, stays on every Space; clicking it doesn't take focus from the app you're in. Its ⋯
  menu: New session, Open ctrl, Settings…, Hide ctrl Companion (turns it off) (`src/companion/`, `src/renderer/companion/`)
- The header reads ctrl; below it, a row for what's on screen (the app, then the tab, channel or page) with
  a "New" button
- New session from screen: that button (tooltip: the shortcut), or ⌃⌥⌘Space from any app (a global shortcut, registered only
  while the companion is on, rebindable in Settings → Shortcuts), brings ctrl forward on a new chat with the link
  on screen typed in, not sent (the first link ctrl recognizes, else the first one). opencode: its new-session
  screen; fx: a new session, typed in once fx is ready (`newSessionWith()` in `src/main/main.ts`)
- Jump with ⌃1–9 from any app: the companion's rows are numbered top to bottom (archived ones left out), and
  ⌃N brings ctrl forward on that session. Holding ⌃ on its own shows the numbers on the rows, like ⌘ in the
  main window (the hints need Accessibility). Only as many ⌃N as there are numbered rows are registered, and
  only while the companion is on, so the rest stay free for other apps (`updateJumps()` in `src/companion/companion.ts`)
- Reading the screen goes through a small native helper, `ctrl-context`, ported from Orchid: AppleScript for
  browser tabs, the Accessibility tree for Slack, Notion and Linear. Without Accessibility access the window
  offers a button to grant it (`src/companion/native/context.swift`)

## Remote control (experimental)

- Settings → Remote control (off by default) serves a web app on this Mac's Tailscale address (port 7337,
  7338 for dev runs), so your phone lists spaces and sessions, drives their terminals and shows the Board
  (`src/main/remote.ts`, `src/remote/`)
- The link carries a secret token that becomes an HttpOnly cookie on first visit; without Tailscale it only
  listens on localhost, and it follows Tailscale connecting or changing address (rechecked every 15s)
- opencode sessions open in a separate TUI sized to the phone, so the desktop keeps its session and size; it
  quits after 10 minutes with nobody looking. fx sessions mirror the desktop's pty, resized while the phone views it
- Phone screens: Sessions (spaces, then Recents, with status dots; + on a section starts a session there,
  with the space's folder, harness and model, and opens it on the phone without changing the desktop) and Board (the four columns stacked, one
  space at a time or all, saved on the phone; tap a card for its link, a session chip to open it).
- opencode sessions open as a chat: your messages as bubbles, the agent's replies as rendered markdown,
  tool calls as one-line summaries, updated live while a turn runs; Load earlier for older messages; a
  composer (Return = new line, ↑ sends, ■ stops the turn); permissions as Allow / Always / Deny, questions
  link to the terminal (`src/main/remote-chat.ts`). **Terminal** in the header switches to the TUI, **Chat** back
- fx sessions (and the Terminal view) are a full-width terminal: tap it to type with the phone's keyboard (Return adds a new line, the round send
  button that shows while typing submits), swipe to scroll the TUI, A−/A+ for the font size

## Terminal

- Key fixes: ⇧↩ new line, ⌘← / ⌘→ line start / end, ⌘⌫ delete to line start (`translateKey()` in
  `src/renderer/TerminalStack.tsx`)
- ⌘-click links to open them in the browser, including URLs wrapped across lines (`src/renderer/wrapped-links.ts`).
  opencode 2.0.26+ opens clicked links itself (plain or ⌘-click), so ctrl leaves its links to the TUI
- Drag a session onto the terminal to paste `@session[Title](id)` (`session[…]` without the `@` in fx, which
  reads `@` as a file); the `read-session` skill lets the agent read it, opencode or fx, from either harness,
  with or without node installed (`src/renderer/ReferenceDrop.tsx`, `skills/read-session`). An fx turn still
  in progress shows as `Turn N · running` (read from `recovery.json`)
- Drop files from Finder onto the terminal to paste their escaped paths (`src/renderer/ReferenceDrop.tsx`)
- Drag a row from the resources panel onto the terminal to paste its link, or its session mention for a
  referenced session (`src/renderer/ResourcesPanel.tsx`, `src/renderer/ReferenceDrop.tsx`)
- Text size: stepper in settings, ⌘+ / ⌘− / ⌘0
- Joined emoji (🏄‍♂️, 👩‍💻, flags) render as one glyph with the right width (`@xterm/addon-unicode-graphemes`)

## Settings (⌘,)

- One section at a time, picked from a list on the left (General: Appearance, Sessions, Notifications, Shortcuts;
  Integrations: Agents, MCP servers, Resource adapters, Companion; About). A red dot marks a section that needs you
  (broken opencode service, failing MCP server or adapter, update available). Reopening comes back to the last section
- Search box above the list (focused on open, ⌘F): shows the matching rows of every section, matches highlighted,
  sections without matches dimmed in the list. Enter or a section title opens that section, Esc clears
  (`filterRows()` in `src/renderer/Settings.tsx`)
- Appearance: system / light / dark (`src/renderer/Settings.tsx`)
- opencode TUI theme (built-in and custom themes)
- Terminal text size
- Sessions: harness for new sessions, what's installed, default folder for new sessions whose space has none
  (unset = ~; e.g. one shared folder so opencode loads a single location instead of one per worktree), default space for
  new chats (⌘N, New chat, the palette, `ctrl session new` with no `--space` and no parent; a deleted space falls back to
  none; the companion's opencode chats still start with no space, since nothing is created until you send), default model per harness (toggle, searchable
  picker grouped by provider, variant / effort picker) (`src/renderer/ModelPicker.tsx`)
- ctrl instructions (on by default, Show text): an invisible instruction entry (`ctrl.cli`) on opencode sessions
  telling the agent it runs in ctrl and how to look around with the `ctrl` CLI. Added at creation and synced on
  the session on screen, so older and TUI-started sessions get it when opened; spaces can override
  (`src/shared/ctrl-instructions.ts`, `syncCtrlInstructions()` in `src/main/opencode.ts`)
- MCP servers status, with a sticky toast + Fix button when one fails or needs auth
- Rebindable shortcuts (`src/renderer/ShortcutSettings.tsx`, `src/shared/shortcuts.ts`)
- Notifications: dock badge with sessions waiting on you, macOS notifications when a background session
  needs you / finishes / fails (both toggleable) (`src/main/attention.ts`)
- Sounds when a session needs you / fails / finishes: on/off, a macOS system sound or your own audio file per
  event (or None), preview button, optional "also when ctrl is focused". One sound per burst (most urgent wins),
  played with `afplay`, and it replaces the system notification sound (`src/main/sound.ts`). fx's own sounds are
  always off (`FX_SOUND=off`), so they never double up with ctrl's
- Agents: install / uninstall the read-session skill, and the `ctrl` command line with its skill, with status
- About: ctrl's version, update status, Check for updates / Update and restart
- Resizable sidebar (200–520px, double-click edge to reset), width saved (`src/renderer/ResizeHandle.tsx`)

## Feedback

- Toasts are the single in-app notification: undo (⌘Z), View, one action button, sticky mode
  (`src/renderer/Toast.tsx`)
- Sidebar banner only when ctrl can't reach opencode / the TUI, or an action failed

## Command line (`ctrl`)

- `ctrl` CLI for agents: JSON in/out, self-describing (`ctrl help --json`, `ctrl docs`), stable error codes
  with hints. Principles and conventions in [CLI.md](CLI.md), every command in [CLI-REFERENCE.md](CLI-REFERENCE.md)
  (`src/cli/cli.ts`, `src/shared/cli/`)
- Sessions: list / filter / page, get, new (space settings apply, `--prompt`, background unless `--focus`,
  always replies within 12s: a stuck harness gives a `TIMEOUT` that says whether the session was created),
  focus, rename, move, archive / unarchive, send, wait for a status, stop, `ref`,
  reference one session in another, read a session's digest (`src/main/cli-handlers.ts`)
- Spaces: list, get, create, rename, set folder / harness / model / instructions / ctrl instructions, reorder, fold, archive all,
  delete
- Settings: list (typed, with allowed values and defaults), get, set, reset, as dotted keys
- UI: what's on screen, opencode home screen with a prefilled prompt, window show / hide / raise, resources
  panel, sidebar width, Recents / Archived folding, settings page, ⌘P palette with a query, toast
- Search, resources, models, MCP servers, skills, app status / launch / updates, and an NDJSON `events` stream
- Resources with live details: `resources list` fetches what's due like the panel does (same cache policy,
  only the returned items, window focus not needed), waits up to `--wait` (5s) and marks the rest `pending`;
  `--cached` skips fetching. `resources refresh [<id|url>...]` refetches regardless of the cache, by id, URL or
  scope. Both report adapters that couldn't fetch in `errors` (rate limited with `retryAt`, CLI not set up with
  the fixing command)
- Selectors: `self` (the calling session, via `OPENCODE_SESSION_ID` or ctrl's `CTRL_TERM_ID` in fx ptys, or
  its space for `--space`), `current`, `name:<title>`; ambiguous names list candidates
- A CLI killed before it answers still replies: the launcher prints a JSON error naming the signal, and
  suggests stdin (`--prompt -`) when an argument was long (`bin/ctrl`)
- Child sessions: `session new` run from a session makes a child of it by default (`--parent self`, in the
  parent's space, folder and harness unless flags say otherwise; `--parent none` for a top-level one);
  `session move --parent <s|none>` nests or detaches (refuses cycles); `session list --parent <s>`; sessions
  carry `parentID` and `children`. The ctrl instruction and skill tell agents about the default
- Sessions an agent creates are marked `createdByAgent: {agent, by, at}` (by = the agent's own session, via
  `self`). Agents are detected from the env their harness sets (`AI_AGENT`, `AGENT=1`, `CLAUDECODE`,
  `CURSOR_AGENT`, ctrl's `CTRL_TERM_ID` for fx); ctrl strips those from the terminals it spawns
- No toasts for CLI actions: archive, archive-all and space delete reply with an `undo` command instead;
  only `ui toast` shows one
- Agents can't delete sessions, only archive them (reversible, the reply's `undo` brings them back); nothing
  changes the screen without `--focus` / `focus`
- Unix socket in the state folder (0600), one per ctrl (dev and test runs get their own); stale sockets
  cleaned at launch (`src/main/cli-server.ts`)
- Works in ctrl's terminals without installing (PATH + `CTRL_SOCKET` set in the TUI and fx ptys,
  `src/main/child-env.ts`); Settings → Agents installs `~/.local/bin/ctrl` and the ctrl skill, and warns when
  another `ctrl` comes first in PATH or its folder isn't in PATH (`src/main/cli-install.ts`, `skills/ctrl`)
- `install.sh` links `~/.local/bin/ctrl` into the app bundle (relinks other ctrl copies, leaves foreign files
  alone); after the welcome screen, one "set up agents" toast installs both skills and the link

## Install & updates

- Install with one curl command: latest release → `/Applications`, not quarantined (`install.sh`)
- Welcome screen over the terminal area at first launch, and whenever neither harness is usable: a card per
  harness (fx, opencode) with a check when installed, or its install / upgrade command to copy. One installed:
  start with it. Both: pick the one new sessions start with. None: Check again (also when the window regains
  focus). Settings → About → Welcome screen shows it again (`src/renderer/Onboarding.tsx`, `src/main/opencode-bin.ts`)
- New sessions fall back to the other harness when the chosen one isn't installed (`harnessFor()` in `src/main/main.ts`)
- opencode service health: once connected and every 5 min, ctrl runs a probe inside the running service. A service
  that outlived its macOS login session (no DNS, user lookups, TLS or keychain for anything it runs) shows red in
  Settings → Sessions with Restart, plus a sticky toast with Restart. Restart stops the registered service,
  starts a fresh one from ctrl and respawns the TUI; the indexer reconnects on its own (`checkHealth()` /
  `restart()` in `src/main/opencode.ts`)
- Updates from GitHub Releases through GitHub's public API, no login: checked at launch and every 6h, sticky toast with Update, which
  downloads, swaps the app bundle once ctrl quits and relaunches. Settings → About shows the version
  and a manual check (`src/main/updater.ts`)
- read-session skill: offered in a toast once the welcome screen is done (with the ctrl skill and command) and when a session is referenced without it,
  installed into `~/.config/opencode/skills` from Settings → Agents (install / uninstall), refreshed
  when ctrl's copy changes, and copies ctrl didn't make are left alone (`src/main/skill.ts`)
- arm64 and x64 builds, published with `npm run release` (`scripts/package.mjs`, `scripts/release.mjs`)

## App & dev

- App name **ctrl** and dot-matrix `c_` icon (`build/icon.svg`, `scripts/icon.mjs`)
- Packaged macOS app: `npm run install-app`; loads the login shell env at startup, with common bin folders
  added to PATH if that fails (`scripts/package.mjs`, `src/main/shell-env.ts`)
- Signed with the self-signed "ctrl Code Signing" certificate, so macOS folder access (Documents, Desktop, …)
  survives rebuilds and updates; ad hoc when the certificate is missing, and releases refuse to ship without it
  (`scripts/sign.mjs`)
- Folder access alerts explain why ctrl asks (`build.mac.extendInfo` in `package.json`, copied into the dev app)
- Dev runs use a separate `ctrl-dev` state dir, so dev and installed app run side by side
- Headless mode and debug hooks for test runs: no window, no focus steal (`CTRL_*` env vars, see `docs/DEVELOPMENT.md`)
- README screenshots and GIF regenerated from a throwaway demo opencode, and fx versions from throwaway fx sessions shown next to them (`scripts/demo/`, `--harness fx`, `CTRL_FRAMES` hook)
