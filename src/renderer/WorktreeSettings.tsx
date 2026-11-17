import { useState } from "react"
import type { AppState } from "../shared/types"
import type { WorktreeJob, WorktreeJobID, WorktreeRepoView } from "../shared/worktrees"
import { age, shortPath } from "./format"
import { Icon } from "./icons"
import { Toggle } from "./Toggle"

const AUTO = "auto"
const POOL_SIZES = [0, 1, 2, 3, 4, 5, 6, 8, 10]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** "3 warm · 2 in use · 97% instant": instant is the share of the last 7 days' requests the pool served right away */
const poolText = ({ counts, usage }: WorktreeRepoView) =>
  [
    `${counts.ready} warm`,
    `${counts.attached} in use`,
    counts.building ? `${counts.building} being built` : "",
    usage.instant !== null ? `${Math.round(usage.instant * 100)}% instant` : "",
  ]
    .filter(Boolean)
    .join(" · ")

/** Name, base branch, setup command and cap of one repo. */
function RepoEditor({ repo, onDone }: { repo: WorktreeRepoView; onDone(): void }) {
  const [name, setName] = useState(repo.name ?? "")
  const [base, setBase] = useState(repo.baseBranch)
  const [setup, setSetup] = useState(repo.setup ?? "")
  const [maxTotal, setMaxTotal] = useState(String(repo.maxTotal))
  const [warm, setWarm] = useState(repo.warm === null ? AUTO : String(repo.warm))
  const sizes = repo.warm !== null && !POOL_SIZES.includes(repo.warm) ? [...POOL_SIZES, repo.warm].sort((a, b) => a - b) : POOL_SIZES
  const cap = Math.round(Number(maxTotal))
  const valid = !!base.trim() && cap >= 1
  const save = () => {
    if (!valid) return
    void window.ctrl.configureWorktreeRepo(repo.source, {
      name: name.trim() || null,
      baseBranch: base.trim(),
      setup: setup.trim() || null,
      warm: warm === AUTO ? null : Number(warm),
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
      <div className="setting-title">{repo.label}</div>
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
        <span>Pool</span>
        <select value={warm} onChange={(e) => setWarm(e.target.value)}>
          <option value={AUTO}>Auto{repo.auto ? ` (${repo.target} warm now)` : ""}</option>
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n} warm
            </option>
          ))}
        </select>
      </label>
      <div className="setting-desc wide">Worktrees kept ready so taking one is instant. Auto sizes the pool from how often you take one.</div>
      <label>
        <span>At most</span>
        <span className="tool-every">
          <input className="setting-input" type="number" min={1} value={maxTotal} onChange={(e) => setMaxTotal(e.target.value)} />
          worktrees on disk, warm and in use. Past it, warm ones stop being built.
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
  return (
    <div className="setting">
      <div className="mcp-name">
        <span className={`mcp-dot ${repo.error ? "failed" : repo.counts.building ? "pending" : repo.counts.ready ? "connected" : "disabled"}`} />
        <div style={{ minWidth: 0 }}>
          <div className="setting-title">{repo.label}</div>
          <div className="setting-desc worktree-line" title={`${repo.source} · ${repo.baseBranch} · ${repo.setup ?? "no setup"}`}>
            {shortPath(repo.source)} · {repo.baseBranch} · {repo.setup ? <code>{repo.setup}</code> : "no setup"}
          </div>
          <div className="setting-desc">{poolText(repo)}</div>
          {repo.updated && (
            <div className="setting-desc">
              Your checkout: {repo.updated.result.toLowerCase()}, {age(repo.updated.at) === "now" ? "just now" : `${age(repo.updated.at)} ago`}
            </div>
          )}
          {repo.error && <div className="setting-desc mcp-error worktree-error">{repo.error}</div>}
        </div>
      </div>
      <div className="mcp-actions">
        <button className="icon-btn" title="Repo settings" onClick={onEdit}>
          <Icon name="settings" />
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
 * Settings → Worktrees: where they live, each repo with its pool (its settings behind the gear), and the
 * background jobs that size the pools, clean up and keep checkouts up to date. Everything here is set up on its own (agents add repos
 * by taking a worktree), so the page is mostly for seeing what ctrl does and adjusting it.
 */
export function WorktreeSettings({ state }: { state: AppState }) {
  const { worktrees, settings } = state
  const [editing, setEditing] = useState<string | null>(null)
  const set = (patch: Partial<AppState["settings"]>) => void window.ctrl.setSettings(patch)
  const total = worktrees.repos.reduce((n, r) => n + r.counts.total, 0)
  const inUse = worktrees.repos.reduce((n, r) => n + r.counts.attached, 0)

  return (
    <>
      <div className="settings-card">
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
            <div className="setting-title">Size pools from usage</div>
            <div className="setting-desc">
              Each repo keeps the smallest pool that would have served the last 7 days of requests instantly 98% of the
              time, refilled as soon as a worktree is taken. One for a repo not used in a week, none after 30 days.
              Off: one per repo. A size picked in a repo's settings wins.
            </div>
          </div>
          <Toggle on={settings.worktreePoolAuto} onChange={(worktreePoolAuto) => set({ worktreePoolAuto })} />
        </div>
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
