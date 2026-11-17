---
name: ctrl
description: Know where you are and drive the ctrl app (the window running your opencode / fx sessions) with the `ctrl` CLI. Use when you run inside ctrl (CTRL_SOCKET is set) and need context about your surroundings - this session, the space it's in, the other sessions in that space, or the PRs, issues and links shared across it - or when the user mentions "this space", "my other sessions", "what I was working on" or work done in another session. Also use to create, find, file, rename, archive or open sessions or spaces, start parallel sessions and wait for them, reference or read another session, change ctrl settings, or switch what ctrl shows on screen. Also use to get a git worktree: when you need to change, build, test or review code in a repo and you're not already in a checkout meant for it, `ctrl worktree up <repo>` gives this session a ready one (latest base branch, dependencies installed), and you can hold several at once.
---

# ctrl CLI

`ctrl` controls the running ctrl app: spaces, sessions, references between sessions, settings and
what's on screen. It's built for agents: every reply is one JSON object on stdout.

## Run it

```bash
sh <skill base directory>/ctrl.sh <command> [args]
```

`ctrl.sh` runs the CLI that ships with the app, even if another `ctrl` comes first in PATH. Inside
terminals ctrl runs, plain `ctrl` works too.

## Where am I?

Inside a session ctrl runs, `self` is the session you're in. Start here:

```bash
ctrl session get self                                  # this session: title, folder, spaceID, parentID, children
ctrl space get self                                    # its space: name, folder, instructions
ctrl session list --space self --fields id,title,status  # the other sessions in the space
ctrl session list --parent self --fields id,title,status # sessions started from this one (child sessions)
ctrl resources list --space self                       # PRs, issues, links and referenced sessions in the space
ctrl session read <id>                                 # digest of another session
```

## Work on a repo: worktrees

Sessions in ctrl aren't tied to a folder. To change, build, test or review code, take a git worktree
instead of working in the user's own checkout: ctrl keeps a pool of them warm, so it's usually instant.

```bash
ctrl worktree up ~/code/acme-app     # → data.path: this session's checkout (latest base branch, deps installed)
git -C <path> switch -c my-feature   # it's on a detached HEAD: create a branch before committing
ctrl worktree list                   # the worktrees this session holds (id, repo, path, branch)
ctrl worktree down <id|path>         # give one back early (refuses unsaved work; --force discards it)
```

- **Work in `data.path`:** pass it as the working directory of every command (or `cd` there). Your session
  doesn't move, and you can hold several worktrees, of one repo or of many: one per branch or PR you work on.
- **`<repo>`** is the path of a git checkout on this Mac (anywhere inside it), or the name of a repo ctrl
  already manages (`ctrl worktree config` lists them). A new repo is set up on its own.
- **Every `up` takes another worktree.** To find the ones you already hold, use `ctrl worktree list` (or
  `worktrees` in `ctrl session get self`), not `up` again.
- **Read `data.hint`:** it says how old the base commit is and how to get the very latest. `cold: true`
  means it had to be built (checkout + install), which can take minutes. If the command times out or is
  killed, run the same command again: it waits for the same build instead of starting another.
- **Reviewing a PR:** `up`, then `gh pr checkout <n>` in the worktree. If git says the branch is already
  checked out elsewhere, `ctrl worktree list --all` shows which session holds it: use that worktree if it's
  yours or your parent's, else review detached (`git fetch origin pull/<n>/head && git checkout --detach FETCH_HEAD`).
- **Child sessions** (`ctrl session new`) can work in your worktree: give them its path. Or they take their own.
- **No cleanup needed:** archiving the session releases its worktrees (the folder goes away, uncommitted
  changes with it; branches and pushed work stay). So commit and push what matters before archiving, and
  don't use a worktree's path after releasing it.
- Don't run `git worktree add` yourself for this, and don't keep the path in a shell variable called `path`
  (zsh ties it to `PATH`).

## Learn the commands

```bash
sh <skill base directory>/ctrl.sh help --json     # every command, typed arguments, output shapes, errors
sh <skill base directory>/ctrl.sh help session new  # one command
```

Don't guess flags: read `help` first. The most used ones:

| Command | Does |
|---|---|
| `session list [--space <s>] [--status needs-input]` | find sessions |
| `session new [--space <s>] [--parent <s>\|none] [--title t] [--prompt p\|-] [--focus]` | start one (background unless `--focus`; `--prompt -` reads stdin) |
| `session wait <s> --for done` | block until its turn is over |
| `session read <s>` | digest of another session's context |
| `session reference <src> --into <dst> [--text t] [--submit]` | reference one session in another |
| `session move <s> [--space <space\|none>] [--parent <s>\|none]` · `session archive <s>` | file / nest / archive |
| `space create <name> [--directory d]` · `space list` | spaces |
| `worktree up <repo>` · `worktree list` · `worktree down [<id\|path>]` | take / list / give back a git worktree (see above) |
| `settings list` · `settings set <key> <value>` | settings |
| `focus <s> [--raise]` | put a session on screen |

## Rules

- Sessions: an id (`ses_…`, `fx:…`), `self` (the session you're in), `current` (on screen) or
  `name:<title>`. Spaces: an id, `name:<name>`, `self` (your session's space) or `current`.
- Sessions form a tree: a session can have child sessions (`parentID`, `children`). `session new` run from
  a session makes a child of it by default, in the same space and folder, so the user sees where it came
  from. Pass `--parent none` only when the new session is unrelated to yours.
- Check `ok`. On errors, read `error.code` and follow `error.hint`; `AMBIGUOUS` lists `candidates`
  (retry with an id).
- Don't change what's on screen (`focus`, `--focus`, `ui …`) unless the user asked for it.
- You can't delete sessions, only archive them (`session archive`, reversible). If the user wants a
  session deleted, tell them to do it from ctrl's sidebar.
- The CLI shows the user no toasts. Replies to archive, archive-all and space delete carry an `undo`
  command: mention it to the user ("you can undo this with …") or run it if they ask.
- Run it through `ctrl.sh`, or with `AI_AGENT=<your name>` set, so sessions you create are marked as made
  by an agent (opencode sets `AI_AGENT` for you).
- Pass long or multi-line text on stdin, not inline: `--prompt - < prompt.md`, `--text - <<'EOF'`.
- Use `--fields id,title` on lists to keep output small.
- To check a prompt was taken (`session new --prompt`, `session send`), look for status `running`, then
  `session wait <s> --for done`. `session read` shows an fx turn in progress with what it did so far. fx
  only reports `needs-input` for sessions open in ctrl, so give waits on fx a `--timeout`.
