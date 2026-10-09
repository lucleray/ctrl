import {
  AdapterError,
  eachLimit,
  firstLine,
  host,
  missing,
  segments,
  UNTIL_MENTIONED,
  type Fetched,
  type MetaRequest,
  type ResourceAdapter,
  type ResourceType,
  type RunCli,
} from "./adapter"

// ---------- links ----------

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

// ---------- live details (slack-cli) ----------

type Json = Record<string, any>

/** Slack API errors that mean "this doesn't exist or this account can't see it". */
const NOT_VISIBLE = /channel_not_found|not_in_channel|thread_not_found|message_not_found|missing_scope|is_archived|access_denied/

/** `slack-cli --json …` always prints { success, data | error }. */
async function slackCli(run: RunCli, args: string[]): Promise<Json | null> {
  const res = await run("slack-cli", ["--json", ...args])
  let body: Json
  try {
    body = JSON.parse(res.stdout)
  } catch {
    throw new AdapterError(res.stderr.trim().split("\n")[0] || "Unexpected output from slack-cli", "network")
  }
  if (body.success) return body.data as Json
  const error = String(body.error ?? "")
  if (/credentials|auth login|not_authed|invalid_auth|token_revoked/i.test(error))
    throw new AdapterError("slack-cli isn't logged in", "logged-out")
  if (/ratelimit|rate limit/i.test(error)) throw new AdapterError("Slack rate limit reached", "rate-limited")
  if (NOT_VISIBLE.test(error)) return null
  throw new AdapterError(error || "slack-cli failed", "network")
}

/** Slack markup to plain text: <url|label>, <@U123>, <#C123|name>, entities, :emoji:. */
const plain = (text: string) =>
  text
    .replace(/<([^|>]+)\|([^>]+)>/g, (_, target: string, label: string) => (target.startsWith("#") ? `#${label}` : label))
    .replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/:[a-z0-9_+-]+:/g, "") // emoji shortcodes
    .replace(/[ \t]+/g, " ")

const permalink = (d: Record<string, string>) =>
  `https://${d.workspace}.slack.com/archives/${d.channel}/${slackPermalinkTs(d.ts)}`

async function fetchOne(run: RunCli, req: MetaRequest): Promise<Fetched> {
  const d = req.data
  if (req.type === "slack-channel") {
    // Only the channel name is kept from the latest message's response.
    const data = await slackCli(run, ["messages", "list", d.channel, "--limit", "1"])
    return data?.channel ? { meta: { title: `#${data.channel}`, subtitle: d.workspace }, cache: UNTIL_MENTIONED } : missing()
  }
  const m = await slackCli(run, ["messages", "get", permalink(d)])
  if (!m) return missing()
  const author = m.userDisplayName || m.userName
  return {
    meta: {
      title: firstLine(plain(m.text ?? "")) ?? "Thread",
      subtitle: [m.channel && `#${m.channel}`, author].filter(Boolean).join(" · "),
    },
    // Root messages and channel names rarely change: keep them until the thread is shared again.
    cache: UNTIL_MENTIONED,
  }
}

let account: string | undefined

export const slack: ResourceAdapter = {
  id: "slack",
  name: "Slack",
  description: "Root message, channel and author for thread links, names for channel links (public channels)",
  types: [slackThread, slackChannel],
  // One CLI call per link, 3 at a time.
  live: {
    cli: {
      command: "slack-cli",
      install: "npm i -g @vercel/slack-cli",
      login: "slack-cli auth login",
      verify: "slack-cli auth status",
    },
    async check({ run }) {
      const status = await slackCli(run, ["auth", "status"])
      if (!status?.authenticated) throw new AdapterError("slack-cli isn't logged in", "logged-out")
      account = status.user ? `${status.user} (${status.team})` : undefined
      return { account }
    },
    batchSize: 15,
    async fetch(batch, { run }) {
      if (!account) {
        const status = await slackCli(run, ["auth", "status"])
        if (status && !status.authenticated) throw new AdapterError("slack-cli isn't logged in", "logged-out")
        account = status?.user ? `${status.user} (${status.team})` : undefined
      }
      const items = new Map<string, Fetched>()
      await eachLimit(batch, 3, async (req) => void items.set(req.id, await fetchOne(run, req)))
      return { items, account }
    },
  },
}
