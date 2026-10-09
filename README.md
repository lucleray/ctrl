<p align="center">
  <img src="build/icon.png" width="128" alt="ctrl icon" />
</p>

<h1 align="center">ctrl</h1>

<p align="center">
  A cozy desktop home for your <a href="https://opencode.ai">opencode</a> sessions 🌊
  <br />
  <sub>Codex-style sidebar on the left, the real opencode TUI on the right.</sub>
</p>

---

## ✨ Why you'll like it

- 🗂️ **Spaces**: group sessions by project, each with its own folder, model and instructions
- ⚡ **Instant switching**: one opencode TUI that swaps sessions in place, plus ⌘1–9 and ⌘P search
  (titles and full message text)
- 🔔 **Know what needs you**: status dots for waiting, running, failed or unread, plus dock badge,
  notifications and sounds
- 🔗 **Resources panel**: every PR, deploy, Linear issue or Slack thread shared in a session, with live status
- 🧠 **Reference sessions**: drag one session onto the terminal and the agent reads its context
- 🗄️ **Archive, undo, rename, drag and drop**: the usual comforts, all in ctrl's own state, so opencode is
  left untouched

## 📦 Install

You need a Mac (Apple silicon or Intel), access to this repo, and:

- **[GitHub CLI](https://cli.github.com)**, logged in: `brew install gh && gh auth login`
- **[opencode V2](https://opencode.ai/v2/docs/)**: `curl -fsSL https://opencode.ai/v2/install | bash`
  (ctrl shows these steps if it's missing or too old)

Then install the latest release into `/Applications` and open it:

```bash
gh api repos/lucleray/ctrl/contents/install.sh -H "Accept: application/vnd.github.raw" | sh
```

- **Why gh:** the repo is private, so downloads need your GitHub login. Bonus: files gh downloads aren't
  quarantined, so the app opens without a Gatekeeper prompt even though it isn't notarized.
- **Downloaded the zip from the browser instead?** macOS will say it's damaged. Run
  `xattr -dr com.apple.quarantine /Applications/ctrl.app` once.
- **Updates:** ctrl checks for a new release every few hours (through gh) and offers it in a toast.
  **Settings → About** has a manual check. The same one-liner also reinstalls.
- **First launch:** ctrl offers to install the `read-session` skill (also in **Settings → Agent skill**),
  so agents can read sessions you drag onto the terminal.
- **Uninstall:** delete `/Applications/ctrl.app` and `~/Library/Application Support/ctrl`, plus
  `~/.config/opencode/skills/read-session` if you installed the skill. Your opencode sessions aren't touched.

## 🛠️ How it works

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
- The bridge is injected only into the embedded TUI via `OPENCODE_CLI_CONFIG_CONTENT` (tabs and the TUI's
  own sidebar are turned off there too).
- The sidebar's session list (`src/main/opencode.ts`) does one full sync on launch and whenever the event stream
  reconnects. After that, events patch it in memory (renames, moves, deletes, views, permissions, questions), or
  re-read only the session they're about (created, run started/ended), so an update costs the same with 50 or
  5,000 sessions.
- Spaces live in `~/Library/Application Support/ctrl/state.json`. Sessions without a space still show under **Recents**, which lists every non-archived session (foldable, 10 at a time).

## 📋 Features

[`docs/FEATURES.md`](docs/FEATURES.md) lists every user-facing feature, so you don't have to read the code
to know what ctrl does. **When you add, change or remove a feature, update that file in the same commit.**

## 🌿 Principles

- **Fast.** Everything you touch responds instantly. Heavy work (fetching, parsing, indexing) stays off the main
  process, which relays every keystroke and byte of TUI output. Trade completeness for speed when needed, and
  write the compromise down next to the code.
- **Scalable.** ctrl must not get slower as sessions pile up. Work is proportional to what changed, not to how
  much history exists, and queries touch a bounded number of rows. When adding a feature, ask how it behaves with
  10× the sessions.

## 🔍 Search

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

## 🔗 Resources

The right panel (⇧⌘R, or the panel button next to search) lists the links shared in the current session, or in
every session of its space: PRs, issues, commits, repos, Linear issues, Notion pages, Slack threads and channels,
Vercel deployments and projects.

```text
indexed message text ──extractResources()──► resources          (one row per canonical resource)
                                             resource_mentions  (resource × message, with session + time)
panel ◄── main: GROUP BY resource over the scope's mentions (~3ms)
```

- **Adapters** live in `src/shared/adapters/`, one file per service, listed in `adapters/index.ts`. Each declares
  its link types: parse a URL into a canonical identity, a canonical URL and a few fields (`/pull/1/changes`,
  `/pull/1` and `/pull/1#x` are one PR), plus an icon and an offline title. Order matters: the first type that
  matches wins (PR before repo). URLs no type recognizes are ignored.
- **Live details are optional:** an adapter with a `live` part fetches them through its service's CLI (`gh`,
  `vercel`, `slack-cli`), so ctrl never handles tokens. It returns display-ready details plus a cache policy;
  `src/main/adapters/service.ts` does the scheduling and caching for all of them. Linear and Notion have no
  `live` part, so their links are shown as parsed.
- **Modes and status:** each adapter is Off (links hidden), Links only or Live details in Settings. A live
  adapter's `check()` verifies its CLI is installed and logged in without fetching, so Settings can show
  whether it works and offer a setup prompt built from `live.cli` (install, login, verify commands).

```text
adapter = { id, name, types[], live? }
              │         │
              │         ├─ live.check({ run }) → { account }   ← Settings status
              │         └─ live.fetch(batch, { run }) → { meta, cache: { maxAge, refreshOnMention } }
              └─ parse(url) / describe(data)   ← indexer + renderer, no requests
```

- **Add an adapter:** a new file implementing `ResourceAdapter`, listed in `ADAPTERS`, and bump
  `RESOURCES_VERSION`. The indexer then re-extracts from the stored message text, locally and without
  refetching (~10ms for 1k messages).
- **Same pipeline as search:** mentions are written in the same transaction as their message and deleted with it.
  Like search, only your prompts and the assistant's text are read, not tool output.

## 🧑‍💻 Development

```bash
npm install
npm run dev     # vite + esbuild watch + electron
npm start       # production build + electron
npm run package       # build release/mac-*/ctrl.app for this Mac (ad-hoc signed)
npm run install-app   # build + replace /Applications/ctrl.app (restarts it if running)
```

**Releasing:** bump `version` in `package.json`, merge, then `npm run release` from a clean checkout of
the merged commit. It builds arm64 and x64 apps (`scripts/package.mjs --arch all --zip`) and publishes them
as a GitHub release, `ctrl-<version>-mac-<arch>.zip`. Installed apps find it within a few hours
(`src/main/updater.ts`). Builds are local because macOS CI minutes are expensive on a private repo.

**Signing:** builds are ad-hoc signed, not notarized (no Developer ID). That's fine as long as the app
arrives through gh (install script, in-app updates), which doesn't quarantine it. Notarizing would need
an Apple Developer account plus `codesign --options runtime` and `notarytool` in `scripts/package.mjs`.

**opencode:** ctrl needs `MIN_OPENCODE` (`src/main/opencode-bin.ts`) or newer and shows a setup screen
otherwise. Raise it when ctrl starts using a newer API.

The packaged app loads your login shell's environment at startup (Finder
launches get a bare PATH), and ships the bridge plugin unbundled in
`Contents/Resources/bridge` since opencode can't read inside `app.asar`. The
installed app keeps its state in `~/Library/Application Support/ctrl`; dev runs
use `ctrl-dev` next to it (seeded from a copy of the real state on first run),
so both can run side by side.

## 🎛️ Usage

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
  the `read-session` skill lets the agent read its context via `digest.sh <id>`. ctrl installs it
  into `~/.config/opencode/skills` as a copy it manages (`src/main/skill.ts`), refreshed when ctrl's
  version changes. Copies it didn't make (like a dev symlink of `skills/read-session` in
  `~/.agents/skills`) are left alone. `digest.sh` runs with `node`, or with ctrl's own runtime when
  node isn't installed
- ⌘P search · ⌘N new chat · ⌘T new session in the current session's folder and space ·
  ⌘W archive the current session · ⌘, settings. All rebindable in **Settings → Shortcuts**
  (`src/shared/shortcuts.ts`)
- Archive, archive all, delete space and delete session show an undo toast (⌘Z while it's up).
  Session deletes are held back until the toast expires (or ctrl quits), since opencode can't
  restore them

## 🔔 Notifications

ctrl has **one** in-app notification: the toast (`src/renderer/Toast.tsx`). Don't add new banners,
popups or notification types. Raise a toast from main with `toast()` in `src/main/main.ts`:

```ts
toast({ icon: "archive", message: "Archived “x”", viewSessionID }, { undo })      // 8s, ⌘Z undoes
toast({ icon: "alert", message }, { sticky: true, action: { label: "Fix", run } }) // until dismissed
```

- **One at a time.** A newer toast replaces the one showing. The countdown pauses on hover.
- **Buttons:** View (`viewSessionID`), Undo (`undo`, also ⌘Z), and one primary `action` with any label.
  The callbacks stay in main; the renderer only sends back the toast id.
- **Sticky** (`duration: null`) is for problems that last, like a failing MCP server. Whoever raised
  it dismisses it with `dismissToast(id)` once the problem goes away.
- Add an icon to the `Toast["icon"]` union and `icons.tsx` if you need a new one.

The two other channels each have a single purpose, so don't use them for anything else:

| Channel | Where | Only for |
|---|---|---|
| Sidebar banner (`problem` / `error` in `AppState`) | bottom of the sidebar | ctrl can't reach opencode or the TUI, or a ctrl action failed |
| macOS notification (`src/main/attention.ts`) | system | a background session needs you, finished or failed, while ctrl isn't focused |
| Sound (`src/main/sound.ts`, via `attention.ts`) | speakers | the same transitions; in the background only unless **Also when ctrl is focused** is on |

**MCP servers** (Settings → MCP servers) is the first sticky toast: when a server is `failed` or
`needs_auth`, a toast says so and has a **Fix** button. It opens the TUI's new-session screen with a
prompt to fix that server already typed in (not sent). The toast clears itself when the server
reconnects, and the same error doesn't toast twice. Statuses come from `mcp.list` for `~` and
refresh on `mcp.status.changed` events.

## 🐛 Debug hooks

Any of these runs the app headless: hidden window, no dock icon, never takes focus
(force it with `CTRL_HEADLESS=1`).

- `CTRL_USER_DATA=/tmp/x` use a throwaway state dir (created if missing)
- `CTRL_OPENCODE=/path/to/opencode` use that binary (a missing path or a fake that prints an old
  version shows the setup screen)
- `CTRL_SKILLS_DIR=/tmp/skills` install the read-session skill there, ignoring the real skill folders
- `CTRL_UPDATES=1` check for updates in dev runs too; `CTRL_UPDATE_NO_RELAUNCH=1` swaps the app on
  update without reopening it
- `CTRL_MCP_DIR=/tmp/proj` read MCP statuses for that folder instead of `~` (put a broken server in
  its `opencode.json` to test the failing-MCP toast)
- `CTRL_EVAL='...'` run JS in the renderer 3s after load
- `CTRL_SCREENSHOT=/tmp/shot.png CTRL_SCREENSHOT_DELAY=8000` capture the window
- `CTRL_SEND='["space:settings","spc_x"]'` send a main → renderer event 2s after load
- `CTRL_INPUT='[[4000,"keyDown","Meta",["meta"]]]'` replay real keyboard input (ms after window creation)
