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
- Spaces live in `~/Library/Application Support/ctrl/state.json`. Sessions without a space show under **Recents** (foldable; fold state is saved).

## Run

```bash
npm install
npm run dev     # vite + esbuild watch + electron
npm start       # production build + electron
```

## Usage

- **+** next to Spaces: create a space
- Drag sessions between spaces, or onto **Recents** to unassign
- Hover a space: **+** new session in it, **⋯** for rename / set folder / delete
- Double-click a space to rename
- Right-click a session: move to / delete
- A space's folder is the directory new sessions start in (defaults to `~`)

## Debug hooks

Any of these runs the app headless: hidden window, no dock icon, never takes focus
(force it with `CTRL_HEADLESS=1`).

- `CTRL_USER_DATA=/tmp/x` use a throwaway state dir
- `CTRL_EVAL='...'` run JS in the renderer 3s after load
- `CTRL_SCREENSHOT=/tmp/shot.png CTRL_SCREENSHOT_DELAY=8000` capture the window
