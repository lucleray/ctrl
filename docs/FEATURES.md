# Features

Every user-facing feature in ctrl, grouped by area. Keep this list current: when you add, change or
remove a feature, update this file in the same commit. One line per feature, with the main file(s)
where it lives.

## Harnesses

- Two harnesses, opencode and fx, side by side: both kinds of session in the sidebar, Recents and the same
  space. What each supports: [HARNESSES.md](HARNESSES.md)
- Harness for new sessions in Settings → Sessions, overridable per space; the space ⋯ menu also offers a
  new session with the other one (`src/main/main.ts`)
- New sessions show in the sidebar right away ("New session"), whatever the harness, and stay there when you
  switch away or ctrl restarts, even before their first message. fx only writes a session at its first prompt:
  until then ctrl keeps it (`unstarted` in `state.json`) with its space, parent and draft, under fx's id (chat)
  or a placeholder (`fx:new-…`, terminal) that takes fx's id once fx reports it. Opening one whose process is
  gone starts a fresh fx for it (`src/main/unstarted.ts`)
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
- One fx process per open fx session (`fx --resume <id>`), kept alive so switching is instant and running
  turns keep going; up to 12, the least recently used idle ones closed past that (`src/main/fx-terminals.ts`)
- fx's `/new` and `/resume` are followed: the sidebar highlight and space move with the pty (the session whose
  lock the process holds, or v1's `owner.live` → `claim()` in `src/main/fx-terminals.ts`)
- Both fx session layouts: fx 0.0.17's `~/.fx/sessions/v2/` (index + one log per session) and the older
  per-session folders it converts the first time it opens one (`src/main/fx-store.ts`)
- When fx exits, its pane stays with an `[fx exited]` line; Enter or reopening the session restarts it
- fx sessions open at quit come back at launch, in the background one at a time, and so does whichever
  session was on screen. fx 0.0.17+ sends a request that quitting interrupted again on its own when it reopens
  (`restoreOpen()` in `src/main/main.ts`)
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
  one per harness), instructions attached as an invisible session instruction (fx: through an agent profile,
  `src/main/fx-profiles.ts`), ctrl instructions Default / On / Off
  (`src/renderer/SpaceSettings.tsx`)
- Status rollup on a folded space or parent session: shows the loudest signal of its sessions, background work
  included: needs input > running > failed > unread > subagent > shell (`signalRank()` in `src/renderer/StatusIcon.tsx`)
- Background work: a session whose turn is over but still has shells or subagents running shows a pulsing icon
  instead of its age, like the spinner for a running turn: subagent if any, else shell (the tooltip counts them). Unread and failed dots still win. A harness
  capability (`activity()` in `src/main/harness.ts`), opencode only for now

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
  (folded parents show the loudest signal of themselves and their children, background work included); siblings are ordered by their subtree's latest
  activity. Drop a session onto another one in a space to nest it (it joins that space); right-click → Open
  parent / Detach from parent. Moving a session to another space (menu, drag, CLI) takes its children along,
  except those filed in a different space. A child whose parent is in another space, or archived, stays at the top of its
  space with a small link icon: hovering shows a card with the parent and its space, clicking opens the parent and reveals it in the sidebar (unfolds its space and parents, scrolls to it, flashes it). Recents and Archived stay flat. Children of
  a deleted session move up to its parent. Stored in `state.json` (`parents`), returned by the CLI
- **Archived**: most recently archived first, 10 at a time with Show more, foldable (state saved)
- Status per row, most urgent first: needs input (permission / question), running, failed (unread),
  finished (unread), otherwise time since last update (`src/renderer/StatusIcon.tsx`). fx: from OSC 7501
  reports of the processes ctrl runs, else the turn lines at the end of its log and whether an fx process has
  it open (`fx sessions --live`, `lsof` on its lock); read state kept by ctrl
  (`src/main/fx.ts`)
- Sidebar list patched from opencode events instead of re-listing (`src/main/opencode.ts`). The sync on launch and
  reconnect loads opencode sessions updated in the last 30 days and checks pending input only in running sessions'
  folders; older sessions load when the Archived section opens, the palette searches or a CLI command runs; fx sessions
  from one scan of `~/.fx/sessions` (v2's index and the older folders), then an fs watcher re-reads only the
  folder that changed, and a 2s poll stats v2's index and the logs of open sessions (`src/main/fx.ts`)
- fx subagents still working once the main agent's turn is over show as the sidebar's subagent icon
  (`fx sessions --live`, `activity()` in `src/main/fx.ts`)

## Navigation & search

- ⌘1–9 jumps to the Nth visible session; hold ⌘ to show number badges (`src/renderer/jump.ts`)
- ⌘P / ⌘K search palette: session titles (in memory) + full-text over message content via a SQLite FTS5
  index built in a utility process, for both harnesses (fx: tails each session's log by byte offset, so a
  prompt is searchable while its turn runs)
  (`src/renderer/Palette.tsx`, `src/indexer/indexer.ts`, `src/main/search-db.ts`)
- ⌘N new chat in the default space (Settings → Sessions → Space, else none) and folder (the space's, else Settings → Sessions → Folder, else ~), ⌘T new session in the current session's folder, space and harness
- Search and settings icons at the top of the sidebar

## Resources panel

- Sidebar on the right, toggled on or off (⇧⌘R, the sidebar's resources button, the panel's close button), listing
  links shared in the current session or its whole space: PRs, issues, commits, repos, Linear, Notion, Slack,
  Vercel deployments/projects. The terminal narrows next to it. Shown by default, resizable (`ui.resourcesWidth`),
  hidden while Settings or space settings are open. Remembered across restarts (`ui.resourcesOpen`), agents
  switch it with `ctrl ui resources open|close|toggle` (`src/renderer/ResourcesPanel.tsx`)
- Grouped by type, pull requests at the top, then worktrees, sessions, the rest of GitHub, Linear, Notion,
  Slack and Vercel (`PANEL_TYPES`, `src/shared/adapters`)
- Most recently mentioned first, except pull requests: open and draft ones come first, then merged, then closed
  (each type's `rank`, `src/shared/adapters`). `ctrl resources list` orders them the same way
- Archive button on each row (hover): the resource leaves the list for a folded **Archived** section at the
  bottom (unarchive button there), and leaves the board, until a session mentions it again, then it comes
  back on its own. Everywhere, not per space (`archivedResources` in `state.json`). Agents use
  `ctrl resources archive|unarchive <id|url>...`, and `resources list --archived` includes them
- Resource adapters, one file per service in `src/shared/adapters/`, registered in `adapters/index.ts`: each
  declares the link types it recognizes (URL → canonical key, icon, offline title) and, optionally, a `live`
  part that fetches details through the service's own CLI (ctrl never handles tokens). Live results are
  display-ready (title, subtitle, tone, chips), carry the same details as plain `fields` for agents (PR state,
  draft, CI, review, mergeable, auto-merge, author; deployment state, target, branch; Slack channel, author, text), and a
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
  a time). Each card says why it's there (CI failed, Changes requested, Waiting on @alice, Approved, ready to
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
  7338 for dev runs), so your phone lists spaces and sessions, chats in opencode ones and fx chat ones, and shows the Board
  (`src/main/remote.ts`, `src/remote/`)
- Settings shows a QR code of the link to scan with the phone's camera ("Can't scan? Show the link" reveals
  it with a Copy button), the MagicDNS name when there is one
- The link carries a secret token that becomes an HttpOnly cookie on first visit; without Tailscale it only
  listens on localhost, and it follows Tailscale connecting or changing address (rechecked every 15s)
- Terminal fx sessions are listed (with an fx tag, long press menu included) but open on the Mac only: tapping
  one says so. fx sessions created as a chat open like opencode ones. There's no terminal view on the phone
- Phone screens: Sessions and Board (the four columns stacked, one space at a time or all, saved on the
  phone; tap a card for its link, a session chip to open it). The top bar shows the connection dot (green
  when connected, red otherwise) right after "ctrl", and the Sessions / Board tabs on the right; it stays pinned while the list scrolls.
- Sessions mirrors the sidebar: search with a New chat button next to it, then Spaces (folders in the sidebar's order, child sessions nested
  under their parent with a fold toggle, a folded space shows its most urgent status), Recents (every live
  session, newest first, 10 at a time) and Archived (the newest 30). Spaces, Recents, Archived and child sessions start folded;
  what you fold is saved on the phone. An empty space shows "No sessions yet" followed by a small inline New session button to start
  one. New sessions start with the space's folder, harness and model, and
  open on the phone without changing the desktop
- Search at the top works like ⌘K: chats by title, space or folder, message hits from the search index with
  a snippet, and spaces (tap one to jump to it, unfolded)
- Long press a session (or ⋯ in its chat header) for its menu: open, new child
  session, rename, move to a space, open parent, detach from parent, archive (unarchive in Archived). Long press a space (or the ⋯ on an open one)
  for new session, fold and its board. Right-click does the same in a desktop browser
- opencode sessions, and fx sessions created as a chat, open as a chat: your messages as bubbles, the agent's replies as rendered markdown,
  tool calls as one-line summaries, updated live while a turn runs; Load earlier for older messages; a
  composer (Return = new line, ↑ sends, ■ stops the turn; opening the keyboard keeps the latest messages in
  view above it); permissions as Allow / Always / Deny; photos: + in the composer (camera or library) or
  paste an image, up to 6 per message, shrunk to 2000px JPEG on the phone and sent to opencode inline, shown
  in your bubble (served from `/file/<session>/<message>/<n>`)
  (`src/main/remote-chat.ts`)
- An archived session's chat shows "This session is archived" with an Unarchive button in place of the
  composer, like the desktop's banner
- Questions the agent asks are answered in the chat, one at a time like the TUI ("1 of 3"): tap an option
  (it moves on to the next question), tick several for multi-select, or type your own answer when the question
  allows it; Back / Next / Skip, then a Review step (tap an answer to change it) with Submit. Dismiss cancels
  it. A half-answered question survives live updates

## Chat view (experimental)

- Settings → Appearance → Sessions: Terminal (default) or Chat. Chat shows the opencode session on
  screen as a chat, like remote control's phone view, with the same reads (`src/main/remote-chat.ts`): your
  messages, the assistant's markdown, what it thought and its tool calls (`src/renderer/ChatView.tsx`)
- fx sessions as a chat (fx ≥ 0.0.17): with the setting on Chat, a new fx session (⌘N, ⌘T, the space menu,
  `ctrl session new`) is created over `fx acp` and runs as a chat for good, on the desktop and on the phone;
  with the setting on Terminal it gets a terminal for good. Existing sessions keep what they were created
  with. Each open chat session has its own `fx acp` process, which ctrl starts when the session opens or gets
  a message and stops like a terminal's (closing the pane, the cap of 12 live fx processes, quitting); the
  session is restored at launch like terminal ones. Space instructions and the ctrl instruction go in as the
  session's system prompt. A message sent mid-turn steers the turn (shown in the inbox until fx takes it);
  one with an image waits for the turn. Permissions are answered in the chat (Allow / Always / Deny); questions
  come as plain text (fx has no forms over ACP yet). A session fx holds elsewhere (a terminal) can't open as
  a chat. fx's startup notices are kept out of the reply (`src/main/fx-chat.ts`, `src/main/acp/`)
- Drafts: what you type in a session's composer stays with that session, like Slack: switching sessions never
  carries it over, and it's kept in `state.json` across restarts (attached images only while ctrl runs). The
  sidebar shows a pencil before the age of sessions with a draft (not the one on screen). Sending clears it;
  archiving or deleting the session drops it (undoing an archive brings it back) (`src/renderer/drafts.ts`)
- `ctrl session send` to an fx chat session sends through the chat; `--no-submit` is refused (nothing to type
  into); `ctrl session stop` cancels its turn
- Thinking and shell commands show in full in a box clamped to its first 3 lines: click it to unfold, click again
  to fold it back. Other tool calls are one line, or their full input clamped the same way when it's long
- The TUI keeps running underneath (hidden, never focused), so switching back is instant and the sidebar,
  ⌘N and `/new` work as before. fx sessions show their terminal
- No session on screen (the new-session screen, e.g. after archiving the current one): "What do you want to work
  on?" with the composer in the middle. Sending starts an opencode session in the default space with that message.
  A tool's fix-it prompt, the companion's text and `ctrl ui home --prefill` are typed into this composer, not
  into the hidden TUI
- One-line composer with one button: send, or stop (■) while a turn runs and nothing's typed. Enter sends, ⇧↩ new
  line, Esc stops; paste or drop images to attach them
- Type to focus: a key typed (or ⌘V) while focus is nowhere in particular (after clicking a message, the
  sidebar, a button) goes to the composer, without clicking it first. Coming back to the window puts the caret
  back in it. Fields, the terminal and open pickers keep their keys, and nothing happens under the palette,
  Settings or the Board (`src/renderer/type-to-focus.ts`)
- Messages sent while a turn runs steer it (opencode's `delivery: "steer"`, the phone's too): they wait greyed out
  above the composer ("Steers the agent at its next step") until opencode hands them to the agent
- A shell or subagent the turn waits for would hold a message back until it's done. When a message you sent
  mid-turn still waits after 3 seconds, ctrl moves what holds the turn to the background (what ⌃B does in
  opencode's TUI) and the agent reads the message; the shell or subagent keeps running, and its result still
  reaches the agent when it ends. Quick commands finish within those 3 seconds and stay as they are, and a turn
  that's only thinking or writing is never interrupted. Same for messages sent from the phone, not for
  `ctrl session send`. Only for harnesses that can (`HarnessSource.background`, `src/main/harness.ts`):
  opencode's `session.background`
- A tool call moved to the background shows ↗ and a `background` tag instead of ✓. When what it started ends, a
  line says so (`✓ shell background finished · pnpm test`; ✕ "failed" when it exits with an error, ■ "stopped"
  when it was killed or cancelled) right where opencode tells
  the agent, which is what starts the next turn. The phone's chat shows both too
- Long pastes (5+ lines or 800+ characters) go in as a highlighted `[Pasted 12 lines]` token, like opencode's TUI;
  ⌘V again right after puts the full text in its place. Backspace removes a token whole; the full text is sent
- Under it: the session's spend, how full its context is (newest assistant message's tokens over the model's
  context window) and the subagents and shells it still has running, each with its icon ("1 subagent",
  "2 shells", like the TUI's prompt footer; shown once they've run for a second, harnesses with `activity()`
  only) on the left. Clicking one of the two lists its subagents or its shells, oldest first (a shell's command, a
  subagent's title, how long ago it started), each with a ✕ that kills the shell or stops the subagent (harnesses
  with `work` only); model picker (same searchable list as Settings) and variant menu on the right, both opening upward.
  Picking switches the session's model for its next turns and the TUI follows, and the other way round
- Newest 40 messages, then Load earlier; live updates while a turn streams (`src/main/desktop-chat.ts`, at most
  every 300ms). Only messages that changed are sent to the view and re-rendered, markdown is rendered once per
  text, and the composer is its own component, so typing doesn't re-render the conversation
- Permissions (Allow / Always / Deny) and questions (one at a time, Review, Submit) show above the composer.
  Archived sessions hide the composer behind the archived banner
- Dropping a session or a resource row on it pastes the reference into the composer. A session goes in as an
  `@Title` token (sent as the full `@session[Title](id)` mention) and shows as a chip in the sent message
- Tables: as wide as their content up to the chat's width, then they scroll sideways in their own box. Columns are
  sized from their longest cell: short values (`#`, a status) stay compact, labels get a minimum width, prose more

## Terminal

- Key fixes: ⇧↩ new line, ⌘← / ⌘→ line start / end, ⌘⌫ delete to line start (`translateKey()` in
  `src/renderer/TerminalStack.tsx`)
- ⌘-click links to open them in the browser, including URLs wrapped across lines (`src/renderer/wrapped-links.ts`).
  opencode 2.0.26+ opens clicked links itself (plain or ⌘-click), so ctrl leaves its links to the TUI
- Drag a session onto the terminal to paste `@session[Title](id)` (`session[…]` without the `@` in fx, which
  reads `@` as a file); the `read-session` skill lets the agent read it, opencode or fx, from either harness,
  with or without node installed (`src/renderer/ReferenceDrop.tsx`, `skills/read-session`). An fx turn still
  in progress shows with what it did so far
- Drop files from Finder onto the terminal to paste their escaped paths (`src/renderer/ReferenceDrop.tsx`)
- Drag a row from the resources panel onto the terminal to paste its link, or its session mention for a
  referenced session (`src/renderer/ResourcesPanel.tsx`, `src/renderer/ReferenceDrop.tsx`)
- Text size: stepper in settings, ⌘+ / ⌘− / ⌘0
- Joined emoji (🏄‍♂️, 👩‍💻, flags) render as one glyph with the right width (`@xterm/addon-unicode-graphemes`)

## Settings (⌘,)

- One section at a time, picked from a list on the left (General: Appearance, Sessions, Notifications, Shortcuts;
  Integrations: Agents, Tools, Resource adapters, Companion; About). A red dot marks a section that needs you
  (broken opencode service, failing MCP server, CLI check or adapter, update available). Reopening comes back to the last section
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
  (`src/shared/ctrl-instructions.ts`, `syncCtrlInstructions()` in `src/main/opencode.ts`). fx (0.0.17+): new
  sessions start in an agent profile (`fx --profile`) whose prompt holds the space's instructions and the ctrl
  instruction (`~/.fx/agents/ctrl`, `~/.fx/agents/ctrl-<space id>`), rewritten when a space's instructions
  change (`src/main/fx-profiles.ts`)
- fx `session new --prompt` / `session send` to a session without a process pass the prompt to fx as an
  argument (`fx "<prompt>"`, `fx --resume <id> "<prompt>"`) instead of typing it in once fx is ready
- Tools: one list of the MCP servers and CLIs you watch, in `~/.config/ctrl/tools.json` (`src/main/tools/`).
  A broken one gets a sticky toast with its fix button, once per new problem, cleared when it recovers; a red dot
  on Settings → Tools
  - Scan (onboarding's second step, Settings → Tools → Scan, or Scan again at the top of the section, `ctrl tools scan`): finds MCP servers in
    opencode's and fx's configs (`~/.fx/mcp.json` in either its `mcpServers` shape or the opencode-style `mcp`
    shape some MCP installers write), AWS SSO sessions (one check per session, from `~/.aws/config`) and gh, vercel, pup,
    gcloud on PATH. Only adds: lists what you don't watch yet, all checked (Select all / none per group), and
    shows the ones you already watch as "Already watching", with no checkbox. Stop watching one with Remove on its row
  - Users onboarded before tools existed get one toast offering the scan. Until then, opencode's MCP servers are
    watched as before
  - MCP servers, per harness: opencode (status pushed by its service) and fx (`fx mcp list` / `fx mcp show`,
    polled), each only while you use it: opencode once its TUI runs, fx once an fx session is open. A server
    missing from a harness gives one "Set up" toast per harness that adds them (opencode `mcp.add`, `fx mcp add`).
    Sign-in: opencode's `/mcps` through a fix-it prompt, `fx mcp login` run by ctrl
  - CLIs: a check command that exits 0 while the CLI works, run at launch, every 10 minutes (per check), when
    Settings opens and on window focus (broken ones right away). Its fix runs a command (e.g. `aws sso login`, which
    opens the browser, then checks again), opens a page, or types a fix-it prompt into a new session. Add by hand
    (presets or custom), edit, remove, check now
  - tools.json can be edited by hand: ctrl watches it
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

## Worktrees

- A warm pool of git worktrees per repo, so an agent gets a ready checkout (latest base branch, dependencies
  installed) with `ctrl worktree up <repo>`, usually instantly (`src/main/worktrees/`, `src/shared/worktrees.ts`)
- Always attached to a session (the caller's, or `--session`; a subagent's goes to the session it works for).
  A session can hold several, of one repo or many, and isn't tied to any of them: it works in them by path
- Repos register themselves the first time a worktree of one is taken: base branch from origin, setup command
  from the lockfile (pnpm, yarn, bun, npm, cargo, go). A path anywhere inside the repo, or its name, works
- A GitHub repo works too (`ctrl worktree up owner/repo` or its URL): the checkout ctrl manages with that origin,
  else a clone of its own in the worktree folder's `.repos/` (gh, else git), made once
- Add a repo by hand too: Settings → Worktrees → Add a repository (folder picker, then its settings open), or
  `ctrl worktree config <path>`. One added by hand keeps a warm worktree for its first 30 days, used or not
- Pool miss: `up` takes over the pool's build closest to done, else builds one on the spot (`cold: true`). While a
  session waits on a build, no other build of that repo starts, and session builds count toward the 3 at a time
- The build belongs to the app, not to the CLI call: a call that times out (90s by default) or is killed leaves it
  running, and the session's next `up` waits for it or gets its result, even while the first call still waits
  (that one then gets the next worktree). One the session never asks for again, and that's untouched, goes back
  to the pool 10 minutes after it's ready; `ctrl worktree list` in the session makes it the session's for good
- A cold build whose setup command fails is still handed out (`setupFailed`); a warm build that fails is dropped,
  the error shows on the repo, and warm builds of that repo wait 30 minutes. A setup command gets 30 minutes:
  past that its whole process group is killed and the error says it timed out, with the last output under it
- `up --skip-setup`: when it has to be built, a checkout in seconds without running the setup command
  (`setupSkipped`, a "no deps" chip in the resources panel, a line in the hint). A retry with it doesn't wait on a
  full build, these builds don't count toward the pool's build time, and recycling installs them like any other
- `ctrl worktree setup [<id|path>]` runs the repo's setup command in a worktree you hold (skipped or failed setup)
  and clears the marker; a run outlives the call (90s timeout, run it again to keep waiting), shows a "setting up"
  chip, and pauses warm builds of that repo while it runs
- `ctrl worktree down` releases one: refused while it has uncommitted files, commits no remote has, or commits on
  a detached HEAD (`--force` discards; detached commits get a ref under `refs/ctrl/rescue/`)
- Released worktrees are recycled (reset to the base branch, untracked files removed, setup run again, moved to
  a new folder so the old path can't reach it) while the pool has room, removed otherwise. Removing renames the
  folder into `.trash` and deletes it in a child process, so it never blocks. One `rm` per trash folder at a
  time, at background I/O priority (`taskpolicy -b`), its pid in `.trash/.deleting` so a restarted ctrl doesn't
  start a second one on the same files; folders trashed meanwhile get the next `rm` when it exits
- Archiving a session releases its worktrees 30 seconds later (if it's still archived), deleting one right away,
  both without the unsaved-work check
- Worktrees show in the resources panel of the session that holds them (and its space's): repo and branch, path,
  `building` / `detached` / `setup failed` chips; click opens the folder, copy copies the path. Also in
  `ctrl resources list` (type `worktree`) and `worktrees` on `ctrl session get`
- The pool refills on its own: after each take or release and every 10 minutes, ctrl builds up to each repo's
  pool size (2 at a time per repo, 3 overall), recycles released worktrees, removes warm ones past the size once
  a day old, and refreshes one warm worktree per repo when it's over a day old and the base branch moved
- Background jobs, each a row in Settings → Worktrees with a toggle:
  - Size pools from usage: the smallest pool that would have served the last 7 days
    of requests with at most 2% misses, replayed against the repo's measured build time. One for a repo not used
    in a week, none after 30 days, never more than the repo's cap. A repo can be pinned to a size instead
  - Clean up (every hour and after an archive; shows what it last did, Run now): releases worktrees of archived
    and deleted sessions, drops entries whose folder is gone, removes folders in the worktree folder nothing
    tracks (older than an hour)
  - Keep your checkouts up to date (off by default; every hour; shows what it last did, Run now): fetches repos
    used in the last 30 days and fast-forwards your own checkout when it's on its base branch with nothing
    uncommitted
- Settings → Worktrees: the folder (default `~/.ctrl/worktrees`) and every repo with its path, base branch, setup
  command, warm and in-use counts and the share of the last 7 days' requests served instantly. The gear on a
  repo opens its settings: name, base branch, setup command, pool size (auto or fixed), cap, Forget repo
  (`src/renderer/WorktreeSettings.tsx`)
- Each ctrl owns its worktree folder (a marker file in it): a preview or dev run uses its own
  (`~/.ctrl/worktrees-<state folder name>`), and never cleans up another ctrl's worktrees
- The ctrl instruction and the ctrl skill tell agents to take a worktree to work on a repo

## Feedback

- Toasts are the single in-app notification: undo (⌘Z), View, one action button, sticky mode
  (`src/renderer/Toast.tsx`)
- Sidebar banner only when ctrl can't reach opencode / the TUI, or an action failed

## Command line (`ctrl`)

- `ctrl` CLI for agents: JSON in/out, self-describing (`ctrl help --json`, `ctrl docs`), stable error codes
  with hints. Principles and conventions in [CLI.md](CLI.md), every command in [CLI-REFERENCE.md](CLI-REFERENCE.md)
  (`src/cli/cli.ts`, `src/shared/cli/`)
- Worktrees: `worktree up` (take one for a session), `down`, `list` (the session's by default, `--all`), `config`
  (every repo with pool and usage, or add / change / forget one), `prewarm`, `cleanup` (dry run unless `--apply`),
  `update` (run the update job now). Everything in Settings → Worktrees has a command: the folder and the job
  toggles are settings (`worktreeRoot`, `worktreePoolAuto`, `worktreeCleanup`, `worktreeUpdateRepos`)
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
  (`tool.changed` when a watched tool breaks or recovers)
- Tools: `tools list` (MCP servers per harness and CLI checks with their state, so an agent can tell a logged-out
  CLI from a real failure), `tools scan [--apply]`, `tools check`, `tools add` (check + fix command, page or
  session), `tools remove`
- Resources with live details: `resources list` fetches what's due like the panel does (same cache policy,
  only the returned items, window focus not needed), waits up to `--wait` (5s) and marks the rest `pending`;
  `--cached` skips fetching. `resources refresh [<id|url>...]` refetches regardless of the cache, by id, URL or
  scope. Both report adapters that couldn't fetch in `errors` (rate limited with `retryAt`, CLI not set up with
  the fixing command)
- Selectors: `self` (the calling session, via `OPENCODE_SESSION_ID` or ctrl's `CTRL_TERM_ID` in fx ptys, or
  its space for `--space`), `current`, `name:<title>`; ambiguous names list candidates
- A CLI killed before it answers still replies: the launcher prints a JSON error naming the signal, and
  suggests stdin (`--prompt -`) when an argument was long (`bin/ctrl`)
- ctrl quitting or restarting mid-request (an update) gives `APP_NOT_RUNNING` "quit or restarted before it
  answered"; `session wait` instead waits up to a minute for ctrl to come back and asks again with the time
  left of its `--timeout` (`resumes` in `src/shared/cli/commands.ts`, `src/cli/cli.ts`). Right after a launch,
  commands (except `app ...`) wait up to 10s for the harness checks and opencode's first sync, so sessions
  aren't `NOT_FOUND` while they load (`sessionsLoaded` in `src/main/main.ts`)
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
- Previews (`npm run preview`): one dev ctrl per branch, each on a fresh copy of your real state with its own
  state folder, socket and phone port, labelled with the branch in the sidebar and on the phone (`CTRL_LABEL`)
- Dev runs print their phone links (`[ctrl] phone: …`), and stopping `npm run dev` or `npm run preview` quits
  the app too
- Headless mode and debug hooks for test runs: no window, no focus steal (`CTRL_*` env vars, see `docs/DEVELOPMENT.md`)
- README screenshots and GIF regenerated from a throwaway demo opencode, and fx versions from throwaway fx sessions shown next to them (`scripts/demo/`, `--harness fx`, `CTRL_FRAMES` hook)
