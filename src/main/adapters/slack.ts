import { AdapterError, eachLimit, firstLine, missing, runCli, UNTIL_MENTIONED, type Fetched, type MetaRequest, type ResourceAdapter } from "./adapter"

type Json = Record<string, any>

/** Slack API errors that mean "this doesn't exist or this account can't see it". */
const NOT_VISIBLE = /channel_not_found|not_in_channel|thread_not_found|message_not_found|missing_scope|is_archived|access_denied/

/** `slack-cli --json …` always prints { success, data | error }. */
async function slackCli(args: string[]): Promise<Json | null> {
  const res = await runCli("slack-cli", ["--json", ...args])
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
  `https://${d.workspace}.slack.com/archives/${d.channel}/p${d.ts.replace(".", "")}`

async function fetchOne(req: MetaRequest): Promise<Fetched> {
  const d = req.data
  if (req.type === "slack-channel") {
    // Only the channel name is kept from the latest message's response.
    const data = await slackCli(["messages", "list", d.channel, "--limit", "1"])
    return data?.channel ? { meta: { title: `#${data.channel}`, subtitle: d.workspace }, cache: UNTIL_MENTIONED } : missing()
  }
  const m = await slackCli(["messages", "get", permalink(d)])
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

/** Thread and channel links. Public channels only (slack-cli's scopes); one CLI call per link, 3 at a time. */
export const slack: ResourceAdapter = {
  id: "slack",
  name: "Slack",
  description: "Root message, channel and author for thread links, names for channel links (public channels)",
  types: ["slack-thread", "slack-channel"],
  cli: { command: "slack-cli", install: "npm i -g @vercel/slack-cli", login: "slack-cli auth login" },
  batchSize: 15,

  async fetch(batch) {
    if (!account) {
      const status = await slackCli(["auth", "status"])
      if (status && !status.authenticated) throw new AdapterError("slack-cli isn't logged in", "logged-out")
      account = status?.user ? `${status.user} (${status.team})` : undefined
    }
    const items = new Map<string, Fetched>()
    await eachLimit(batch, 3, async (req) => void items.set(req.id, await fetchOne(req)))
    return { items, account }
  },
}
