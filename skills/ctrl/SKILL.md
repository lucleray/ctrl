---
name: ctrl
description: Know where you are and drive the ctrl app (the window running your opencode / fx sessions) with the `ctrl` CLI. Use when you run inside ctrl (CTRL_SOCKET is set) and need context about your surroundings - this session, the space it's in, the other sessions in that space, or the PRs, issues and links shared across it - or when the user mentions "this space", "my other sessions", "what I was working on" or work done in another session. Also use to create, find, file, rename, archive or open sessions or spaces, start parallel sessions and wait for them, reference or read another session, change ctrl settings, or switch what ctrl shows on screen.
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
  `session wait <s> --for done`. fx only logs a turn once it ends, so `session read` shows an fx turn in
  progress as `Turn N · running`. fx can't report `needs-input`, so give waits on fx a `--timeout`.
