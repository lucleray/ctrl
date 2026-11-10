# Harnesses

ctrl runs two coding agents, called harnesses: [opencode](https://opencode.ai) and [fx](https://fx.sh).
Sessions of both kinds sit side by side in the sidebar, in Recents and inside the same space.

- **Pick the harness for new sessions** on the welcome screen at first launch, or later in
  **Settings → Sessions → Harness**. A space can override it in
  its space settings. The space ⋯ menu also offers a new session with the other harness.
- **Only one needs to be installed.** ctrl shows the sessions of whichever harnesses it finds.
  **Settings → Sessions** shows what's installed, with the install command for what isn't.
- **fx sessions have an `fx` tag** in the sidebar. opencode sessions have no tag.

## How each one runs

```text
opencode: 1 TUI ◄── bridge plugin "navigate to ses_x" ──► opencode service
          (switched in place)                              (owns sessions + running turns)
fx:       1 pty per open session: `fx resume --id <id>`, up to 12 live
          (no server, no plugin API: ctrl reads ~/.fx/sessions)
```

The difference comes from the harnesses themselves. opencode has a background service and a plugin API,
so ctrl can drive one TUI and read live state. fx is a single process per session with files on disk,
so ctrl keeps a process per open session and reads its files and terminal output.

## Support table

✅ supported · ⚠️ partial · ⏳ waiting on the harness · ❌ not supported

| Feature | opencode | fx | Notes |
|---|---|---|---|
| Sessions in the sidebar, spaces, Recents | ✅ | ✅ | opencode: sessions idle for 30+ days show once the Archived section opens, the palette searches or a CLI command runs |
| Mix both kinds in one space | ✅ | ✅ | |
| Archive / unarchive | ✅ | ✅ | ctrl-side; archiving also marks the session read |
| Archived sessions open read-only | ✅ | ✅ | scrolling still works; Unarchive in the bar unlocks it |
| Move between spaces, drag and drop | ✅ | ✅ | |
| Child sessions (tree in the sidebar, `--parent`) | ✅ | ✅ | ctrl-side · fx: a new child gets its parent once fx reports its id |
| ⌘1–9 jump, ⌘P title search | ✅ | ✅ | |
| ⌘P message search | ✅ | ✅ | opencode: through the service · fx: tails `events.jsonl` |
| Resources panel (links per session / space) | ✅ | ✅ | Same index as search |
| Referenced sessions in Resources | ✅ | ✅ | fx references show once fx writes the turn to disk |
| ctrl Companion (sessions that mentioned what's on screen) | ✅ | ✅ | Same index as search |
| New session from screen (⌃⌥⌘Space, or the companion's New button) | ✅ | ✅ | opencode: new-session screen with the link typed in; fx: a new session, typed in once ready |
| Links and search updated during a turn | ⚠️ | ⚠️ | opencode: links in your prompt right away, the agent's at the end of the turn · fx: everything at the end of the turn, since fx only saves a turn (your prompt included) once it's done |
| Rename | ✅ | ⚠️ | fx rewrites its title while it runs, so the rename is written once no fx process has the session |
| Delete | ✅ | ✅ | fx: the session folder goes to the Trash |
| New session in a space's folder | ✅ | ✅ | |
| Harness per space / app default | ✅ | ✅ | |
| Custom model per space / app default | ✅ | ✅ | Picked separately per harness · fx: `--model` and `--effort` |
| Variant / effort picker | ✅ | ⏳ | fx: waiting on a release with [vercel-labs/fx#1171](https://github.com/vercel-labs/fx/pull/1171) (merged after v0.0.13), which adds each model's `efforts` to `fx models --json`. ctrl already reads it, so the picker fills in after `fx upgrade`. Until then, set it with the CLI: `--fx-model "<model>#<effort>"` |
| Space instructions | ✅ | ❌ | fx has no way to take extra instructions for a session |
| ctrl instructions (agent knows it's in ctrl) | ✅ | ❌ | Same reason. fx agents still find `ctrl` through the `ctrl` skill |
| Switching sessions | ✅ instant | ⚠️ | fx: instant once open, about 1s the first time (`fx resume`) |
| Many sessions open at once | ✅ | ⚠️ | fx: up to 12 live processes, the least recently used idle ones are closed past that |
| Turns keep running when ctrl quits | ✅ | ❌ | fx has no background service: quitting stops the turn, send `continue` after reopening |
| Sessions open at quit come back | ✅ | ⚠️ | fx: reopened at launch (`fx resume`), with a compact transcript instead of the full screen |
| Status: running | ✅ | ✅ | fx: OSC 7501 status reports, else `recovery.json` (the turn in progress) or the last line of `events.jsonl` |
| Status: needs you (permission, question) | ✅ | ⚠️ | fx: only for sessions open in ctrl, with an fx that sends OSC 7501 (0.0.13 doesn't) |
| Status: failed | ✅ | ⚠️ | fx: only for sessions open in ctrl, with an fx that sends OSC 7501 (0.0.13 doesn't) |
| `ctrl session read` of a turn in progress | ✅ | ✅ | fx: from `recovery.json`, since fx logs a turn only once it ends |
| Status: finished, unread | ✅ | ✅ | fx: read state kept by ctrl |
| Background shells and subagents (sidebar icon once the turn is over) | ✅ | ❌ | opencode: shell events + subagent sessions; shells already running at launch are found in the folders of sessions updated in the last 6 hours · fx: doesn't expose them |
| Background shells and subagents in the prompt footer | ✅ | ❌ | opencode's own TUI shows `1 subagent · 1 shell` before context and cost |
| Status of sessions that aren't open | ✅ live | ⚠️ | fx: read from files on disk |
| Notifications, sounds, dock badge | ✅ | ⚠️ | Same as status: fx's "needs you" and "failed" only for open sessions. fx's own sounds are turned off (`FX_SOUND=off`) |
| Sessions open in another terminal | ✅ | ⚠️ | fx allows one process per session: shown, but ctrl can't open or delete them until that fx quits |
| Reference a session (drag onto the terminal) | ✅ | ✅ | Works across harnesses, with the `read-session` skill |
| Drop files from Finder | ✅ | ✅ | |
| Drag a resource onto the terminal | ✅ | ✅ | Pastes its link, or its session mention |
| ⌘-click links, wrapped URLs | ✅ | ✅ | opencode 2.0.26+ opens clicked links itself (a plain click works too), ctrl only handles them for older versions |
| Theme for the terminal | ✅ | ⚠️ | fx follows ctrl's light/dark; pick an fx theme in `~/.fx/settings.json` |
| MCP server status and Fix | ✅ | ❌ | opencode's MCP servers only |
| `/new`, `/resume` inside the terminal followed by the sidebar | ✅ | ✅ | |
| `ctrl` CLI: list, file, archive, focus, rename, reference, read | ✅ | ✅ | [CLI.md](CLI.md) |
| `ctrl` CLI: `self` | ✅ | ✅ | opencode: `OPENCODE_SESSION_ID` · fx: `CTRL_TERM_ID`, only in fx processes ctrl runs |
| `ctrl session new` | ✅ | ⚠️ | fx: waits up to 15s for fx to report the new session's id |
| `ctrl session send` | ✅ background | ⚠️ | fx: typed into its fx process (started in the background), CONFLICT when open in another terminal |
| `ctrl` typing without sending (`--no-submit`, `reference`) | ⚠️ | ✅ | opencode: one TUI, so the session must be on screen (`--focus`) |
| `ctrl session stop` | ✅ | ⚠️ | fx: Escape to its fx process, only for sessions open in ctrl |
| Remote control: chat on the phone | ✅ | ❌ | fx sessions are listed (rename, move, archive) but open on the Mac only |
| Chat view on the desktop (Settings → Appearance) | ✅ | ❌ | fx has no chat API: fx sessions keep their terminal |
| Welcome screen | ✅ | ✅ | First launch: shows what's installed, lets you pick when both are, install commands when neither is |

## Adding a harness

Everything ctrl reads from a harness goes through `HarnessSource` in `src/main/harness.ts`. Only the
required part is needed to see its sessions; each optional capability turns on one piece of UI, and is
simply hidden for harnesses that don't implement it.

1. **Id and name:** add it to `Harness` and `HARNESSES` in `src/shared/types.ts`, with an id prefix like
   fx's (`harnessOf()`), so its sessions don't collide with opencode's.
2. **Sessions (required):** a class implementing `HarnessSource` (`sessions`, `problem`), listed in
   `harnesses()` in `src/main/main.ts`. `src/main/fx.ts` is the smallest example.
3. **Terminal:** how a session opens on the right, like `src/main/fx-terminals.ts`.
4. **Optional capabilities**, any time later, one by one:
   - `activity()`: background shells and subagents per session (sidebar icon).
5. **Support table** above: add a column and fill in what works.
