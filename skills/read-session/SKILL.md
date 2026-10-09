---
name: read-session
description: Read another opencode or fx session referenced in the prompt, like `@session[Title](ses_…)` or `session[Title](fx:…)`, so you can use its context or continue its work. Use whenever the user's message contains an `@session[...](...)` or `session[...](...)` mention, or asks you to look at, reference, or continue a specific opencode or fx session by ID.
---

# Read a referenced session

The user referenced another session, usually as `@session[Title](id)` or
`session[Title](id)` (ctrl inserts this when a session is dragged onto the
terminal). The id is `ses_…` for an opencode session, `fx:…` for an fx session.
Load its context before answering.

## Steps

1. Take the session ID from the mention (the part in parentheses, `ses_…` or
   `fx:…`, kept as is).
2. Print a digest with `digest.sh` from this skill's base directory (works from
   any working directory):

   ```bash
   sh <skill base directory>/digest.sh <id>
   ```

   It shows the title, directory, each turn (user prompt + final assistant
   reply, recent turns in more detail), tools used, files touched and the
   last commands.
3. If you need everything said in one turn, read it in full:

   ```bash
   sh <skill base directory>/digest.sh <id> --turn 3
   ```

4. Use that context to do what the user asked. Briefly say which session you
   read (title) so they know the reference resolved. Don't paste the digest back
   unless asked.

## Notes

- `digest.sh` runs `digest.mjs` with `node`, or with ctrl's bundled runtime when
  node isn't installed.
- opencode sessions are read through `opencode api`, which reuses the running
  opencode service and its auth. Don't pipe `opencode api` output directly (it
  gets truncated when stdout is a pipe); `digest.mjs` already handles this.
- fx sessions are read from `~/.fx/sessions/<id>/` directly.
- The referenced session may live in another directory. Its `directory` line
  tells you where its files are; read them there if needed.
- Reading a session is read-only. Never send prompts to, modify, or delete the
  referenced session.
