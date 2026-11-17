# Testing

Add tests freely: for every fix, every new command, every behavior worth keeping. Two rules apply to all of
them, and they win over coverage:

1. **Fast.** `npm test` stays well under a second, however many tests there are. It should feel free to run
   after every change.
2. **Never flaky.** A test that sometimes fails is a bug. Fix it or delete it the same day. Don't retry it,
   don't skip it, don't raise its timeout.

## How it works

`npm test` runs `test/*.test.mjs` with `node:test`, every file in its own process, in parallel. Each file
bundles the TypeScript it needs with esbuild (`load()` in `test/helpers.mjs`, a few ms) and runs it against
fakes:

| Layer | What runs | Talks to | Files |
| --- | --- | --- | --- |
| Pure logic | store, adapters, shortcuts, chat items, tool alerts… | nothing, or a temp folder | `store`, `adapters`, `shared`, `remote-chat`, `tools`, `opencode` |
| CLI handlers | `createHandlers()`, the code behind every `ctrl` command | a fake host + a real `Store` | `handlers`, `cli`, `worktrees` |
| CLI launcher | `bin/ctrl` + `dist/cli/cli.cjs` as a real process | a fake app socket | `cli` (`ctrl launcher`) |
| UI | React components in happy-dom (`loadUi()`) | a fake `window.ctrl` | `ui` |

The CLI is the most important surface (agents depend on it), so it gets the most tests: handlers for
behavior, the launcher only for what needs a real process (argv, stdin, signals, exit codes).

## Keeping it fast

- No Electron, no network, no real opencode or fx. Fake what the code talks to: the host (`CliHost`), the
  opencode client, `window.ctrl`.
- Test in process. Spawning costs ~80ms per process, so only the launcher tests spawn, and they run
  concurrently (`describe(..., { concurrency: true })`).
- Timeouts and budgets in tests are tens of ms. When code has a long built-in wait, make it a parameter
  (like `createHandlers(host, { sessionNewBudget })`) instead of waiting it out.
- One `load()` (one esbuild run) per file, in `before()`.
- If a file goes over ~300ms on its own (`node --test test/x.test.mjs`), find out why before adding more.

## Keeping it reliable

- **Wait for events, not time.** Resolve on the change itself (`host.changed()`, a callback, a promise),
  never `sleep(100)` and hope. A timeout only bounds a test that's already failing.
- **No shared state between tests.** Each test makes its own `Store` (in its own temp folder), host and
  fakes. Tests must pass alone and in any order.
- **Deterministic data.** Fixed timestamps and ids in fixtures. When the code reads `Date.now()`, keep the
  values far from any boundary (a day old, not 59s old).
- **No ports, no real home folder.** Unix sockets in a temp folder, `tmpDir()` for files (removed after the
  file's tests). Never touch `~/.fx`, `~/Library` or the real state.
- **Assert on what users and agents see**: a command's reply, rendered text, the calls made to the host.
  Not on private fields or timing.
- Every test has a 5s timeout (`--test-timeout`), so a hang fails fast instead of stalling the run.

## UI tests

`loadUi(tmp, entries, ctrl)` bundles components with React into a fake DOM (happy-dom), with `ctrl` as
`window.ctrl`. `render()`, `type()` and `key()` drive them; `await ui.act(async () => {})` lets pending
promises (like a `window.ctrl.search` reply) settle. See `test/ui.test.mjs`.

- Good for: what a component lists, filters and highlights, what keys and clicks call.
- Not for: layout, CSS, xterm, drag and drop. happy-dom doesn't lay anything out. Check those in a preview
  (`npm run preview`) or with the debug hooks (`CTRL_EVAL`, `CTRL_SCREENSHOT`, [DEVELOPMENT.md](DEVELOPMENT.md)).
- Keep components testable: they get state as props and reach main only through `window.ctrl`, so a fake
  covers everything.

End-to-end runs of the real app (Electron) take seconds each, so they stay out of `npm test`.

## Slow tests

`npm run test:slow` runs `test/slow/*.test.mjs`: tests that need real processes and take seconds, so they
can't live in `npm test`. Today that's the worktree pool (`src/main/worktrees`) against throwaway git repos:
real `git worktree add`, setup commands, recycling and cleanup. Run it when you touch that code. The same
reliability rules apply (temp folders only, no shared state), with a 60s timeout per test. The pool's pure
parts (pool sizing) and the `ctrl worktree` handlers over a fake pool are in `npm test` (`worktrees`).
