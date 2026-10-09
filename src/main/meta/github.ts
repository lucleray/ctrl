import { execFile } from "node:child_process"
import type { ResourceMeta } from "../../shared/types"
import { DAY, MINUTE, ProviderError, type MetaRequest, type Provider, type ProviderResult } from "./provider"

/**
 * Reuses the gh CLI's login, so there's nothing to set up in ctrl. GH_TOKEN /
 * GITHUB_TOKEN win, like they do for gh itself.
 */
class GithubToken {
  private token?: Promise<string>

  get(): Promise<string> {
    this.token ??= this.read().catch((err) => {
      this.token = undefined
      throw err
    })
    return this.token
  }

  reset() {
    this.token = undefined
  }

  private read(): Promise<string> {
    const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    if (env) return Promise.resolve(env)
    return new Promise((resolve, reject) => {
      execFile("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 5000 }, (err, stdout) => {
        const token = stdout?.trim()
        if (token && !err) return resolve(token)
        if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT")
          return reject(new ProviderError("GitHub CLI (gh) isn't installed", "no-cli"))
        reject(new ProviderError("gh isn't logged in", "logged-out"))
      })
    })
  }
}

const PR_FIELDS = `title state isDraft reviewDecision mergeable additions deletions author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`
const ISSUE_FIELDS = `title state stateReason author { login }`
const COMMIT_FIELDS = `messageHeadline statusCheckRollup { state } author { name user { login } }`

const ci = (state?: string | null): ResourceMeta["ci"] =>
  state === "SUCCESS"
    ? "success"
    : state === "FAILURE" || state === "ERROR"
      ? "failure"
      : state === "PENDING" || state === "EXPECTED"
        ? "pending"
        : undefined

type Node = Record<string, any>

function issueOrPr(n: Node, fetched: number): ResourceMeta {
  if (n.__typename === "PullRequest") {
    const state = n.state === "MERGED" ? "merged" : n.state === "CLOSED" ? "closed" : n.isDraft ? "draft" : "open"
    const open = state === "open" || state === "draft"
    return {
      title: n.title,
      state,
      ci: ci(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
      review:
        n.reviewDecision === "APPROVED"
          ? "approved"
          : n.reviewDecision === "CHANGES_REQUESTED"
            ? "changes"
            : n.reviewDecision === "REVIEW_REQUIRED"
              ? "required"
              : undefined,
      // GitHub only computes mergeability for open PRs; UNKNOWN means it's still working on it.
      conflicts: open && n.mergeable === "CONFLICTING" ? true : open && n.mergeable === "UNKNOWN" ? undefined : false,
      author: n.author?.login,
      additions: n.additions,
      deletions: n.deletions,
      fetched,
    }
  }
  const state =
    n.state === "OPEN" ? "open" : n.stateReason === "NOT_PLANNED" || n.stateReason === "DUPLICATE" ? "not-planned" : "completed"
  return { title: n.title, state, author: n.author?.login, fetched }
}

/** GraphQL aliases must be identifiers. */
const alias = (prefix: string, raw: string) => prefix + raw.replace(/[^A-Za-z0-9_]/g, "_")

/**
 * One GraphQL request for the whole batch, grouped by repo: ~40 PRs, issues
 * and commits cost about 1 point of the 5,000/hour budget.
 */
type RepoGroup = { alias: string; owner: string; name: string; items: { req: MetaRequest; field: string }[] }

async function fetchGithub(token: string, items: MetaRequest[]): Promise<ProviderResult> {
  const repos = new Map<string, RepoGroup>()
  for (const req of items) {
    const [owner, name] = (req.data.repo ?? "").split("/")
    if (!owner || !name) continue
    const key = `${owner}/${name}`.toLowerCase()
    let repo = repos.get(key)
    if (!repo) repos.set(key, (repo = { alias: `r${repos.size}`, owner, name, items: [] }))
    const field =
      req.type === "github-commit"
        ? alias("c", req.data.sha)
        : req.type === "github-repo"
          ? "description"
          : alias("n", req.data.number)
    repo.items.push({ req, field })
  }

  const parts = [...repos.values()].map((repo) => {
    const fields = new Set<string>()
    for (const { req, field } of repo.items) {
      if (req.type === "github-repo") fields.add("description isArchived")
      else if (req.type === "github-commit")
        fields.add(`${field}: object(expression: ${JSON.stringify(req.data.sha)}) { ... on Commit { ${COMMIT_FIELDS} } }`)
      else
        fields.add(
          `${field}: issueOrPullRequest(number: ${Number(req.data.number)}) { __typename ... on PullRequest { ${PR_FIELDS} } ... on Issue { ${ISSUE_FIELDS} } }`,
        )
    }
    return `${repo.alias}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ${[...fields].join(" ")} }`
  })
  const query = `query { viewer { login } rateLimit { remaining limit resetAt cost } ${parts.join(" ")} }`

  let res: Response
  try {
    res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "ctrl" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new ProviderError(`Can't reach GitHub: ${err instanceof Error ? err.message : err}`, "network")
  }
  if (res.status === 401) throw new ProviderError("GitHub rejected gh's token", "logged-out")
  if (res.status === 403 || res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"))
    const reset = Number(res.headers.get("x-ratelimit-reset"))
    const retryAt = retryAfter ? Date.now() + retryAfter * 1000 : reset ? reset * 1000 : Date.now() + 5 * 60_000
    throw new ProviderError("GitHub rate limit reached", "rate-limited", retryAt)
  }
  if (!res.ok) throw new ProviderError(`GitHub returned ${res.status}`, "network")

  const body = (await res.json()) as { data?: Node; errors?: { type?: string; message: string }[] }
  const data = body.data
  if (!data) throw new ProviderError(body.errors?.[0]?.message ?? "Empty response from GitHub", "network")

  const fetched = Date.now()
  const metas = new Map<string, ResourceMeta>()
  for (const repo of repos.values()) {
    const r = data[repo.alias] as Node | null
    for (const { req, field } of repo.items) {
      if (!r) {
        metas.set(req.id, { missing: true, fetched })
      } else if (req.type === "github-repo") {
        metas.set(req.id, { description: r.description ?? undefined, archived: !!r.isArchived, fetched })
      } else if (!r[field]) {
        metas.set(req.id, { missing: true, fetched })
      } else if (req.type === "github-commit") {
        const c = r[field] as Node
        metas.set(req.id, {
          title: c.messageHeadline,
          ci: ci(c.statusCheckRollup?.state),
          author: c.author?.user?.login ?? c.author?.name,
          fetched,
        })
      } else {
        metas.set(req.id, issueOrPr(r[field], fetched))
      }
    }
  }
  const rl = data.rateLimit as Node | undefined
  return {
    metas,
    account: data.viewer?.login,
    rate: rl
      ? { remaining: rl.remaining, limit: rl.limit, resetAt: Date.parse(rl.resetAt), cost: rl.cost }
      : undefined,
  }
}

/**
 * Things that are moving (CI running, GitHub computing mergeability) refresh
 * every minute, settled ones rarely. Merged PRs can't change state again, so
 * they're never refetched (closed ones can be reopened).
 */
function ttl(type: string, m: ResourceMeta) {
  if (m.missing) return DAY
  if (type === "github-repo") return 7 * DAY
  if (type === "github-commit") return m.ci === "pending" ? MINUTE : DAY
  const open = m.state === "open" || m.state === "draft"
  if (type === "github-pr" && m.state === "merged") return Infinity
  if (!open) return DAY
  if (type === "github-pr" && (m.ci === "pending" || m.conflicts === undefined)) return MINUTE
  if (m.state === "draft") return 10 * MINUTE
  return type === "github-pr" ? 5 * MINUTE : 10 * MINUTE
}

export function githubProvider(): Provider {
  const token = new GithubToken()
  return {
    id: "github",
    batchSize: 40,
    ttl,
    resetAuth: () => token.reset(),
    async fetch(batch) {
      try {
        return await fetchGithub(await token.get(), batch)
      } catch (err) {
        // gh may have refreshed or switched accounts: re-read the token once.
        if (!(err instanceof ProviderError && err.kind === "logged-out")) throw err
        token.reset()
        return fetchGithub(await token.get(), batch)
      }
    },
  }
}
