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
- Space settings for new sessions started from ctrl in that space: folder, harness, model (toggle + variant,
  one per harness), instructions attached as an invisible session instruction (opencode only)
  (`src/renderer/SpaceSettings.tsx`)
- Status rollup on a space: shows the most urgent status of its sessions (`src/renderer/StatusIcon.tsx`)

## Sessions

- Rename from the sidebar (right-click → Rename). fx: writes `session.json` (0600) once no fx process has
  the session, the new title waits in `state.json` until then
- Delete (right-click → Delete session), held back until the undo toast expires. fx: the session folder goes
  to the Trash
- fx: right-click → Reveal session folder, Quit fx process
- Archive / unarchive: hover button, right-click, ⌘W, or "Archive all sessions" on a space. Stored in
  ctrl's `state.json`, opencode is untouched (`src/main/store.ts`)
- **Recents**: every non-archived session, newest first, 10 at a time with Show more, foldable (state saved)
- **Archived**: most recently archived first, 10 at a time with Show more, foldable (state saved)
- Status per row, most urgent first: needs input (permission / question), running, failed (unread),
  finished (unread), otherwise time since last update (`src/renderer/StatusIcon.tsx`). fx: from OSC 7501
  reports of the processes ctrl runs, else the last line of `events.jsonl`; read state kept by ctrl
  (`src/main/fx.ts`)
- Sidebar list patched from opencode events instead of re-listing (`src/main/opencode.ts`); fx sessions
  from one scan of `~/.fx/sessions`, then an fs watcher re-reads only the folder that changed (`src/main/fx.ts`)

## Navigation & search

- ⌘1–9 jumps to the Nth visible session; hold ⌘ to show number badges (`src/renderer/jump.ts`)
- ⌘P / ⌘K search palette: session titles (in memory) + full-text over message content via a SQLite FTS5
  index built in a utility process, for both harnesses (fx: tails each `events.jsonl` by byte offset)
  (`src/renderer/Palette.tsx`, `src/indexer/indexer.ts`, `src/main/search-db.ts`)
- ⌘N new chat in your home folder, ⌘T new session in the current session's folder, space and harness
- Search and settings icons at the top of the sidebar

## Resources panel

- Floating card over the terminal's top-right corner (⇧⌘R) listing links shared in the current session or its whole space: PRs, issues,
  commits, repos, Linear, Notion, Slack, Vercel deployments/projects. Shown by default, resizable,
  hidden while Settings or space settings are open (`src/renderer/ResourcesPanel.tsx`)
- Resource adapters, one file per service in `src/shared/adapters/`, registered in `adapters/index.ts`: each
  declares the link types it recognizes (URL → canonical key, icon, offline title) and, optionally, a `live`
  part that fetches details through the service's own CLI (ctrl never handles tokens). Live results are
  display-ready (title, subtitle, tone, chips) and carry a cache policy (max age, refetch when mentioned
  again); one scheduler fetches only while the panel is open and the window focused, and caches on disk
  (`src/main/adapters/service.ts`). Settings → Resource adapters lists them with a status
  dot (CLI checked on launch and when Settings opens: ready, not installed, not logged in), a mode select
  (Off hides its links, Links only, Live details) and, when the CLI isn't set up, a copyable agent prompt to
  install and log it in, plus Check again
  - GitHub (live, `gh api graphql`, ~40 per request): PR state, CI, reviews, conflicts; merged PRs are final
  - Vercel (live, `vercel api`): deployment commit/branch/build state (15s while building), projects' latest production
  - Slack (live, `slack-cli`): thread root message, channel, author; channel names; kept until mentioned again
  - Linear, Notion: links only

## Terminal

- Key fixes: ⇧↩ new line, ⌘← / ⌘→ line start / end, ⌘⌫ delete to line start (`translateKey()` in
  `src/renderer/TerminalStack.tsx`)
- ⌘-click links to open them in the browser, including URLs wrapped across lines (`src/renderer/wrapped-links.ts`)
- Drag a session onto the terminal to paste `@session[Title](id)` (`session[…]` without the `@` in fx, which
  reads `@` as a file); the `read-session` skill lets the agent read it, opencode or fx, from either harness,
  with or without node installed (`src/renderer/ReferenceDrop.tsx`, `skills/read-session`)
- Drop files from Finder onto the terminal to paste their escaped paths (`src/renderer/ReferenceDrop.tsx`)
- Text size: stepper in settings, ⌘+ / ⌘− / ⌘0
- Joined emoji (🏄‍♂️, 👩‍💻, flags) render as one glyph with the right width (`@xterm/addon-unicode-graphemes`)

## Settings (⌘,)

- Appearance: system / light / dark (`src/renderer/Settings.tsx`)
- opencode TUI theme (built-in and custom themes)
- Terminal text size
- Sessions: harness for new sessions, what's installed, default model per harness (toggle, searchable
  picker grouped by provider, variant / effort picker) (`src/renderer/ModelPicker.tsx`)
- MCP servers status, with a sticky toast + Fix button when one fails or needs auth
- Rebindable shortcuts (`src/renderer/ShortcutSettings.tsx`, `src/shared/shortcuts.ts`)
- Notifications: dock badge with sessions waiting on you, macOS notifications when a background session
  needs you / finishes / fails (both toggleable) (`src/main/attention.ts`)
- Sounds when a session needs you / fails / finishes: on/off, a macOS system sound or your own audio file per
  event (or None), preview button, optional "also when ctrl is focused". One sound per burst (most urgent wins),
  played with `afplay`, and it replaces the system notification sound (`src/main/sound.ts`)
- Agent skill: install / uninstall read-session, with its status
- About: ctrl's version, update status, Check for updates / Update and restart
- Resizable sidebar (200–520px, double-click edge to reset), width saved (`src/renderer/ResizeHandle.tsx`)

## Feedback

- Toasts are the single in-app notification: undo (⌘Z), View, one action button, sticky mode
  (`src/renderer/Toast.tsx`)
- Sidebar banner only when ctrl can't reach opencode / the TUI, or an action failed

## Install & updates

- Install with one curl command: latest release → `/Applications`, not quarantined (`install.sh`)
- Setup screen instead of the terminal when neither harness is usable (opencode missing or older than
  `MIN_OPENCODE`, and no fx), with the
  install / upgrade command to copy; checks again on Check again or when the window regains focus
  (`src/renderer/OpencodeSetup.tsx`, `src/main/opencode-bin.ts`)
- Updates from GitHub Releases through GitHub's public API, no login: checked at launch and every 6h, sticky toast with Update, which
  downloads, swaps the app bundle once ctrl quits and relaunches. Settings → About shows the version
  and a manual check (`src/main/updater.ts`)
- read-session skill: offered in a toast at first launch and when a session is referenced without it,
  installed into `~/.config/opencode/skills` from Settings → Agent skill (install / uninstall), refreshed
  when ctrl's copy changes, and copies ctrl didn't make are left alone (`src/main/skill.ts`)
- arm64 and x64 builds, published with `npm run release` (`scripts/package.mjs`, `scripts/release.mjs`)

## App & dev

- App name **ctrl** and dot-matrix `c_` icon (`build/icon.svg`, `scripts/icon.mjs`)
- Packaged macOS app: `npm run install-app`; loads the login shell env at startup, with common bin folders
  added to PATH if that fails (`scripts/package.mjs`, `src/main/shell-env.ts`)
- Dev runs use a separate `ctrl-dev` state dir, so dev and installed app run side by side
- Headless mode and debug hooks for test runs: no window, no focus steal (`CTRL_*` env vars, see `docs/DEVELOPMENT.md`)
- README screenshots and GIF regenerated from a throwaway demo opencode (`scripts/demo/`, `CTRL_FRAMES` hook)
