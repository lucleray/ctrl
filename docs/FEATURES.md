# Features

Every user-facing feature in ctrl, grouped by area. Keep this list current: when you add, change or
remove a feature, update this file in the same commit. One line per feature, with the main file(s)
where it lives.

## Shell

- One long-lived opencode TUI embedded on the right (xterm.js + node-pty). Switching sessions navigates
  it in place through the bridge plugin, no restart (`src/main/terminal.ts`, `bridge/tui.ts`)
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
- Space settings for new sessions started from ctrl in that space: folder, model (toggle + variant),
  instructions attached as an invisible session instruction (`src/renderer/SpaceSettings.tsx`)
- Status rollup on a space: shows the most urgent status of its sessions (`src/renderer/StatusIcon.tsx`)

## Sessions

- Rename from the sidebar (right-click → Rename)
- Delete (right-click → Delete session), held back until the undo toast expires
- Archive / unarchive: hover button, right-click, ⌘W, or "Archive all sessions" on a space. Stored in
  ctrl's `state.json`, opencode is untouched (`src/main/store.ts`)
- **Recents**: every non-archived session, newest first, 10 at a time with Show more, foldable (state saved)
- **Archived**: most recently archived first, 10 at a time with Show more, foldable (state saved)
- Status per row, most urgent first: needs input (permission / question), running, failed (unread),
  finished (unread), otherwise time since last update (`src/renderer/StatusIcon.tsx`)
- Sidebar list patched from opencode events instead of re-listing (`src/main/opencode.ts`)

## Navigation & search

- ⌘1–9 jumps to the Nth visible session; hold ⌘ to show number badges (`src/renderer/jump.ts`)
- ⌘P / ⌘K search palette: session titles (in memory) + full-text over message content via a SQLite FTS5
  index built in a utility process (`src/renderer/Palette.tsx`, `src/indexer/indexer.ts`, `src/main/search-db.ts`)
- ⌘N new chat in your home folder, ⌘T new session in the current session's folder and space
- Search and settings icons at the top of the sidebar

## Resources panel

- Floating card over the terminal's top-right corner (⇧⌘R) listing links shared in the current session or its whole space: PRs, issues,
  commits, repos, Linear, Notion, Slack, Vercel deployments/projects. Shown by default, resizable
  (`src/renderer/ResourcesPanel.tsx`)
- Resource adapters, one file per service in `src/shared/adapters/`, registered in `adapters/index.ts`: each
  declares the link types it recognizes (URL → canonical key, icon, offline title) and, optionally, a `live`
  part that fetches details through the service's own CLI (ctrl never handles tokens). Live results are
  display-ready (title, subtitle, tone, chips) and carry a cache policy (max age, refetch when mentioned
  again); one scheduler fetches only while the panel is open and the window focused, and caches on disk
  (`src/main/adapters/service.ts`). Settings → Resource adapters lists them, with CLI status and an on/off
  toggle for live ones
  - GitHub (live, `gh api graphql`, ~40 per request): PR state, CI, reviews, conflicts; merged PRs are final
  - Vercel (live, `vercel api`): deployment commit/branch/build state (15s while building), projects' latest production
  - Slack (live, `slack-cli`): thread root message, channel, author; channel names; kept until mentioned again
  - Linear, Notion: links only

## Terminal

- Key fixes: ⇧↩ new line, ⌘← / ⌘→ line start / end, ⌘⌫ delete to line start (`translateKey()` in
  `src/renderer/TerminalView.tsx`)
- ⌘-click links to open them in the browser, including URLs wrapped across lines (`src/renderer/wrapped-links.ts`)
- Drag a session onto the terminal to paste `@session[Title](ses_…)`; the `read-session` skill lets the
  agent read it (`src/renderer/ReferenceDrop.tsx`, `skills/read-session`)
- Drop files from Finder onto the terminal to paste their escaped paths (`src/renderer/ReferenceDrop.tsx`)
- Text size: stepper in settings, ⌘+ / ⌘− / ⌘0

## Settings (⌘,)

- Appearance: system / light / dark (`src/renderer/Settings.tsx`)
- opencode TUI theme (built-in and custom themes)
- Terminal text size
- Default model for new sessions (toggle, searchable picker grouped by provider, variant picker)
  (`src/renderer/ModelPicker.tsx`)
- MCP servers status, with a sticky toast + Fix button when one fails or needs auth
- Rebindable shortcuts (`src/renderer/ShortcutSettings.tsx`, `src/shared/shortcuts.ts`)
- Notifications: dock badge with sessions waiting on you, macOS notifications when a background session
  needs you / finishes / fails (both toggleable) (`src/main/attention.ts`)
- Resizable sidebar (200–520px, double-click edge to reset), width saved (`src/renderer/ResizeHandle.tsx`)

## Feedback

- Toasts are the single in-app notification: undo (⌘Z), View, one action button, sticky mode
  (`src/renderer/Toast.tsx`)
- Sidebar banner only when ctrl can't reach opencode / the TUI, or an action failed

## App & dev

- App name **ctrl** and dot-matrix `c_` icon (`build/icon.svg`, `scripts/icon.mjs`)
- Packaged macOS app: `npm run install-app`; loads the login shell env at startup (`scripts/package.mjs`,
  `src/main/shell-env.ts`)
- Dev runs use a separate `ctrl-dev` state dir, so dev and installed app run side by side
- Headless mode and debug hooks for test runs: no window, no focus steal (`CTRL_*` env vars, see README)
