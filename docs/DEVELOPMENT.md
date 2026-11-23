# Development

```bash
npm install
npm run dev     # vite + esbuild watch + electron
npm run preview # same, as a separate ctrl per branch in a seeded sandbox (see Previews)
npm start       # production build + electron
npm run package       # build release/mac-*/ctrl.app for this Mac (see Signing)
npm run install-app   # build + replace /Applications/ctrl.app (restarts it if running)
```

**Releasing:** bump `version` in `package.json`, merge, then `npm run release` from a clean checkout of
the merged commit. It builds arm64 and x64 apps (`scripts/package.mjs --arch all --zip`) and publishes them
as a GitHub release, `ctrl-mac-<arch>.zip` (no version in the name, so `install.sh` can always download
`releases/latest/download/ctrl-mac-<arch>.zip`). Installed apps find it within a few hours (`src/main/updater.ts`).

**Signing:** builds are signed with a self-signed **"ctrl Code Signing"** certificate (`scripts/sign.mjs`),
not notarized (no Developer ID). That's fine as long as the app arrives through `install.sh` (curl) or the
in-app updater, which don't quarantine it. The certificate matters for macOS privacy grants: they're tied to
the app's designated requirement, which ad hoc is the binary's hash (every build asks for Documents, Desktop,
… again), and with the certificate is `identifier "im.luc.ctrl" and certificate leaf = H"934b…"`, which
survives rebuilds and updates on every Mac. Users install nothing; only the Mac that signs needs it.

- Without the certificate, `package`, `install-app` and the dev app (`npm run brand`) fall back to ad hoc.
  `npm run release` refuses: an ad-hoc release would make every user grant folder access again.
- Never replace the certificate (valid until 2036): a new one means everyone gets asked once more.
  Override the name with `CTRL_SIGN_IDENTITY` if needed.
- Setting it up on a new Mac: import the backup `.p12` (`security import ctrl-code-signing.p12 -k
  ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign`), then let codesign use it without a password
  prompt per binary: `security set-key-partition-list -S apple-tool:,apple: -s -l "ctrl Code Signing"
  ~/Library/Keychains/login.keychain-db` (asks for the login password once).
- Notarizing later would need an Apple Developer account, a Developer ID certificate in `CTRL_SIGN_IDENTITY`,
  plus `codesign --options runtime` and `notarytool`. Switching certificates re-asks everyone once.

**opencode:** ctrl needs `MIN_OPENCODE` (`src/main/opencode-bin.ts`) or newer and shows a setup screen
otherwise. Raise it when ctrl starts using a newer API, and update the version in the README install section
(it's the version ctrl was tested on, not a proven floor).

The packaged app loads your login shell's environment at startup (Finder
launches get a bare PATH), and ships the bridge plugin unbundled in
`Contents/Resources/bridge` since opencode can't read inside `app.asar`. The
installed app keeps its state in `~/Library/Application Support/ctrl`; `npm run dev`
uses `ctrl-dev` next to it, so both can run side by side. `ctrl-dev` is copied from
the real state only on its very first run and drifts from it after that: delete
`ctrl-dev/state.json` to start over, or use a preview, which runs in a sandbox of its own.

## Previews

To try a branch next to the installed app and to other branches, in a sandbox that never touches your real
ctrl state, opencode or fx sessions:

```bash
npm run preview                    # labelled with the current branch, keeps its sandbox from last time
npm run preview -- --reset         # reseed the sandbox from scratch
npm run preview -- --auth          # copy your opencode login in, for real models (stays until --reset)
npm run preview -- --name <label>  # label other than the branch (also names its folder)
```

- The sandbox (`~/Library/Application Support/ctrl-preview/<label>/sandbox`) is seeded on the first run by
  `scripts/demo/seed.mjs --preview`: the README demo spaces and sessions plus `PREVIEW_SESSIONS` (a parent
  with agent-created children, ...). It keeps what you do in it until `--reset`. Grow the seed when a change
  needs data it lacks, so the next preview has it too.
- It has its own HOME, so opencode runs as a separate service (port 49440 and up, paired with the phone port)
  with its own database, and fx, worktrees and skills live in the sandbox too. Agents use the free
  `opencode/big-pickle` model unless you pass `--auth`, which copies your `auth.json` and default model in.
- Why not a copy of your real state: a preview used to reopen your current session in its own TUI, and the
  agent in it then sent its `ctrl` commands (like `session new`) to the preview, whose changes were lost.
- Each label gets its own folder, CLI socket (`ctrl-preview/<label>/ctrl.sock`) and phone port (7340 and up,
  the same one every time), so previews never step on each other or on the installed app. The label shows
  next to "ctrl" in the sidebar and on the phone.
- It stays out of the way: a preview restarts on every edit to main, often while you work in something else,
  so its window opens smaller in the top-right corner, without taking focus, and comes back where you last
  moved it (`preview-window.json` in its sandbox). Agents testing a change drive it with its CLI line or the
  debug hooks (`CTRL_EVAL`, `CTRL_SCREENSHOT`), never by bringing it to the front (`ctrl window raise`,
  `open -a`, AppleScript).
- `~/.config/ctrl/tools.json` is copied in on the first run; gh's token is passed in (`GH_TOKEN`) so the
  resources panel shows live PR status.
- Live reload like `npm run dev`: renderer changes hot-reload, main process changes restart the app. The phone
  view rebuilds without a restart, refresh the page.
- It prints the phone links once the remote server is up (`[ctrl] phone: …`) and a `CTRL_SOCKET=…` line to
  drive that preview with the CLI.
- Stop it with Ctrl+C (or by killing the script, or quitting the app): its opencode service stops with it.
  Old folders stay until you delete them.

One worktree per branch (`git worktree add ../ctrl-<branch> -b <branch>`) lets several previews run at once:
each builds into its own `dist/`.

## CLI

The `ctrl` CLI builds to `dist/cli/` with the rest (`npm run dev` rebuilds it without restarting the app).
Point it at a running dev or test ctrl with `CTRL_SOCKET`:

```bash
CTRL_SOCKET="$HOME/Library/Application Support/ctrl-dev/ctrl.sock" node dist/cli/cli.cjs status --pretty
npm run cli-docs   # regenerate docs/CLI-REFERENCE.md after changing src/shared/cli/commands.ts
npm test           # unit tests (test/), well under a second
npm run test:slow  # tests that run real git (test/slow/): the worktree pool, a few seconds
```

## Tests

`npm test` runs the unit tests in well under a second. How they work and the rules for adding more:
[TESTING.md](TESTING.md).

## Debug hooks

`CTRL_EVAL` and `CTRL_SCREENSHOT` run the app headless: hidden window, no dock icon, never takes focus
(force it with `CTRL_HEADLESS=1`).

- `CTRL_USER_DATA=/tmp/x` use a throwaway state dir (created if missing)
- `CTRL_OPENCODE=/path/to/opencode` use that binary (a missing path or a fake that prints an old
  version shows the setup screen)
- `CTRL_FX=/path/to/fx` use that binary (a missing path means no fx)
- `CTRL_FX_HOME=/tmp/fx` read fx sessions from there instead of `~/.fx`, and run fx with `FX_HOME` set to it
  (fx ≥ 0.0.17), so a test run's sessions stay there. Copy `~/.fx/settings.json` in to keep your sign-in
- `CTRL_SKILLS_DIR=/tmp/skills` install the read-session skill there, ignoring the real skill folders
- `CTRL_BIN_DIR=/tmp/bin` install the `ctrl` command link there instead of `~/.local/bin` (`install.sh`
  reads it too)
- `CTRL_SOCKET_PATH=/tmp/ctrl.sock` listen for the CLI there instead of the state folder (the CLI side reads
  `CTRL_SOCKET`; a `CTRL_USER_DATA` run already gets its own socket in that folder)
- `CTRL_REMOTE_PORT=7345` serve the phone view on that port (default 7337 installed, 7338 dev)
- `CTRL_LABEL=my-branch` show that label next to "ctrl" in the sidebar and on the phone (`npm run preview`
  sets it to the branch)
- `CTRL_UPDATES=1` check for updates in dev runs too; `CTRL_UPDATE_NO_RELAUNCH=1` swaps the app on
  update without reopening it
- `CTRL_MCP_DIR=/tmp/proj` read MCP statuses for that folder instead of `~` (put a broken server in
  its `opencode.json` to test the failing-MCP toast)
- `CTRL_TOOLS_FILE=/tmp/tools.json` use that tools list instead of `~/.config/ctrl/tools.json`. Dev runs use
  `~/.config/ctrl/tools.dev.json`, `CTRL_USER_DATA` runs a `tools.json` in that folder. Delete it to see the
  scan (and the one-time toast, with `toolsPrompted` removed from `ui` in state.json) again
- `CTRL_WORKTREE_ROOT=/tmp/worktrees` create git worktrees there (`ctrl worktree up`). Without it, the
  installed app uses `~/.ctrl/worktrees` and every other run its own `~/.ctrl/worktrees-<state folder name>`
  (`worktrees-ctrl-dev`, `worktrees-<preview label>`), with its own `worktrees.json` in its state folder
- `CTRL_EVAL='...'` run JS in the renderer 3s after load
- `CTRL_SCREENSHOT=/tmp/shot.png CTRL_SCREENSHOT_DELAY=8000` capture the window
- `CTRL_SEND='["space:settings","spc_x"]'` send a main → renderer event 2s after load
- `CTRL_INPUT='[[4000,"keyDown","Meta",["meta"]]]'` replay real keyboard input (ms after window creation)
- `CTRL_FRAMES=/tmp/frames,15000,100,90` capture 90 numbered frames, one every 100ms, starting 15s after
  window creation (the README GIF)

## Screenshots

The README media in `docs/media` come from demo data, never from your own sessions:

```bash
node scripts/demo/capture.mjs            # all of them, ~3 minutes
node scripts/demo/capture.mjs --no-seed --only search   # redo one, reusing the demo data
node scripts/demo/capture.mjs --harness fx   # the fx versions (hero-fx.png, …), shown next to the opencode ones
```

- With `--harness fx`, `seed.mjs` writes the same sessions as fx files into the demo HOME's `~/.fx/sessions`
  instead, and ctrl runs with no opencode (`CTRL_OPENCODE` pointing nowhere) and the real fx binary (`CTRL_FX`),
  with a dummy `AI_GATEWAY_API_KEY` so fx skips its sign-in screen (resuming never calls the API).
- `scripts/demo/seed.mjs` starts a throwaway opencode (its own HOME, XDG dirs and service port 49411) and
  imports demo sessions with real public GitHub links, so the resources panel shows live PR status. It also
  writes a ctrl state folder with three spaces.
- `scripts/demo/capture.mjs` runs ctrl headless against it, once per shot, driving it with the debug hooks above.
  The drag in the GIF uses real drag events on the real drop zone; only the row following the cursor is drawn
  by the script, since synthetic drags have no drag image.
- `scripts/demo/media.mjs` crops, resizes and encodes the GIF inside Electron (`nativeImage`), with `gifenc`
  installed into the demo folder, so it needs no image tools.
- `gh auth token` is passed to the demo app as `GH_TOKEN`: the demo HOME hides gh's keychain login.
- Change the story in `SESSIONS` (`seed.mjs`), the shots in `capture.mjs` and the crops in `media.mjs`.
- `node scripts/demo/activity.mjs` opens a demo ctrl (visible, not headless) whose sessions have real background
  shells and subagents that never finish (a local fake model), to look at those states. Ctrl+C stops it all.
- `node scripts/demo/background.mjs` opens a demo ctrl in chat view on a session whose turn waits for a shell
  and a subagent, to try sending it a message (both go to the background after 3 seconds) and the list under the
  composer. Its agent is a local fake model: "run X" makes it start a shell and wait for it ("run sleep 30" for
  one that ends on its own), "delegate Y" a subagent that never finishes, "think" makes it take 20 seconds to
  answer, anything else gets a short answer.

## Website

[ctrl.lucleray.me](https://ctrl.lucleray.me) is a static page in `site/`, the Vercel project `ctrl-site` on
the `luc-and-co` team (root directory `site`).

- `node site/build.mjs` builds it into `site/dist`: `index.html` with the dot-matrix wordmark rendered in as an
  SVG (`site/main.js` moves it to a canvas for the load and pointer-interference animations), plus
  `build/icon.png` and `docs/media` (`hero.png` is the link preview image). Preview it with
  `python3 -m http.server -d site/dist`.
- `site/demo.js` is the interactive demo: a fake ctrl window in plain HTML, with canned sessions, replies and
  CLI output (no model), driven by the feature list next to it. Each entry in `FEATURES` sets up the window and
  says what to try; `beta: true` tags the Experimental ones. Add an entry when a feature worth showing ships.
- `/install.sh` redirects to the script on `main`, so `curl -fsSL https://ctrl.lucleray.me/install.sh | sh`
  always installs the latest release. `/download` and `/github` redirect too (`site/vercel.json`).
- Deploy from the repo root, so the build can read `docs/media`:
  `vercel link --project ctrl-site --scope luc-and-co` once, then `vercel deploy --prod`. `vercel link` writes
  an OIDC token to `.env.local`: `.gitignore` keeps it (and `.vercel`) out of this public repo.
