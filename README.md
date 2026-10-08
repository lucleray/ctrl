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
- Spaces live in `~/Library/Application Support/ctrl/state.json`. Sessions without a space still show under **Recents**, which lists every non-archived session (foldable, 10 at a time).

## Run

```bash
npm install
npm run dev     # vite + esbuild watch + electron
npm start       # production build + electron
```

## Usage

- **+** next to Spaces: create a space
- Drag sessions between spaces, or onto **Recents** to unassign
- Hover a space: **+** new session in it, **⋯** for rename / space settings / delete
- Double-click a space to rename
- Right-click a session: move to / delete
- **Space settings** apply to new sessions started from ctrl in that space:
  - folder: where they start (defaults to `~`)
  - model: passed to `session.create` (defaults to opencode's default)
  - instructions: attached as a session instruction entry (`ctrl.space`), invisible in the chat
    but part of the model's context on every turn
- ⌘1–9 jumps to the Nth visible session; hold ⌘ to see the numbers
- Drag a session onto the terminal to reference it: ctrl pastes `@session[Title](ses_…)` and
  the `read-session` skill (`skills/read-session`, symlinked into `~/.agents/skills`) lets the
  agent read its context via `node digest.mjs <id>`
- ⌘P search · ⌘N new chat · ⌘, settings

## Debug hooks

Any of these runs the app headless: hidden window, no dock icon, never takes focus
(force it with `CTRL_HEADLESS=1`).

- `CTRL_USER_DATA=/tmp/x` use a throwaway state dir
- `CTRL_EVAL='...'` run JS in the renderer 3s after load
- `CTRL_SCREENSHOT=/tmp/shot.png CTRL_SCREENSHOT_DELAY=8000` capture the window
- `CTRL_SEND='["space:settings","spc_x"]'` send a main → renderer event 2s after load
- `CTRL_INPUT='[[4000,"keyDown","Meta",["meta"]]]'` replay real keyboard input (ms after window creation)
