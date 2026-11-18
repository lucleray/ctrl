import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import type { CliToolConfig, Harness, McpServerConfig } from "../../shared/types"
import { shq } from "./cli"

export type Detection = {
  mcp: { config: McpServerConfig; from: Harness[] }[]
  cli: (CliToolConfig & { key: string })[]
}

export type DetectSources = {
  /** opencode's MCP servers for ~ (src/main/opencode.ts mcpConfigs) */
  opencode?: () => Promise<McpServerConfig[]>
  /** fx's profile folder (~/.fx), when fx is installed */
  fxHome?: string
  home?: string
  /** PATH to look for CLIs in */
  path?: string
}

/**
 * fx keeps profile servers in ~/.fx/mcp.json, in the usual mcpServers shape (what `fx mcp add` writes) or in
 * opencode's `mcp` shape (what `kit setup` writes): fx reads both.
 */
export const fxMcpConfigs = (fxHome: string): McpServerConfig[] => {
  let raw: { mcpServers?: Record<string, Record<string, unknown>>; mcp?: Record<string, Record<string, unknown>> }
  try {
    raw = JSON.parse(readFileSync(join(fxHome, "mcp.json"), "utf8"))
  } catch {
    return []
  }
  const out: McpServerConfig[] = []
  const strings = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, string>) : undefined)
  for (const [name, s] of Object.entries(raw.mcp ?? {})) {
    if (!s || typeof s !== "object" || s.enabled === false) continue
    if (s.type === "remote" && typeof s.url === "string") {
      const headers = strings(s.headers)
      out.push({ name, type: "remote", url: s.url, ...(headers ? { headers } : {}) })
    } else if (Array.isArray(s.command) && s.command.length && s.command.every((c) => typeof c === "string")) {
      const env = strings(s.environment)
      out.push({ name, type: "local", command: s.command, ...(env ? { env } : {}) })
    }
  }
  for (const [name, s] of Object.entries(raw.mcpServers ?? {})) {
    if (!s || typeof s !== "object" || out.some((o) => o.name === name)) continue
    if (typeof s.url === "string") {
      const headers = strings(s.headers)
      out.push({ name, type: "remote", url: s.url, ...(headers ? { headers } : {}) })
    } else if (typeof s.command === "string") {
      const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : []
      const env = strings(s.env)
      out.push({ name, type: "local", command: [s.command, ...args], ...(env ? { env } : {}) })
    }
  }
  return out
}

/** Sections of an INI file (~/.aws/config): "profile x" → { sso_session: "y", … } */
const ini = (text: string) => {
  const sections = new Map<string, Record<string, string>>()
  let current: Record<string, string> | undefined
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#") || t.startsWith(";")) continue
    const head = /^\[(.+)\]$/.exec(t)
    if (head) {
      current = {}
      sections.set(head[1].trim(), current)
      continue
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(t)
    if (kv && current) current[kv[1]] = kv[2]
  }
  return sections
}

/**
 * One check per AWS SSO session, not per profile: one `aws sso login --sso-session x` covers every
 * profile of that session. The check uses the profile named like the session, else its first one.
 */
export const awsChecks = (configText: string): (CliToolConfig & { key: string })[] => {
  const sections = ini(configText)
  const profiles = [...sections].flatMap(([name, v]): (Record<string, string> & { name: string })[] => {
    const m = /^profile\s+(.+)$/.exec(name) ?? (name === "default" ? [name, name] : null)
    return m ? [{ ...v, name: m[1] }] : []
  })
  const out: (CliToolConfig & { key: string })[] = []
  for (const [name] of sections) {
    const m = /^sso-session\s+(.+)$/.exec(name)
    if (!m) continue
    const session = m[1]
    const users = profiles.filter((p) => p.sso_session === session)
    const profile = users.find((p) => p.name === session) ?? users[0]
    if (!profile) continue
    out.push({
      id: `aws-${session}`,
      key: `aws:sso:${session}`,
      name: `AWS (${session})`,
      check: `aws sts get-caller-identity --profile ${shq(profile.name)}`,
      fix: { kind: "command", command: `aws sso login --sso-session ${shq(session)}` },
      label: "Log in",
    })
  }
  // Older profiles that carry their own SSO settings, without a session.
  for (const p of profiles) {
    if (p.sso_session || !p.sso_start_url) continue
    out.push({
      id: `aws-${p.name}`,
      key: `aws:profile:${p.name}`,
      name: `AWS (${p.name})`,
      check: `aws sts get-caller-identity --profile ${shq(p.name)}`,
      fix: { kind: "command", command: `aws sso login --profile ${shq(p.name)}` },
      label: "Log in",
    })
  }
  return out
}

/** CLIs ctrl knows how to check, when they're on PATH. */
const SIMPLE: (CliToolConfig & { key: string; bin: string })[] = [
  { bin: "gh", id: "gh", key: "gh", name: "GitHub CLI", check: "gh auth status", fix: { kind: "session" } },
  { bin: "vercel", id: "vercel", key: "vercel", name: "Vercel CLI", check: "vercel whoami", fix: { kind: "session" } },
  {
    bin: "pup",
    id: "pup",
    key: "pup",
    name: "Datadog (pup)",
    check: "pup --no-agent auth status",
    fix: { kind: "command", command: "pup auth login" },
    label: "Log in",
  },
  {
    bin: "gcloud",
    id: "gcloud",
    key: "gcloud",
    name: "Google Cloud",
    check: "gcloud auth print-access-token --quiet",
    fix: { kind: "command", command: "gcloud auth login" },
    label: "Log in",
  },
]

/**
 * Finds what's worth watching on this Mac. Stateless: it doesn't know what you watch or unchecked
 * before, so the same machine always gives the same answer. Reads files and one opencode call, runs
 * no CLI.
 */
export async function detect(src: DetectSources): Promise<Detection> {
  const home = src.home ?? homedir()
  const dirs = (src.path ?? process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const onPath = (bin: string) => dirs.some((d) => existsSync(join(d, bin)))

  const mcp = new Map<string, { config: McpServerConfig; from: Harness[] }>()
  const add = (config: McpServerConfig, from: Harness) => {
    const seen = mcp.get(config.name)
    if (seen) seen.from.push(from)
    else mcp.set(config.name, { config, from: [from] })
  }
  const opencode = await src.opencode?.().catch((err) => (console.error("[ctrl] opencode mcp config", err), []))
  for (const config of opencode ?? []) add(config, "opencode")
  if (src.fxHome) for (const config of fxMcpConfigs(src.fxHome)) add(config, "fx")

  const cli: (CliToolConfig & { key: string })[] = []
  if (onPath("aws")) {
    const file = process.env.AWS_CONFIG_FILE || join(home, ".aws", "config")
    try {
      cli.push(...awsChecks(readFileSync(file, "utf8")))
    } catch {}
  }
  for (const { bin, ...check } of SIMPLE) if (onPath(bin)) cli.push(check)

  return { mcp: [...mcp.values()], cli }
}
