# ctrl

Read `docs/ARCHITECTURE.md` first, especially **Principles** and **Notifications**.

- Catalog every feature you add, change or remove in `docs/FEATURES.md`, in the same commit.
- Notifying the user inside the app always goes through the toast (`toast()` in `src/main/main.ts`).
  Don't add new banners, popups or notification types.
- `README.md` is for people deciding to install ctrl: keep it short. Technical details go in `docs/`
  (`ARCHITECTURE.md`, `DEVELOPMENT.md`, `USAGE.md`).
- README screenshots come from demo data: `node scripts/demo/capture.mjs` (`docs/DEVELOPMENT.md` → Screenshots).
- ctrl runs two harnesses, opencode and fx: keep [docs/HARNESSES.md](docs/HARNESSES.md)'s support table current
  when a feature works differently (or not at all) for one of them.
- fx refuses session files others can read: anything written under `~/.fx/sessions` must stay `0600`.
- Test runs must not leave fx sessions behind in `~/.fx/sessions` (fx has no profile override); delete the ones
  you create.
