# Harnesses

ctrl runs two coding agents, called harnesses: [opencode](https://opencode.ai) and [fx](https://fx.sh).
Sessions of both kinds sit side by side in the sidebar, in Recents and inside the same space.

- **Pick the harness for new sessions** on the welcome screen at first launch, or later in
  **Settings → Sessions → Harness**. A space can override it in
  its space settings. The space ⋯ menu also offers a new session with the other harness.
- **fx 0.0.17 or newer** for everything below. Older fx still lists and opens, without profiles (instructions)
  or prompts passed as arguments.
- **Only one needs to be installed.** ctrl shows the sessions of whichever harnesses it finds.
  **Settings → Sessions** shows what's installed, with the install command for what isn't.
- **fx sessions have an `fx` tag** in the sidebar. opencode sessions have no tag.

## How each one runs

```text
opencode: 1 TUI ◄── bridge plugin "navigate to ses_x" ──► opencode service
          (switched in place)                              (owns sessions + running turns)
fx:       1 pty per open session: `fx --resume <id>`, up to 12 live
          (no server, no plugin API: ctrl reads ~/.fx/sessions, asks `fx sessions --live`)
fx chat:  1 `fx acp` process per open session (Agent Client Protocol over its stdio), same cap
          (ctrl sends prompts and answers permissions; fx streams the reply; src/main/fx-chat.ts)
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
| New sessions listed before their first message, kept across restarts | ✅ | ✅ | opencode creates them right away · fx writes a session at its first prompt: ctrl lists it until then (src/main/unstarted.ts), and starts a fresh fx for it when its process is gone |
| Drafts per session (chat view), pencil in the sidebar | ✅ | ✅ | ctrl-side; terminal sessions keep what's typed in their own TUI |
| Archive / unarchive | ✅ | ✅ | ctrl-side; archiving also marks the session read |
| Archived sessions open read-only | ✅ | ✅ | scrolling still works; Unarchive in the bar unlocks it |
| Move between spaces, drag and drop | ✅ | ✅ | |
| Child sessions (tree in the sidebar, `--parent`) | ✅ | ✅ | ctrl-side · fx: kept under the new session's placeholder until fx reports its id (at its first prompt) |
| ⌘1–9 jump, ⌘P title search | ✅ | ✅ | |
| ⌘P message search | ✅ | ✅ | opencode: through the service · fx: tails each session's log |
| Resources panel (links per session / space) | ✅ | ✅ | Same index as search |
| Worktrees (`ctrl worktree up`, shown as resources, released on archive) | ✅ | ✅ | ctrl-side · opencode: the ctrl instruction tells agents to take one, and a subagent's goes to its root session · fx: agents learn it from the ctrl skill only |
| Referenced sessions in Resources | ✅ | ✅ | |
| ctrl Companion (sessions that mentioned what's on screen) | ✅ | ✅ | Same index as search |
| New session from screen (⌃⌥⌘Space, or the companion's New button) | ✅ | ✅ | opencode: new-session screen with the link typed in; fx: a new session, typed in once ready |
| Links and search updated during a turn | ⚠️ | ✅ | opencode: links in your prompt right away, the agent's at the end of the turn · fx: each step as fx logs it (within ~5s) |
| Rename | ✅ | ⚠️ | fx 0.0.17 keeps titles in a log only fx writes, so ctrl keeps the rename (fx's own `/resume` picker still shows fx's title). Older sessions: written once no fx process has the session |
| Delete | ✅ | ✅ | fx: the session folder (and its subagents') goes to the Trash |
| New session in a space's folder | ✅ | ✅ | |
| Harness per space / app default | ✅ | ✅ | |
| Custom model per space / app default | ✅ | ✅ | Picked separately per harness · fx: `--model` and `--effort` |
| Variant / effort picker | ✅ | ✅ | fx: each model's `efforts` from `fx models --json` |
| Space instructions | ✅ | ⚠️ | fx: an agent profile per space (`~/.fx/agents/ctrl-<space id>`, `fx --profile`). An edit reaches its sessions the next time fx opens them; a session moved to another space keeps its first space's |
| ctrl instructions (agent knows it's in ctrl) | ✅ | ⚠️ | fx: in the same profile (or `~/.fx/agents/ctrl`), from creation: turning it off later doesn't reach sessions started with it |
| Switching sessions | ✅ instant | ⚠️ | fx: instant once open, about 1s the first time (`fx --resume`) |
| Many sessions open at once | ✅ | ⚠️ | fx: up to 12 live processes, the least recently used idle ones are closed past that |
| Turns keep running when ctrl quits | ✅ | ⚠️ | fx has no background service: quitting stops the turn. Sessions that were open come back at launch, and fx sends the interrupted request again on its own |
| Sessions open at quit come back | ✅ | ⚠️ | fx: reopened at launch (`fx --resume`), with a compact transcript instead of the full screen |
| Status: running | ✅ | ✅ | fx: OSC 7501 status reports, else `recovery.json` (the turn in progress) or the last line of `events.jsonl` |
| Status: needs you (permission, question) | ✅ | ⚠️ | fx: only for sessions open in ctrl (OSC 7501 status reports) |
| Status: failed | ✅ | ⚠️ | fx: only for sessions open in ctrl (OSC 7501 status reports) |
| `ctrl session read` of a turn in progress | ✅ | ✅ | fx: logs each step as it happens |
| Status: finished, unread | ✅ | ✅ | fx: read state kept by ctrl |
| Background shells and subagents (sidebar icon once the turn is over) | ✅ | ⚠️ | opencode: shell events + subagent sessions; shells already running at launch are found in the folders of sessions updated in the last 6 hours · fx: subagents from `fx sessions --live`; its background shells aren't exposed |
| A message sent mid-turn moves the shell or subagent holding the turn to the background (chat view, phone) | ✅ | ❌ | opencode: `session.background`, the TUI's own ⌃B, after 3 seconds · fx: no chat view (in its terminal, fx 0.0.17 moves a running shell to the background itself when you steer) |
| List the shells and subagents still running, and stop one (chat view: click the count under the composer) | ✅ | ❌ | opencode: `shell.remove`, `session.interrupt` on the subagent · fx: no chat view, and no way to stop a subagent from outside (its agent list, ⌃X, does it in the terminal) |
| Background shells and subagents in the prompt footer | ✅ | ❌ | opencode's own TUI shows `1 subagent · 1 shell` before context and cost; the chat view shows them after |
| Status of sessions that aren't open | ✅ live | ⚠️ | fx: from its logs and `fx sessions --live` (running, finished), polled every 2s |
| Notifications, sounds, dock badge | ✅ | ⚠️ | Same as status: fx's "needs you" and "failed" only for open sessions. fx's own sounds are turned off (`FX_SOUND=off`) |
| Sessions open in another terminal | ✅ | ⚠️ | fx allows one process per session: shown, but ctrl can't open or delete them until that fx quits |
| Skills audit (Settings → Skills) | ✅ | ✅ | `skillFolders()`: opencode reads `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`; fx also `~/.fx/skills`, which opencode doesn't |
| Reference a session (drag onto the terminal) | ✅ | ✅ | Works across harnesses, with the `read-session` skill |
| Drop files from Finder | ✅ | ✅ | |
| Drag a resource onto the terminal | ✅ | ✅ | Pastes its link, or its session mention |
| ⌘-click links, wrapped URLs | ✅ | ✅ | opencode 2.0.26+ opens clicked links itself (a plain click works too), ctrl only handles them for older versions |
| Theme for the terminal | ✅ | ⚠️ | fx follows ctrl's light/dark; pick an fx theme in `~/.fx/settings.json` |
| MCP servers: scan, status, set up, sign in | ✅ | ✅ | opencode: its service pushes status, sign-in through `/mcps`. fx: `fx mcp list` / `show` polled only while an fx session is open, `fx mcp add` / `login` run by ctrl |
| CLI checks (Settings → Tools) | ✅ | ✅ | ctrl runs them; a `session` fix types its prompt into the opencode TUI |
| `/new`, `/resume` inside the terminal followed by the sidebar | ✅ | ✅ | |
| `ctrl` CLI: list, file, archive, focus, rename, reference, read | ✅ | ✅ | [CLI.md](CLI.md) |
| `ctrl` CLI: `self` | ✅ | ✅ | opencode: `OPENCODE_SESSION_ID` · fx: `CTRL_TERM_ID`, only in fx processes ctrl runs |
| `ctrl session new` | ✅ | ⚠️ | fx creates a session at its first prompt: with `--prompt` (passed as an argument) the id comes in a second or two, without it the reply is `pending` until you type |
| `ctrl session send` | ✅ background | ⚠️ | fx: typed into its running fx process, or passed to a new one (`fx --resume <id> "<prompt>"`, in the background); CONFLICT when open in another terminal |
| `ctrl` typing without sending (`--no-submit`, `reference`) | ⚠️ | ✅ | opencode: one TUI, so the session must be on screen (`--focus`) |
| `ctrl session stop` | ✅ | ⚠️ | fx: Escape to its fx process, only for sessions open in ctrl |
| Remote control: chat on the phone | ✅ | ⚠️ | fx: sessions created as a chat open on the phone like opencode ones; terminal ones are listed (rename, move, archive) but open on the Mac only |
| Chat view on the desktop (Settings → Appearance) | ✅ | ⚠️ | opencode: any session, switched any time, the TUI underneath. fx: a session is a chat one or a terminal one for good, picked by the setting when it's created (`fx acp` holds the session like a terminal would, so it can't be both) |
| Chat: queued messages (inbox) | ✅ | ⚠️ | fx: a message sent mid-turn steers; it waits in the inbox until fx takes it (fx has no queue yet: vercel-labs/fx#1786) |
| Chat: question forms | ✅ | ❌ | fx 0.0.17 asks its questions in plain text over ACP (vercel-labs/fx#1879 brings forms) |
| Chat: cost and context under the composer | ✅ | ⚠️ | fx: context from its `usage_update`, no cost |
| Chat: PDFs attached to a message | ✅ | ⚠️ | fx: sent as an embedded resource, untested with fx 0.0.17 |
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
   - `work`: lists what `activity()` counts and stops one of them (the chat view's list under the composer).
   - `background()`: moves the shell or subagent that holds a session's turn to the background, so a message
     sent mid-turn from a chat is read without waiting for it.
   - `chat`: its sessions as a chat, on the desktop (Settings → Appearance) and the phone. A `HarnessChat`
     reads pages of messages as ctrl's chat items, sends, stops and answers permissions; inbox, question forms,
     images, model and stats are optional, and `handles()` says which sessions are chat ones when not all are.
     `src/main/opencode-chat.ts` reads opencode's client; `src/main/fx-chat.ts` runs `fx acp` and builds the
     items from its updates (`src/main/acp/`, reusable for any agent that speaks ACP). `src/main/chat.ts`
     routes the chat views to them.
   - `skillFolders()`: the global folders it loads skills from, for its column in Settings → Skills.
5. **Support table** above: add a column and fill in what works.
