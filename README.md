# ctrl

A Codex-style desktop shell around the opencode TUI: sidebar with **spaces** (named groups of sessions) and a
single embedded opencode TUI on the right.

```text
┌─ Electron main ─────────────────────────────────────────┐
│ @opencode/client ──► background service (sessions, SSE) │
│ state.json       ──► spaces + session→space assignments │
│ node-pty         ──► `opencode` TUI (one process)       │
│ ws://127.0.0.1:N ◄─► bridge plugin inside the TUI       │
└─────────────────────────────────────────────────────────┘
        ▲ IPC                                  │ navigate / route
┌─ renderer ─────────────┐               ┌─ bridge/tui.ts ──────┐
│ React sidebar + xterm  │               │ router.navigate(...) │
└────────────────────────┘               └──────────────────────┘
```

- Switching sessions sends `{type:"navigate"}` to the bridge, so the TUI swaps in place (no restart).
- The bridge reports route changes back, so the sidebar highlight follows navigation done inside the TUI.
- The bridge is injected only into the embedded TUI via `OPENCODE_CLI_CONFIG_CONTENT` (tabs are turned off there too).
- The sidebar's session list (`src/main/opencode.ts`) does one full sync on launch and whenever the event stream
  reconnects. After that, events patch it in memory (renames, moves, deletes, views, permissions, questions), or
  re-read only the session they're about (created, run started/ended), so an update costs the same with 50 or
  5,000 sessions.
- Spaces live in `~/Library/Application Support/ctrl/state.json`. Sessions without a space still show under **Recents**, which lists every non-archived session (foldable, 10 at a time).

## Principles

- **Fast.** Everything you touch responds instantly. Heavy work (fetching, parsing, indexing) stays off the main
  process, which relays every keystroke and byte of TUI output. Trade completeness for speed when needed, and
  write the compromise down next to the code.
- **Scalable.** ctrl must not get slower as sessions pile up. Work is proportional to what changed, not to how
  much history exists, and queries touch a bounded number of rows. When adding a feature, ask how it behaves with
  10× the sessions.

## Search

⌘P matches session titles instantly (in memory) and message text through a local full-text index.

```text
opencode ──events──► indexer (utility process) ──writes──► search.db (SQLite FTS5, WAL)
   ▲   └─ messages newer than each session's watermark            │
   └────────────── session.list on launch (catch-up)              ▼
                              main: read-only connection ◄── ⌘P query (~1ms)
```

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

## Run

```bash
npm install
npm run dev     # vite + esbuild watch + electron
npm start       # production build + electron
npm run package       # build release/mac-*/ctrl.app (ad-hoc signed)
npm run install-app   # build + replace /Applications/ctrl.app (restarts it if running)
```

The packaged app loads your login shell's environment at startup (Finder
launches get a bare PATH), and ships the bridge plugin unbundled in
`Contents/Resources/bridge` since opencode can't read inside `app.asar`. The
installed app keeps its state in `~/Library/Application Support/ctrl`; dev runs
use `ctrl-dev` next to it (seeded from a copy of the real state on first run),
so both can run side by side.

## Usage

- **+** next to Spaces: create a space
- Drag sessions between spaces, or onto **Recents** to unassign
- Hover a space: **+** new session in it, **⋯** for rename / space settings / delete
- Double-click a space to rename
- Right-click a session: move to / delete
- **Space settings** apply to new sessions started from ctrl in that space:
  - folder: where they start (defaults to `~`)
  - model (toggle): passed to `session.create`. Off falls back to **Settings → Custom model**; when that's
    off too, ctrl passes no model and opencode picks
  - instructions: attached as a session instruction entry (`ctrl.space`), invisible in the chat
    but part of the model's context on every turn
- ⌘1–9 jumps to the Nth visible session; hold ⌘ to see the numbers
- Drag a session onto the terminal to reference it: ctrl pastes `@session[Title](ses_…)` and
  the `read-session` skill (`skills/read-session`, symlinked into `~/.agents/skills`) lets the
  agent read its context via `node digest.mjs <id>`
- ⌘P search · ⌘N new chat · ⌘T new session in the current session's folder and space ·
  ⌘W archive the current session · ⌘, settings. All rebindable in **Settings → Shortcuts**
  (`src/shared/shortcuts.ts`)
- Archive, archive all, delete space and delete session show an undo toast (⌘Z while it's up).
  Session deletes are held back until the toast expires (or ctrl quits), since opencode can't
  restore them

## Debug hooks

Any of these runs the app headless: hidden window, no dock icon, never takes focus
(force it with `CTRL_HEADLESS=1`).

- `CTRL_USER_DATA=/tmp/x` use a throwaway state dir
- `CTRL_EVAL='...'` run JS in the renderer 3s after load
- `CTRL_SCREENSHOT=/tmp/shot.png CTRL_SCREENSHOT_DELAY=8000` capture the window
- `CTRL_SEND='["space:settings","spc_x"]'` send a main → renderer event 2s after load
- `CTRL_INPUT='[[4000,"keyDown","Meta",["meta"]]]'` replay real keyboard input (ms after window creation)
