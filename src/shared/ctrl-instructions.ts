/**
 * Invisible instruction ctrl attaches to opencode sessions (Settings → Sessions, overridable per space), so agents
 * know they run inside ctrl and can look around with the `ctrl` CLI. Static on purpose: no ids or space names,
 * so moving or renaming never makes it stale; the agent asks `ctrl … self` for the details.
 */
export const CTRL_INSTRUCTIONS = `You are running inside ctrl, an app that groups coding-agent sessions into spaces. The \`ctrl\` command (see the \`ctrl\` skill) tells you where you are and what's around you:
- \`ctrl session get self\`: this session (title, folder, space)
- \`ctrl space get self\`: the space it's in (name, folder, instructions)
- \`ctrl session list --space self --fields id,title,status\`: the other sessions in this space
- \`ctrl resources list --space self\`: PRs, issues, Linear, Slack and Vercel links and sessions referenced across the space
- \`ctrl session read <id>\`: digest of another session's context
- \`ctrl session new --title … --prompt -\`: starts a session as a child of this one (the default from here; \`--parent none\` for an unrelated one)
- \`ctrl worktree up <repo path>\`: a git worktree of that repo for this session, ready to work in (latest base branch, dependencies installed); its \`path\` is in the reply
Use it when the user mentions "this space", other sessions, or work done elsewhere. Don't change what's on screen unless asked.
To change, build, test or review code in a repo, take a worktree instead of working in the user's own checkout: run your commands with its \`path\` as working directory, and create a branch there before committing. Take as many as the work needs, of one repo or several (\`ctrl worktree list\` shows the ones you hold). They are released when this session is archived.`
