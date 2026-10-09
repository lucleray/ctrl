// Resources: links worth collecting from chats (PRs, repos, docs, threads,
// deployments…). Each type turns a URL into a canonical identity, so
// /pull/1/changes, /pull/1 and /pull/1#top are one resource. Parsing never
// makes requests: everything comes from the URL itself.
//
// Adding a type: append an entry to RESOURCE_TYPES (order = priority and panel
// order) and bump RESOURCES_VERSION, which re-extracts from already indexed
// messages, without refetching anything.
//
// Live details (PR state, CI…) are separate: resource adapters fetch them
// (src/main/adapters), and the panel shows their title/subtitle over describe()'s.

export const RESOURCES_VERSION = 2

/** Fields parsed from the URL. Parsers omit what the URL doesn't say, so merging keeps what earlier URLs said. */
export type ResourceData = Record<string, string>

export type ParsedResource = {
  type: string
  /** Canonical identity, unique across types: "github-pr:vercel/infra#36612" */
  key: string
  /** Canonical URL to open */
  url: string
  data: ResourceData
}

export type ResourceType = {
  id: string
  /** Panel group heading */
  label: string
  /** Icon name in renderer/icons.tsx */
  icon: string
  /** null when the URL isn't this type */
  parse(url: URL): { identity: string; url: string; data: ResourceData } | null
  /** Display without fetching anything */
  describe(data: ResourceData): { title: string; subtitle?: string }
}

const host = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, "")
const segments = (url: URL) =>
  url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })

/** Slug words from a URL segment: "Agent-docs-381e…" → "Agent docs" */
const slugTitle = (slug: string) => {
  const words = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ---------- GitHub ----------

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

// ---------- Linear ----------

const linearIssue: ResourceType = {
  id: "linear-issue",
  label: "Linear issues",
  icon: "linear",
  parse(url) {
    if (host(url) !== "linear.app") return null
    const [workspace, kind, rawKey, slug] = segments(url)
    const key = rawKey?.toUpperCase()
    if (!workspace || kind !== "issue" || !key || !/^[A-Z][A-Z0-9]*-\d+$/.test(key)) return null
    const data: ResourceData = { workspace, key }
    if (slug) data.title = slugTitle(slug)
    return { identity: `${workspace.toLowerCase()}/${key}`, url: `https://linear.app/${workspace}/issue/${key}`, data }
  },
  describe: (d) => ({ title: d.key, subtitle: d.title }),
}

// ---------- Notion ----------

const NOTION_ID = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i

const notionPage: ResourceType = {
  id: "notion-page",
  label: "Notion",
  icon: "doc",
  parse(url) {
    const h = host(url)
    if (h !== "notion.so" && h !== "notion.com" && !h.endsWith(".notion.so") && !h.endsWith(".notion.site") && !h.endsWith(".notion.com"))
      return null
    // Peek links (?p=<id>) point at the peeked page, not the database behind it.
    const peek = url.searchParams.get("p")?.match(NOTION_ID)
    const last = segments(url).at(-1) ?? ""
    const match = peek ?? last.match(NOTION_ID)
    if (!match) return null
    const id = match.slice(1).join("").toLowerCase()
    const data: ResourceData = { id }
    const slug = peek ? "" : slugTitle(last.slice(0, match.index))
    if (slug) data.title = slug
    return { identity: id, url: `https://www.notion.so/${id}`, data }
  },
  describe: (d) => (d.title ? { title: d.title } : { title: "Notion page", subtitle: d.id.slice(0, 8) }),
}

// ---------- Slack ----------

function slackChannelPath(url: URL) {
  const h = host(url)
  if (!h.endsWith(".slack.com") || h === "app.slack.com") return null
  const [archives, channel, message] = segments(url)
  if (archives !== "archives" || !channel || !/^[CGD][A-Z0-9]{6,}$/.test(channel)) return null
  // Enterprise Grid serves one channel from several hosts (vercel.slack.com, vercel.enterprise.slack.com),
  // and channel ids are unique across the grid: key on the channel alone.
  const workspace = h.slice(0, -".slack.com".length).replace(/\.enterprise$/, "")
  return { workspace, channel, message }
}

/** "1791466124.100259" → "p1791466124100259" */
const slackPermalinkTs = (ts: string) => `p${ts.replace(".", "")}`

const slackThread: ResourceType = {
  id: "slack-thread",
  label: "Slack threads",
  icon: "thread",
  parse(url) {
    const c = slackChannelPath(url)
    const p = c?.message?.match(/^p(\d{10})(\d{6})$/)
    if (!c || !p) return null
    // A reply's link carries its thread's root: collapse replies into their thread.
    const root = url.searchParams.get("thread_ts")
    const ts = root && /^\d{10}\.\d{6}$/.test(root) ? root : `${p[1]}.${p[2]}`
    return {
      identity: `${c.channel}/${ts}`,
      url: `https://${c.workspace}.slack.com/archives/${c.channel}/${slackPermalinkTs(ts)}`,
      data: { workspace: c.workspace, channel: c.channel, ts },
    }
  },
  describe: (d) => ({
    title: `Thread · ${new Date(Number(d.ts.split(".")[0]) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    subtitle: `${d.workspace} · ${d.channel}`,
  }),
}

const slackChannel: ResourceType = {
  id: "slack-channel",
  label: "Slack channels",
  icon: "hash",
  parse(url) {
    const c = slackChannelPath(url)
    if (!c || c.message) return null
    return {
      identity: c.channel,
      url: `https://${c.workspace}.slack.com/archives/${c.channel}`,
      data: { workspace: c.workspace, channel: c.channel },
    }
  },
  describe: (d) => ({ title: d.channel, subtitle: d.workspace }),
}

// ---------- Vercel ----------

// First path segments on vercel.com that are site pages, not teams.
const VERCEL_RESERVED = new Set(
  "abuse academy account ai api blog careers changelog contact customers d dashboard design docs download enterprise events font frameworks geist go guides help home integrations kb legal login marketplace new oss partners pricing products resources security signup solutions startups storage support templates try v0".split(
    " ",
  ),
)

// A team or project page under vercel.com/<team>/<project>/<page>, not a deployment id.
const VERCEL_PROJECT_PAGES = new Set(
  "activity ai analytics deployments domains environment-variables firewall integrations logs observability settings speed-insights storage stores usage".split(
    " ",
  ),
)

function vercelDashboard(url: URL) {
  if (host(url) !== "vercel.com") return null
  const [team, project, third] = segments(url)
  if (!team || !project || VERCEL_RESERVED.has(team) || project === "~" || !/^[\w.-]+$/.test(team + project)) return null
  return { team, project, third }
}

const vercelDeployment: ResourceType = {
  id: "vercel-deployment",
  label: "Vercel deployments",
  icon: "triangle",
  parse(url): ReturnType<ResourceType["parse"]> {
    const h = host(url)
    // Preview and production URLs on vercel.app: the host is the deployment.
    if (h.endsWith(".vercel.app") && h !== "vercel.app") return { identity: h, url: `https://${h}`, data: { host: h } }
    // Dashboard deployment pages: vercel.com/<team>/<project>/<deployment id>
    const d = vercelDashboard(url)
    if (!d?.third || VERCEL_PROJECT_PAGES.has(d.third) || !/^[A-Za-z0-9]{16,}$/.test(d.third) || !/[A-Z0-9]/.test(d.third))
      return null
    return {
      identity: `${d.team}/${d.project}/${d.third}`,
      url: `https://vercel.com/${d.team}/${d.project}/${d.third}`,
      data: { team: d.team, project: d.project, deployment: d.third },
    }
  },
  describe: (d) =>
    d.host ? { title: d.host } : { title: `${d.project} · ${d.deployment.slice(0, 9)}`, subtitle: d.team },
}

const vercelProject: ResourceType = {
  id: "vercel-project",
  label: "Vercel projects",
  icon: "triangle",
  parse(url) {
    const d = vercelDashboard(url)
    if (!d) return null
    return { identity: `${d.team}/${d.project}`, url: `https://vercel.com/${d.team}/${d.project}`, data: { team: d.team, project: d.project } }
  },
  describe: (d) => ({ title: d.project, subtitle: d.team }),
}

export const RESOURCE_TYPES: ResourceType[] = [
  githubPr,
  githubIssue,
  githubCommit,
  githubRepoType,
  linearIssue,
  notionPage,
  slackThread,
  slackChannel,
  vercelDeployment,
  vercelProject,
]

const TYPES = new Map(RESOURCE_TYPES.map((t) => [t.id, t]))
export const resourceType = (id: string) => TYPES.get(id)

/** The first type that recognizes the URL, or null. */
export function parseResourceUrl(raw: string): ParsedResource | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  for (const type of RESOURCE_TYPES) {
    const r = type.parse(url)
    if (r) return { type: type.id, key: `${type.id}:${r.identity}`, url: r.url, data: r.data }
  }
  return null
}

// Stops at whitespace, quotes, brackets and markdown/backtick delimiters.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi

/** Every recognized resource in a text, once each (first occurrence wins). */
export function extractResources(text: string): ParsedResource[] {
  const out = new Map<string, ParsedResource>()
  for (const [match] of text.matchAll(URL_RE)) {
    const raw = match.replace(/[.,;:!?*_~]+$/, "")
    const r = parseResourceUrl(raw)
    if (!r) continue
    const seen = out.get(r.key)
    if (seen) Object.assign(seen.data, r.data)
    else out.set(r.key, r)
  }
  return [...out.values()]
}
