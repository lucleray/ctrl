# ctrl

Read `docs/ARCHITECTURE.md` first, especially **Principles** and **Notifications**.

## Working on a change

When asked to build something in ctrl, unless told otherwise:

1. **One branch, one worktree.** Branch off the latest `origin/main` in a git worktree of its own, so changes
   running in parallel don't mix. Never work in a checkout that someone else's preview is running from.
2. **Run it as a preview.** `npm install` if needed, then `npm run preview` in the background (one per
   worktree). It's a separate ctrl labelled with the branch, on a fresh copy of the user's state, next to the
   installed app: never replace or restart the installed `/Applications/ctrl.app` (agents usually run inside
   it). See `docs/DEVELOPMENT.md` → Previews.
3. **Hand it over.** Tell the user the branch, that the preview is up, and the phone link it printed when the
   change touches the phone view (`src/remote`).
4. **Iterate.** Live reload picks up edits: say whether the user needs to do anything (refresh the phone, wait
   for the app to restart). Keep the preview running between turns.
5. **Check before saying it's done.** `npm run typecheck`, and `npm test` when CLI code changed. Drive the
   preview with the CLI line it printed, or take a screenshot with the debug hooks.
6. **Commit and push** the branch as you go. Open a pull request only when asked.
7. **Clean up** when the work is merged or dropped: stop the preview, remove the worktree, and delete its
   `ctrl-preview/<label>` folder.

## Rules

- Catalog every feature you add, change or remove in `docs/FEATURES.md`, in the same commit.
- Notifying the user inside the app always goes through the toast (`toast()` in `src/main/main.ts`).
  Don't add new banners, popups or notification types.
- `README.md` is for people deciding to install ctrl: keep it short. Technical details go in `docs/`
  (`ARCHITECTURE.md`, `DEVELOPMENT.md`, `USAGE.md`).
- README screenshots come from demo data: `node scripts/demo/capture.mjs` (`docs/DEVELOPMENT.md` → Screenshots).
- ctrl runs two harnesses, opencode and fx: keep [docs/HARNESSES.md](docs/HARNESSES.md)'s support table current
  when a feature works differently (or not at all) for one of them.
- The `ctrl` CLI is for agents: follow the principles in [docs/CLI.md](docs/CLI.md) for every command you add.
- fx refuses session files others can read: anything written under `~/.fx/sessions` must stay `0600`.
- Test runs must not leave fx sessions behind in `~/.fx/sessions` (fx has no profile override); delete the ones
  you create.
