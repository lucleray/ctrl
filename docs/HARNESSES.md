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

✅ supported · ⚠️ partial · ❌ not supported

| Feature | opencode | fx | Notes |
|---|---|---|---|
| Sessions in the sidebar, spaces, Recents | ✅ | ✅ | |
| Mix both kinds in one space | ✅ | ✅ | |
| Archive / unarchive | ✅ | ✅ | ctrl-side, the harness is untouched |
| Move between spaces, drag and drop | ✅ | ✅ | |
| ⌘1–9 jump, ⌘P title search | ✅ | ✅ | |
| ⌘P message search | ✅ | ✅ | opencode: through the service · fx: tails `events.jsonl` |
| Resources panel (links per session / space) | ✅ | ✅ | Same index as search |
| Links and search updated during a turn | ⚠️ | ⚠️ | opencode: links in your prompt right away, the agent's at the end of the turn · fx: everything at the end of the turn, since fx only saves a turn (your prompt included) once it's done |
| Rename | ✅ | ⚠️ | fx rewrites its title while it runs, so the rename is written once no fx process has the session |
| Delete | ✅ | ✅ | fx: the session folder goes to the Trash |
| New session in a space's folder | ✅ | ✅ | |
| Harness per space / app default | ✅ | ✅ | |
| Custom model per space / app default | ✅ | ✅ | Picked separately per harness · fx: `--model` and `--effort` |
| Space instructions | ✅ | ❌ | fx has no way to take extra instructions for a session |
| Switching sessions | ✅ instant | ⚠️ | fx: instant once open, about 1s the first time (`fx resume`) |
| Many sessions open at once | ✅ | ⚠️ | fx: up to 12 live processes, the least recently used idle ones are closed past that |
| Turns keep running when ctrl quits | ✅ | ❌ | fx has no background service: quitting stops the turn, send `continue` after reopening |
| Sessions open at quit come back | ✅ | ⚠️ | fx: reopened at launch (`fx resume`), with a compact transcript instead of the full screen |
| Status: running | ✅ | ✅ | fx: OSC 7501 status reports, else the last line of `events.jsonl` |
| Status: needs you (permission, question) | ✅ | ⚠️ | fx: only for sessions open in ctrl (OSC 7501) |
| Status: failed | ✅ | ⚠️ | fx: only for sessions open in ctrl |
| Status: finished, unread | ✅ | ✅ | fx: read state kept by ctrl |
| Status of sessions that aren't open | ✅ live | ⚠️ | fx: read from files on disk |
| Notifications, sounds, dock badge | ✅ | ⚠️ | Same as status: fx's "needs you" and "failed" only for open sessions |
| Sessions open in another terminal | ✅ | ⚠️ | fx allows one process per session: shown, but ctrl can't open or delete them until that fx quits |
| Reference a session (drag onto the terminal) | ✅ | ✅ | Works across harnesses, with the `read-session` skill |
| Drop files from Finder | ✅ | ✅ | |
| ⌘-click links, wrapped URLs | ✅ | ✅ | |
| Theme for the terminal | ✅ | ⚠️ | fx follows ctrl's light/dark; pick an fx theme in `~/.fx/settings.json` |
| MCP server status and Fix | ✅ | ❌ | opencode's MCP servers only |
| `/new`, `/resume` inside the terminal followed by the sidebar | ✅ | ✅ | |
| Welcome screen | ✅ | ✅ | First launch: shows what's installed, lets you pick when both are, install commands when neither is |
