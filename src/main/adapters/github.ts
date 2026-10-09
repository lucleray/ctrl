import type { Tone } from "../../shared/types"
import {
  AdapterError,
  chip,
  chips,
  DAY,
  every,
  FINAL,
  firstLine,
  MINUTE,
  missing,
  runCli,
  type Fetched,
  type MetaRequest,
  type ResourceAdapter,
} from "./adapter"

const PR_FIELDS = `title state isDraft reviewDecision mergeable additions deletions author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`
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

function pullRequest(n: Node, ref: string): Fetched {
  const ci = ciOf(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state)
  const meta = { title: n.title, subtitle: ref, details: [line(by(n.author?.login), `+${n.additions} −${n.deletions}`)] }
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
    meta: { title: n.title, subtitle: ref, tone, details: [line(state, by(n.author?.login))] },
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
    },
    // A commit only changes while its CI runs.
    cache: ci === "pending" ? every(MINUTE) : FINAL,
  }
}

const repo = (r: Node): Fetched => ({
  meta: {
    subtitle: r.description || undefined,
    chips: r.isArchived ? [chip("archived", "muted", "Archived repository")] : undefined,
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

/** PRs, issues, commits and repos, ~40 per request for about 1 point of GitHub's 5,000/hour. */
export const github: ResourceAdapter = {
  id: "github",
  name: "GitHub",
  description: "Titles, PR state, CI, reviews and conflicts for PRs, issues, commits and repos",
  types: ["github-pr", "github-issue", "github-commit", "github-repo"],
  cli: { command: "gh", install: "brew install gh", login: "gh auth login" },
  batchSize: 40,

  async fetch(batch) {
    const { repos, query } = buildQuery(batch)
    const res = await runCli("gh", ["api", "graphql", "-f", `query=${query}`])
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
}
