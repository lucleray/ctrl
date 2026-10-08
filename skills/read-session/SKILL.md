---
name: read-session
description: Read another opencode session referenced in the prompt, like `@session[Title](ses_…)`, so you can use its context or continue its work. Use whenever the user's message contains an `@session[...](ses_…)` mention or asks you to look at, reference, or continue a specific opencode session by ID.
---

# Read a referenced opencode session

The user referenced another opencode session, usually as `@session[Title](ses_…)`
(ctrl inserts this when a session is dragged onto the terminal). Load its context
before answering.

## Steps

1. Take the session ID from the mention (the `ses_…` part in parentheses).
2. Print a digest (works from any directory):

   ```bash
   node ~/.agents/skills/read-session/digest.mjs ses_XXXXXXXX
   ```

   It shows the title, directory, each turn (user prompt + final assistant
   reply, recent turns in more detail), tools used, files touched and the
   last commands.
3. If you need everything said in one turn, read it in full:

   ```bash
   node ~/.agents/skills/read-session/digest.mjs ses_XXXXXXXX --turn 3
   ```

4. Use that context to do what the user asked. Briefly say which session you
   read (title) so they know the reference resolved. Don't paste the digest back
   unless asked.

## Notes

- `digest.mjs` goes through `opencode api`, which reuses the running opencode
  service and its auth. No extra setup.
- Don't pipe `opencode api` output directly (it gets truncated when stdout is a
  pipe); `digest.mjs` already handles this via a temp file.
- The referenced session may live in another directory. Its `directory` line
  tells you where its files are; read them there if needed.
- Reading a session is read-only. Never send prompts to, modify, or delete the
  referenced session.
