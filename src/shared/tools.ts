import type { CliToolConfig, McpServerItem, ToolFix, ToolItem, ToolState } from "./types"

/** Fix button label when the config doesn't set one. */
export const fixLabel = (fix: ToolFix, label?: string) =>
  label || (fix.kind === "command" ? "Run" : fix.kind === "url" ? "Open" : "Fix")

const MCP_STATES: Record<McpServerItem["status"], ToolState> = {
  connected: "ok",
  pending: "pending",
  disabled: "disabled",
  failed: "broken",
  needs_auth: "needs-auth",
}

/** An MCP server as a watched tool: its fix is always a session (sign-in happens in the TUI's /mcps). */
export const mcpTool = (server: McpServerItem): ToolItem => ({
  id: `mcp:${server.name}`,
  kind: "mcp",
  name: server.name,
  state: MCP_STATES[server.status],
  ...(server.error ? { detail: server.error } : {}),
  fix: "session",
  label: "Fix",
})

/** Starting points for Settings → Tools → Add. Edit the profile, account or command after adding. */
export const CLI_TOOL_PRESETS: (Omit<CliToolConfig, "id"> & { description: string })[] = [
  {
    name: "AWS SSO",
    description: "aws sts get-caller-identity, logs in with aws sso login (opens your browser)",
    check: "aws sts get-caller-identity --profile default",
    fix: { kind: "command", command: "aws sso login --profile default" },
    label: "Log in",
  },
  {
    name: "GitHub CLI",
    description: "gh auth status",
    check: "gh auth status",
    fix: { kind: "session" },
  },
  {
    name: "Vercel CLI",
    description: "vercel whoami",
    check: "vercel whoami",
    fix: { kind: "session" },
  },
  {
    name: "Datadog (pup)",
    description: "pup auth status, logs in with pup auth login (opens your browser)",
    check: "pup --no-agent auth status",
    fix: { kind: "command", command: "pup auth login" },
    label: "Log in",
  },
]

/** A short unique id from the name: "AWS SSO" → "aws-sso", then "aws-sso-2". */
export const cliToolID = (name: string, taken: string[]) => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "cli"
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}
