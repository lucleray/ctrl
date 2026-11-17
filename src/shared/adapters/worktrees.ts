import type { ResourceAdapter, ResourceType } from "./adapter"

export const worktreeUrl = (id: string) => `ctrl://worktree/${encodeURIComponent(id)}`

/**
 * Worktrees aren't links: they come from ctrl's own worktree pool (src/main/worktrees), one per worktree a
 * session holds, added to the session's resources by main. `data` carries repo, path, branch and status.
 */
const worktree: ResourceType = {
  id: "worktree",
  label: "Worktrees",
  icon: "git-branch",
  parse(url) {
    if (url.protocol !== "ctrl:" || url.hostname !== "worktree") return null
    const id = decodeURIComponent(url.pathname.slice(1))
    if (!/^[a-z0-9]+$/.test(id)) return null
    return { identity: id, url: worktreeUrl(id), data: { id } }
  },
  describe: (d) => ({ title: d.branch ? `${d.repo} · ${d.branch}` : d.repo || "Worktree", subtitle: d.path }),
}

/** No live part: branch and state come from the worktree pool. */
export const worktrees: ResourceAdapter = {
  id: "worktrees",
  name: "Worktrees",
  description: "Git worktrees a session holds (`ctrl worktree up`), with the branch they're on",
  types: [worktree],
}
