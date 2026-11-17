# Development

```bash
npm install
npm run dev     # vite + esbuild watch + electron
npm run preview # same, as a separate ctrl per branch on a fresh copy of your real state (see Previews)
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
`ctrl-dev/state.json` to start over, or use a preview, which copies it on every launch.

## Previews

To try a branch on your real spaces and sessions, next to the installed app and to other branches:

```bash
npm run preview                    # labelled with the current branch, fresh copy of your state
npm run preview -- --keep          # keep this preview's state from last time
npm run preview -- --name <label>  # label other than the branch (also names its state folder)
```

- Each label gets its own state folder (`~/Library/Application Support/ctrl-preview/<label>`), CLI socket
  and phone port (7340 and up, the same one every time), so previews never step on each other or on the
  installed app.
- The label shows next to "ctrl" in the sidebar and on the phone, so you know which window runs which branch.
- `state.json` (spaces, assignments, settings) and `~/.config/ctrl/tools.json` are copied in fresh on every
  launch, so edits a preview makes to them never reach the installed app. Sessions themselves are shared:
  they live in opencode and fx, so a preview drives your real sessions.
- Your installed agent skills are left alone: a preview keeps its copies in its state folder (`CTRL_SKILLS_DIR`),
  so agents keep reading the installed app's skills and running its CLI.
- Worktrees are not shared: a preview has its own pool, repos and folder (`~/.ctrl/worktrees-<label>`), and
  starts with none. Agents in your sessions still talk to the installed app's `ctrl` (the opencode service is
  the installed app's), so try `ctrl worktree` in a preview with the `CTRL_SOCKET=…` line it prints.
- Live reload like `npm run dev`: renderer changes hot-reload, main process changes restart the app. The phone
  view rebuilds without a restart, refresh the page.
- It prints the phone links once the remote server is up (`[ctrl] phone: …`) and a `CTRL_SOCKET=…` line to
  drive that preview with the CLI.
- Stop it with Ctrl+C (or by killing the script, or quitting the app). Old state folders stay until you delete
  them.

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
- `CTRL_FX_HOME=/tmp/fx` read fx sessions from there instead of `~/.fx`. fx itself has no profile override,
  so sessions a test run creates land in `~/.fx/sessions`: delete them afterwards
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
