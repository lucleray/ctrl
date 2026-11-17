import { useState } from "react"
import type { AppState } from "../shared/types"
import type { WorktreeJob, WorktreeJobID, WorktreeRepoView } from "../shared/worktrees"
import { age, shortPath } from "./format"
import { Icon } from "./icons"
import { Toggle } from "./Toggle"

const AUTO = "auto"
const POOL_SIZES = [0, 1, 2, 3, 4, 5, 6, 8, 10]
const POOL_MAX = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const duration = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)

/** "3 warm · 2 in use · 1 being built" */
const poolText = ({ counts, target }: WorktreeRepoView) =>
  [
    `${counts.ready} of ${target} warm`,
    counts.attached ? `${counts.attached} in use` : "",
    counts.building ? `${counts.building} being built` : "",
    counts.released ? `${counts.released} being recycled` : "",
  ]
    .filter(Boolean)
    .join(" · ")

/** "34 taken in 7 days · 97% instant · builds take 3m" */
const usageText = ({ usage }: WorktreeRepoView) =>
  [
    usage.taken ? `${usage.taken} taken in the last 7 days` : usage.lastTaken ? `Last taken ${age(usage.lastTaken)} ago` : "Never taken",
    usage.instant !== null ? `${Math.round(usage.instant * 100)}% instant` : "",
    usage.buildMs !== null ? `a build takes ${duration(usage.buildMs)}` : "",
  ]
    .filter(Boolean)
    .join(" · ")

/** Name, base branch, setup command and cap of one repo. */
function RepoEditor({ repo, onDone }: { repo: WorktreeRepoView; onDone(): void }) {
  const [name, setName] = useState(repo.name ?? "")
  const [base, setBase] = useState(repo.baseBranch)
  const [setup, setSetup] = useState(repo.setup ?? "")
  const [maxTotal, setMaxTotal] = useState(String(repo.maxTotal))
  const cap = Math.round(Number(maxTotal))
  const valid = !!base.trim() && cap >= 1
  const save = () => {
    if (!valid) return
    void window.ctrl.configureWorktreeRepo(repo.source, {
      name: name.trim() || null,
      baseBranch: base.trim(),
      setup: setup.trim() || null,
      maxTotal: cap,
    })
    onDone()
  }
  return (
    <div
      className="setting setting-stack tool-editor"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") save()
        if (e.key === "Escape") (e.stopPropagation(), onDone())
      }}
    >
      <label>
        <span>Name</span>
        <input className="setting-input" value={name} autoFocus placeholder={repo.label} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="setting-desc wide">
        Agents can say <code>ctrl worktree up {name.trim() || repo.label}</code> instead of the path.
      </div>
      <label>
        <span>Branch</span>
        <input className="setting-input mono" value={base} spellCheck={false} placeholder="main" onChange={(e) => setBase(e.target.value)} />
      </label>
      <div className="setting-desc wide">New worktrees start at the latest commit of this branch on origin.</div>
      <label>
        <span>Setup</span>
        <input
          className="setting-input mono"
          value={setup}
          spellCheck={false}
          placeholder="None, e.g. pnpm install --frozen-lockfile"
          onChange={(e) => setSetup(e.target.value)}
        />
      </label>
      <div className="setting-desc wide">Runs in every new worktree, and again when one is recycled. Usually installs dependencies.</div>
      <label>
        <span>At most</span>
        <span className="tool-every">
          <input className="setting-input" type="number" min={1} value={maxTotal} onChange={(e) => setMaxTotal(e.target.value)} />
          worktrees on disk. Past it, warm ones stop being built.
        </span>
      </label>
      <div className="setting-actions tool-editor-actions">
        <button
          className="btn worktree-forget"
          disabled={repo.counts.attached > 0}
          title={repo.counts.attached ? "A session still holds a worktree of it" : "Stop managing this repo and remove its warm worktrees"}
          onClick={() => {
            void window.ctrl.forgetWorktreeRepo(repo.source)
            onDone()
          }}
        >
          Forget repo
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid} onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}

function RepoRow({ repo, onEdit }: { repo: WorktreeRepoView; onEdit(): void }) {
  const sizes = repo.warm !== null && !POOL_SIZES.includes(repo.warm) ? [...POOL_SIZES, repo.warm].sort((a, b) => a - b) : POOL_SIZES
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${repo.error ? "failed" : repo.counts.building ? "pending" : repo.counts.ready ? "connected" : "disabled"}`} />
        <div style={{ minWidth: 0 }}>
          <div className="setting-title">{repo.label}</div>
          <div className="setting-desc tool-check" title={repo.source}>
            {shortPath(repo.source)} · {repo.baseBranch} · {repo.setup ? <code className="worktree-setup">{repo.setup}</code> : "no setup"}
          </div>
          <div className="setting-desc">{poolText(repo)}</div>
          <div className="setting-desc">{usageText(repo)}</div>
          {repo.updated && (
            <div className="setting-desc">
              Your checkout: {repo.updated.result.toLowerCase()}, {age(repo.updated.at) === "now" ? "just now" : `${age(repo.updated.at)} ago`}
            </div>
          )}
          {repo.error && <div className="setting-desc mcp-error worktree-error">{repo.error}</div>}
        </div>
      </div>
      <div className="mcp-actions">
        <select
          title="Warm worktrees kept ready for this repo"
          value={repo.warm === null ? AUTO : String(repo.warm)}
          onChange={(e) => void window.ctrl.configureWorktreeRepo(repo.source, { warm: e.target.value === AUTO ? null : Number(e.target.value) })}
        >
          <option value={AUTO}>Auto{repo.auto ? ` (${repo.target} warm)` : ""}</option>
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n} warm
            </option>
          ))}
        </select>
        <button className="icon-btn" title="Edit" onClick={onEdit}>
          <Icon name="compose" />
        </button>
      </div>
    </div>
  )
}

/** What a job last did, and a button to run it now. */
function JobStatus({ id, job }: { id: WorktreeJobID; job: WorktreeJob }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="setting-desc worktree-job">
      {job.at ? `${age(job.at) === "now" ? "Just now" : `${age(job.at)} ago`}: ${job.summary}` : "Hasn't run yet"}
      <button
        className="text-btn"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void window.ctrl.runWorktreeJob(id).finally(() => setBusy(false))
        }}
      >
        {busy ? "Running…" : "Run now"}
      </button>
    </div>
  )
}

/**
 * Settings → Worktrees: where they live, each repo with its pool and usage, and the background jobs that
 * keep the pools warm, sized, clean and up to date. Everything here is set up on its own (agents add repos
 * by taking a worktree), so the page is mostly for seeing what ctrl does and adjusting it.
 */
export function WorktreeSettings({ state }: { state: AppState }) {
  const { worktrees, settings } = state
  const [editing, setEditing] = useState<string | null>(null)
  const set = (patch: Partial<AppState["settings"]>) => void window.ctrl.setSettings(patch)
  const maxes = POOL_MAX.includes(settings.worktreePoolMax) ? POOL_MAX : [...POOL_MAX, settings.worktreePoolMax].sort((a, b) => a - b)
  const total = worktrees.repos.reduce((n, r) => n + r.counts.total, 0)
  const inUse = worktrees.repos.reduce((n, r) => n + r.counts.attached, 0)

  return (
    <>
      <div className="settings-card">
        <div className="setting">
          <div>
            <div className="setting-title">Checkouts for agents</div>
            <div className="setting-desc">
              An agent that needs to work on a repo runs <code>ctrl worktree up &lt;repo&gt;</code> and gets a git worktree
              of its own: at the latest base branch, dependencies installed, taken from a pool ctrl keeps warm so
              there's no wait. It belongs to the agent's session, shows in its resources, and goes back to the pool
              when the session is archived. A session can hold several, of one repo or many.
            </div>
          </div>
        </div>
        <div className="setting">
          <div>
            <div className="setting-title">Folder</div>
            <div className="setting-desc">
              Where worktrees are created. {total ? `${plural(total, "worktree")} now, ${inUse} in use.` : "None yet."} Changing it
              leaves the ones that exist where they are.
            </div>
          </div>
          <div className="setting-actions">
            <span className="setting-path" title={worktrees.root}>
              {`\u200e${shortPath(worktrees.root)}\u200e`}
            </span>
            <button className="btn" onClick={() => void window.ctrl.pickWorktreeRoot()}>
              Change…
            </button>
            {settings.worktreeRoot && (
              <button className="icon-btn" title="Back to the default folder" onClick={() => set({ worktreeRoot: null })}>
                <Icon name="close" />
              </button>
            )}
          </div>
        </div>
      </div>

      <h3 className="settings-subhead">Repositories</h3>
      <div className="settings-card">
        {worktrees.repos.length ? (
          worktrees.repos.map((repo) =>
            editing === repo.source ? (
              <RepoEditor key={repo.source} repo={repo} onDone={() => setEditing(null)} />
            ) : (
              <RepoRow key={repo.source} repo={repo} onEdit={() => setEditing(repo.source)} />
            ),
          )
        ) : (
          <div className="setting">
            <div className="setting-desc">
              No repos yet. A repo is added, with its base branch and setup command detected, the first time an agent
              takes a worktree of it.
            </div>
          </div>
        )}
      </div>

      <h3 className="settings-subhead">Background jobs</h3>
      <div className="settings-card">
        <div className="setting">
          <div>
            <div className="setting-title">Keep pools warm</div>
            <div className="setting-desc">
              Every 10 minutes, and whenever a worktree is taken or released: builds warm worktrees up to each repo's
              pool size, recycles released ones (reset to the base branch, setup run again), and brings warm ones
              older than a day up to date.
            </div>
            <JobStatus id="pool" job={worktrees.jobs.pool} />
          </div>
        </div>
        <div className="setting setting-indent">
          <div>
            <div className="setting-title">Size pools from usage</div>
            <div className="setting-desc">
              Each repo gets the smallest pool that would have served the last 7 days of requests instantly 98% of the
              time. One for a repo not used in a week, none after 30 days. Off: one per repo. A repo with a size picked
              above keeps it.
            </div>
          </div>
          <Toggle on={settings.worktreePoolAuto} onChange={(worktreePoolAuto) => set({ worktreePoolAuto })} />
        </div>
        {settings.worktreePoolAuto && (
          <div className="setting setting-indent">
            <div>
              <div className="setting-title">Largest pool</div>
              <div className="setting-desc">Most warm worktrees a repo sized from usage keeps.</div>
            </div>
            <select value={settings.worktreePoolMax} onChange={(e) => set({ worktreePoolMax: Number(e.target.value) })}>
              {maxes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="setting">
          <div>
            <div className="setting-title">Clean up</div>
            <div className="setting-desc">
              Every hour, and half a minute after a session is archived: gives the worktrees of archived and deleted
              sessions back to the pool (uncommitted changes are discarded, branches stay in the repo), and removes
              folders in the worktree folder that nothing tracks.
            </div>
            <JobStatus id="cleanup" job={worktrees.jobs.cleanup} />
          </div>
          <Toggle on={settings.worktreeCleanup} onChange={(worktreeCleanup) => set({ worktreeCleanup })} />
        </div>

        <div className="setting">
          <div>
            <div className="setting-title">Keep your checkouts up to date</div>
            <div className="setting-desc">
              Every hour: fetches the repos you took worktrees from in the last 30 days and fast-forwards your own
              checkout, only when it's on its base branch with nothing uncommitted. New worktrees start from the latest
              base branch either way.
            </div>
            <JobStatus id="update" job={worktrees.jobs.update} />
          </div>
          <Toggle on={settings.worktreeUpdateRepos} onChange={(worktreeUpdateRepos) => set({ worktreeUpdateRepos })} />
        </div>
      </div>
    </>
  )
}
