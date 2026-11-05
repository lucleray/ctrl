import type { ResourceMeta, Tone } from "../types"
import {
  AdapterError,
  byRecency,
  type Placement,
  chip,
  chips,
  DAY,
  every,
  FINAL,
  firstLine,
  MINUTE,
  missing,
  segments,
  host,
  type Fetched,
  type MetaRequest,
  type ResourceAdapter,
  type ResourceType,
} from "./adapter"

// ---------- links ----------

// First path segments that are GitHub pages, not owners.
const GITHUB_RESERVED = new Set(
  "about account apps codespaces collections contact copilot customer-stories dashboard enterprise events explore features gist github-copilot issues join login logout marketplace new notifications orgs organizations pricing pulls readme search security settings site sponsors stars team topics trending users watching".split(
    " ",
  ),
)

function githubRepo(url: URL) {
  if (host(url) !== "github.com") return null
  const [owner, rawRepo, ...rest] = segments(url)
  if (!owner || !rawRepo || GITHUB_RESERVED.has(owner.toLowerCase())) return null
  const repo = rawRepo.replace(/\.git$/, "")
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null
  // GitHub names are case-insensitive: key on lowercase, keep the original spelling for display.
  return { owner, repo, rest, slug: `${owner}/${repo}`, id: `${owner}/${repo}`.toLowerCase() }
}

const githubPr: ResourceType = {
  id: "github-pr",
  label: "Pull requests",
  icon: "git-pr",
  parse(url) {
    const r = githubRepo(url)
    if (!r || r.rest[0] !== "pull" || !/^\d+$/.test(r.rest[1] ?? "")) return null
    return {
      identity: `${r.id}#${r.rest[1]}`,
      url: `https://github.com/${r.slug}/pull/${r.rest[1]}`,
      data: { repo: r.slug, number: r.rest[1] },
    }
  },
  describe: (d) => ({ title: `${d.repo}#${d.number}` }),
  // Open and draft PRs (or not fetched yet) first, then merged, then closed.
  rank: (meta) => ({ merged: 1, closed: 2 })[meta?.fields?.state as string] ?? 0,
  stage: ({ meta, last }, { me, now }) => prStage(meta?.missing ? undefined : meta?.fields, last, me, now),
}

type Fields = NonNullable<ResourceMeta["fields"]>

/** Whose turn it is on a PR: yours (author or requested reviewer), a reviewer's, CI's, or nobody's. */
function prStage(f: Fields | undefined, last: number, me: string | undefined, now: number): Placement {
  if (!f?.state) return byRecency(last, now)
  if (f.state === "merged") return { stage: "done", reason: "Merged" }
  if (f.state === "closed") return { stage: "done", reason: "Closed" }
  const same = (a: unknown) => !!me && typeof a === "string" && a.toLowerCase() === me.toLowerCase()
  const reviewers = String(f.reviewers ?? "").split(",").filter(Boolean)
  const waitingOn = reviewers.length ? `Waiting on ${reviewers.map((r) => `@${r}`).join(", ")}` : "Waiting on review"
  // Without a login to compare, every PR counts as yours: the board is about your work.
  const mine = !me || !f.author || same(f.author)
  if (!mine) {
    if (reviewers.some(same)) return { stage: "you", reason: "Your review is requested" }
    if (f.review === "approved") return { stage: "waiting", reason: `Approved, @${f.author} to merge` }
    return { stage: "waiting", reason: `@${f.author}'s PR` }
  }
  if (f.ci === "failure") return { stage: "you", reason: "CI failed" }
  if (f.mergeable === "conflicting") return { stage: "you", reason: "Merge conflicts" }
  if (f.review === "changes_requested") return { stage: "you", reason: "Changes requested" }
  if (f.draft) return { stage: "moving", reason: f.ci === "pending" ? "Draft, CI running" : "Draft" }
  if (f.review === "approved")
    return f.ci === "pending" ? { stage: "moving", reason: "Approved, CI running" } : { stage: "you", reason: "Approved, ready to merge" }
  if (reviewers.length) return { stage: "waiting", reason: waitingOn }
  if (f.ci === "pending") return { stage: "moving", reason: "CI running" }
  if (f.review === "review_required") return { stage: "you", reason: "No reviewer requested" }
  return { stage: "you", reason: "Ready to merge" }
}

const githubIssue: ResourceType = {
  id: "github-issue",
  label: "Issues",
  icon: "issue",
  parse(url) {
    const r = githubRepo(url)
    if (!r || r.rest[0] !== "issues" || !/^\d+$/.test(r.rest[1] ?? "")) return null
    return {
      identity: `${r.id}#${r.rest[1]}`,
      url: `https://github.com/${r.slug}/issues/${r.rest[1]}`,
      data: { repo: r.slug, number: r.rest[1] },
    }
  },
  describe: (d) => ({ title: `${d.repo}#${d.number}` }),
  stage: ({ meta, last }, { now }) => {
    const state = meta?.fields?.state
    if (!state) return byRecency(last, now)
    return state === "open" ? { stage: "moving", reason: "Open" } : { stage: "done", reason: "Closed" }
  },
}

const githubCommit: ResourceType = {
  id: "github-commit",
  label: "Commits",
  icon: "commit",
  parse(url) {
    const r = githubRepo(url)
    const sha = r?.rest[0] === "commit" ? r.rest[1]?.toLowerCase() : undefined
    if (!r || !sha || !/^[0-9a-f]{7,40}$/.test(sha)) return null
    return {
      identity: `${r.id}@${sha}`,
      url: `https://github.com/${r.slug}/commit/${sha}`,
      data: { repo: r.slug, sha },
    }
  },
  describe: (d) => ({ title: `${d.repo}@${d.sha.slice(0, 7)}` }),
  // Commits only make the board while their CI needs watching.
  stage: ({ meta }) =>
    meta?.fields?.ci === "failure"
      ? { stage: "you", reason: "CI failed" }
      : meta?.fields?.ci === "pending"
        ? { stage: "moving", reason: "CI running" }
        : null,
}

const githubRepoType: ResourceType = {
  id: "github-repo",
  label: "Repositories",
  icon: "repo",
  // Any other repo page (tree, blob, actions…) counts as the repo.
  parse(url) {
    const r = githubRepo(url)
    if (!r) return null
    return { identity: r.id, url: `https://github.com/${r.slug}`, data: { repo: r.slug } }
  },
  describe: (d) => ({ title: d.repo }),
}

// ---------- live details (gh api graphql) ----------

const PR_FIELDS = `title state isDraft reviewDecision mergeable additions deletions author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }`
const ISSUE_FIELDS = `title state stateReason author { login }`
const COMMIT_FIELDS = `messageHeadline statusCheckRollup { state } author { name user { login } }`

type Node = Record<string, any>
type Ci = "success" | "failure" | "pending" | undefined

const ciOf = (state?: string | null): Ci =>
  state === "SUCCESS"
    ? "success"
    : state === "FAILURE" || state === "ERROR"
      ? "failure"
      : state === "PENDING" || state === "EXPECTED"
        ? "pending"
        : undefined

const ciChip = (ci: Ci) =>
  ci === "success"
    ? chip("✓ CI", "good", "Checks passed")
    : ci === "failure"
      ? chip("✗ CI", "bad", "Checks failed")
      : ci === "pending"
        ? chip("● CI", "warn", "Checks running")
        : undefined

const by = (login?: string) => (login ? `by @${login}` : undefined)
const line = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ")

/** GraphQL enums as agents read them: "CHANGES_REQUESTED" → "changes_requested", null when absent. */
const lower = (value?: string | null) => (value ? value.toLowerCase() : null)

function pullRequest(n: Node, ref: string): Fetched {
  const ci = ciOf(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state)
  const fields = {
    state: lower(n.state),
    draft: !!n.isDraft,
    ci: ci ?? null,
    review: lower(n.reviewDecision),
    mergeable: n.state === "OPEN" ? lower(n.mergeable) : null,
    author: n.author?.login ?? null,
    additions: n.additions ?? null,
    deletions: n.deletions ?? null,
    // Still pending review requests, comma-separated logins (teams by slug); null when none.
    reviewers:
      (n.reviewRequests?.nodes ?? [])
        .map((r: Node) => r.requestedReviewer?.login ?? r.requestedReviewer?.slug)
        .filter(Boolean)
        .join(",") || null,
  }
  const meta = { title: n.title, subtitle: ref, details: [line(by(n.author?.login), `+${n.additions} −${n.deletions}`)], fields }
  // Merged is final; closed PRs can be reopened.
  if (n.state === "MERGED") return { meta: { ...meta, tone: "done", chips: [chip("merged", "done", "Merged")] }, cache: FINAL }
  if (n.state === "CLOSED") return { meta: { ...meta, tone: "bad", chips: [chip("closed", "bad", "Closed")] }, cache: every(DAY) }

  const draft = n.isDraft
  // GitHub computes mergeability lazily: UNKNOWN means ask again soon.
  const computing = n.mergeable === "UNKNOWN"
  const list = chips([
    draft && chip("draft", "muted", "Draft"),
    ciChip(ci),
    n.mergeable === "CONFLICTING" && chip("conflicts", "bad", "Merge conflicts"),
    n.reviewDecision === "APPROVED" && chip("approved", "good", "Approved"),
    n.reviewDecision === "CHANGES_REQUESTED" && chip("changes", "bad", "Changes requested"),
    !draft && n.reviewDecision === "REVIEW_REQUIRED" && chip("review", "muted", "Review required"),
  ])
  const maxAge = ci === "pending" || computing ? MINUTE : draft ? 10 * MINUTE : 5 * MINUTE
  return { meta: { ...meta, tone: draft ? "muted" : "open", chips: list }, cache: every(maxAge) }
}

function issue(n: Node, ref: string): Fetched {
  const open = n.state === "OPEN"
  const notPlanned = n.stateReason === "NOT_PLANNED" || n.stateReason === "DUPLICATE"
  const tone: Tone = open ? "open" : notPlanned ? "muted" : "done"
  const state = open ? "Open" : notPlanned ? "Closed as not planned" : "Closed as completed"
  return {
    meta: {
      title: n.title,
      subtitle: ref,
      tone,
      details: [line(state, by(n.author?.login))],
      fields: { state: lower(n.state), stateReason: lower(n.stateReason), author: n.author?.login ?? null },
    },
    cache: every(open ? 10 * MINUTE : DAY),
  }
}

function commit(c: Node, ref: string): Fetched {
  const ci = ciOf(c.statusCheckRollup?.state)
  const ciTone: Record<string, Tone> = { success: "good", failure: "bad", pending: "warn" }
  const author = c.author?.user?.login ? `by @${c.author.user.login}` : c.author?.name && `by ${c.author.name}`
  return {
    meta: {
      title: firstLine(c.messageHeadline),
      subtitle: ref,
      tone: ci ? ciTone[ci] : undefined,
      chips: chips([ciChip(ci)]),
      details: author ? [author] : undefined,
      fields: { ci: ci ?? null, author: c.author?.user?.login ?? c.author?.name ?? null },
    },
    // A commit only changes while its CI runs.
    cache: ci === "pending" ? every(MINUTE) : FINAL,
  }
}

const repo = (r: Node): Fetched => ({
  meta: {
    subtitle: r.description || undefined,
    chips: r.isArchived ? [chip("archived", "muted", "Archived repository")] : undefined,
    fields: { archived: !!r.isArchived, description: r.description || null },
  },
  cache: every(7 * DAY),
})

/** GraphQL aliases must be identifiers. */
const alias = (prefix: string, raw: string) => prefix + raw.replace(/[^A-Za-z0-9_]/g, "_")

type RepoGroup = { alias: string; owner: string; name: string; items: { req: MetaRequest; field: string }[] }

/** One GraphQL query for the whole batch, grouped by repo. */
function buildQuery(batch: MetaRequest[]) {
  const repos = new Map<string, RepoGroup>()
  for (const req of batch) {
    const [owner, name] = (req.data.repo ?? "").split("/")
    if (!owner || !name) continue
    const key = `${owner}/${name}`.toLowerCase()
    let group = repos.get(key)
    if (!group) repos.set(key, (group = { alias: `r${repos.size}`, owner, name, items: [] }))
    const field =
      req.type === "github-commit" ? alias("c", req.data.sha) : req.type === "github-repo" ? "" : alias("n", req.data.number)
    group.items.push({ req, field })
  }
  const parts = [...repos.values()].map((g) => {
    const fields = new Set<string>()
    for (const { req, field } of g.items) {
      if (req.type === "github-repo") fields.add("description isArchived")
      else if (req.type === "github-commit")
        fields.add(`${field}: object(expression: ${JSON.stringify(req.data.sha)}) { ... on Commit { ${COMMIT_FIELDS} } }`)
      else
        fields.add(
          `${field}: issueOrPullRequest(number: ${Number(req.data.number)}) { __typename ... on PullRequest { ${PR_FIELDS} } ... on Issue { ${ISSUE_FIELDS} } }`,
        )
    }
    return `${g.alias}: repository(owner: ${JSON.stringify(g.owner)}, name: ${JSON.stringify(g.name)}) { ${[...fields].join(" ")} }`
  })
  return { repos, query: `query { viewer { login } ${parts.join(" ")} }` }
}

export const github: ResourceAdapter = {
  id: "github",
  name: "GitHub",
  description: "Titles, PR state, CI, reviews and conflicts for PRs, issues, commits and repos",
  types: [githubPr, githubIssue, githubCommit, githubRepoType],
  // ~40 links per request, for about 1 point of GitHub's 5,000/hour.
  live: {
    cli: { command: "gh", install: "brew install gh", login: "gh auth login", verify: "gh api user --jq .login" },
    async check({ run }) {
      const res = await run("gh", ["api", "user", "--jq", ".login"])
      if (res.code === 0) return { account: res.stdout.trim() || undefined }
      const err = res.stderr.trim()
      if (res.code === 4 || /gh auth login|not logged|authentication/i.test(err)) throw new AdapterError("gh isn't logged in", "logged-out")
      throw new AdapterError(err.split("\n")[0] || "gh api failed", "network")
    },
    batchSize: 40,
    async fetch(batch, { run }) {
      const { repos, query } = buildQuery(batch)
      const res = await run("gh", ["api", "graphql", "-f", `query=${query}`])
      // gh exits 1 when part of the query failed (a repo or PR not found), but still prints the data.
      let body: { data?: Node; errors?: { message: string }[] } | undefined
      try {
        body = JSON.parse(res.stdout)
      } catch {
        const err = res.stderr.trim()
        if (/gh auth login|not logged|authentication/i.test(err)) throw new AdapterError("gh isn't logged in", "logged-out")
        if (/rate limit/i.test(err)) throw new AdapterError("GitHub rate limit reached", "rate-limited")
        throw new AdapterError(err.split("\n")[0] || "gh api failed", "network")
      }
      const data = body?.data
      if (!data) throw new AdapterError(body?.errors?.[0]?.message ?? "Empty response from GitHub", "network")

      const items = new Map<string, Fetched>()
      for (const g of repos.values()) {
        const r = data[g.alias] as Node | null
        for (const { req, field } of g.items) {
          const node = req.type === "github-repo" ? r : r?.[field]
          if (!node) items.set(req.id, missing())
          else if (req.type === "github-repo") items.set(req.id, repo(node))
          else if (req.type === "github-commit") items.set(req.id, commit(node, `${g.owner}/${g.name}@${req.data.sha.slice(0, 7)}`))
          else {
            const ref = `${g.owner}/${g.name}#${req.data.number}`
            items.set(req.id, node.__typename === "PullRequest" ? pullRequest(node, ref) : issue(node, ref))
          }
        }
      }
      return { items, account: data.viewer?.login }
    },
  },
}
