# Using ctrl

## Install, update, uninstall

The one-liner in the [README](../README.md#-install) installs the latest release into `/Applications`.

- **Why a script:** ctrl isn't notarized. Files curl downloads aren't quarantined, so the app opens without a
  Gatekeeper prompt.
- **Downloaded the zip from the browser instead?** macOS will say it's damaged. Run
  `xattr -dr com.apple.quarantine /Applications/ctrl.app` once.
- **Updates:** ctrl checks GitHub for a new release every few hours and offers it in a toast.
  **Settings → About** has a manual check. The same one-liner also reinstalls.
- **First launch:** ctrl offers to install the `read-session` skill (also in **Settings → Agent skill**),
  so agents can read sessions you drag onto the terminal.
- **Uninstall:** delete `/Applications/ctrl.app` and `~/Library/Application Support/ctrl`, plus
  `~/.config/opencode/skills/read-session` if you installed the skill. Your opencode sessions aren't touched.

## Everyday use

- **+** next to Spaces: create a space
- Drag sessions between spaces, or onto **Recents** to unassign
- Hover a space: **+** new session in it, **⋯** for rename / space settings / delete
- Double-click a space to rename
- Right-click a session: move to / delete
- **Space settings** apply to new sessions started from ctrl in that space:
  - folder: where they start (defaults to `~`)
  - model (toggle): passed to `session.create`. Off falls back to **Settings → Custom model**; when that's
    off too, ctrl passes no model and opencode picks
  - instructions: attached as a session instruction entry (`ctrl.space`), invisible in the chat
    but part of the model's context on every turn
- ⌘1–9 jumps to the Nth visible session; hold ⌘ to see the numbers
- Drag a session onto the terminal to reference it: ctrl pastes `@session[Title](ses_…)` and
  the `read-session` skill lets the agent read its context via `digest.sh <id>`. ctrl installs it
  into `~/.config/opencode/skills` as a copy it manages (`src/main/skill.ts`), refreshed when ctrl's
  version changes. Copies it didn't make (like a dev symlink of `skills/read-session` in
  `~/.agents/skills`) are left alone. `digest.sh` runs with `node`, or with ctrl's own runtime when
  node isn't installed
- ⌘P search · ⌘N new chat · ⌘T new session in the current session's folder and space ·
  ⌘W archive the current session · ⌘, settings. All rebindable in **Settings → Shortcuts**
  (`src/shared/shortcuts.ts`)
- Archive, archive all, delete space and delete session show an undo toast (⌘Z while it's up).
  Session deletes are held back until the toast expires (or ctrl quits), since opencode can't
  restore them
