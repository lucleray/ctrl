# Development

```bash
npm install
npm run dev     # vite + esbuild watch + electron
npm start       # production build + electron
npm run package       # build release/mac-*/ctrl.app for this Mac (ad-hoc signed)
npm run install-app   # build + replace /Applications/ctrl.app (restarts it if running)
```

**Releasing:** bump `version` in `package.json`, merge, then `npm run release` from a clean checkout of
the merged commit. It builds arm64 and x64 apps (`scripts/package.mjs --arch all --zip`) and publishes them
as a GitHub release, `ctrl-mac-<arch>.zip` (no version in the name, so `install.sh` can always download
`releases/latest/download/ctrl-mac-<arch>.zip`). Installed apps find it within a few hours (`src/main/updater.ts`).

**Signing:** builds are ad-hoc signed, not notarized (no Developer ID). That's fine as long as the app
arrives through `install.sh` (curl) or the in-app updater, which don't quarantine it. Notarizing would need
an Apple Developer account plus `codesign --options runtime` and `notarytool` in `scripts/package.mjs`.

**opencode:** ctrl needs `MIN_OPENCODE` (`src/main/opencode-bin.ts`) or newer and shows a setup screen
otherwise. Raise it when ctrl starts using a newer API, and update the version in the README install section
(it's the version ctrl was tested on, not a proven floor).

The packaged app loads your login shell's environment at startup (Finder
launches get a bare PATH), and ships the bridge plugin unbundled in
`Contents/Resources/bridge` since opencode can't read inside `app.asar`. The
installed app keeps its state in `~/Library/Application Support/ctrl`; dev runs
use `ctrl-dev` next to it (seeded from a copy of the real state on first run),
so both can run side by side.

## Debug hooks

Any of these runs the app headless: hidden window, no dock icon, never takes focus
(force it with `CTRL_HEADLESS=1`).

- `CTRL_USER_DATA=/tmp/x` use a throwaway state dir (created if missing)
- `CTRL_OPENCODE=/path/to/opencode` use that binary (a missing path or a fake that prints an old
  version shows the setup screen)
- `CTRL_FX=/path/to/fx` use that binary (a missing path means no fx)
- `CTRL_FX_HOME=/tmp/fx` read fx sessions from there instead of `~/.fx`. fx itself has no profile override,
  so sessions a test run creates land in `~/.fx/sessions`: delete them afterwards
- `CTRL_SKILLS_DIR=/tmp/skills` install the read-session skill there, ignoring the real skill folders
- `CTRL_UPDATES=1` check for updates in dev runs too; `CTRL_UPDATE_NO_RELAUNCH=1` swaps the app on
  update without reopening it
- `CTRL_MCP_DIR=/tmp/proj` read MCP statuses for that folder instead of `~` (put a broken server in
  its `opencode.json` to test the failing-MCP toast)
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
