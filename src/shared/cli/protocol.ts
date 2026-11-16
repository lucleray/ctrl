/**
 * Wire format between the `ctrl` CLI and the app (docs/CLI.md). One JSON request per connection,
 * newline-terminated; one JSON reply, or NDJSON lines for streaming commands (`events`).
 */

export const PROTOCOL_VERSION = 1

/** Who is calling, read from the caller's environment, so the app can resolve `self`. */
export type CallerContext = {
  /** Set when an agent runs the CLI: its name, e.g. "opencode", "fx", "claude-code" (AI_AGENT and friends) */
  agent?: string
  /** CTRL_TERM_ID: set in the fx ptys ctrl runs; the app maps it to the session that pty has now */
  termID?: string
  /** OPENCODE_SESSION_ID: set by opencode in its tool shells */
  opencodeSessionID?: string
  /** CTRL_SESSION_ID: explicit override */
  sessionID?: string
  cwd?: string
}

export type CliRequest = {
  v: number
  /** Canonical command name, e.g. "session list" (aliases already resolved) */
  command: string
  args: Record<string, unknown>
  caller: CallerContext
}

export type ErrorCode =
  | "INTERNAL"
  | "USAGE"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "CONFLICT"
  | "APP_NOT_RUNNING"
  | "HARNESS_MISSING"
  | "UNSUPPORTED_HARNESS"
  | "NO_SELF"
  | "TIMEOUT"

export const EXIT_CODES: Record<ErrorCode, number> = {
  INTERNAL: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AMBIGUOUS: 4,
  CONFLICT: 4,
  APP_NOT_RUNNING: 5,
  HARNESS_MISSING: 5,
  UNSUPPORTED_HARNESS: 6,
  NO_SELF: 6,
  TIMEOUT: 7,
}

export const ERROR_DESCRIPTIONS: Record<ErrorCode, string> = {
  INTERNAL: "A bug or an unexpected failure inside ctrl",
  USAGE: "Unknown command or flag, or a bad value (`message` says which, `hint` shows the usage)",
  NOT_FOUND: "No session, space, setting, MCP server or tool with that id or name",
  AMBIGUOUS: "A selector matched more than one thing (see `candidates`)",
  CONFLICT: "Can't be done in the current state, e.g. an fx session open in another terminal",
  APP_NOT_RUNNING: "No ctrl app answering on the socket (`hint`: ctrl app launch)",
  HARNESS_MISSING: "Needs opencode or fx and it isn't installed (`hint`: the install command)",
  UNSUPPORTED_HARNESS: "That harness can't do this (docs/HARNESSES.md)",
  NO_SELF: "`self` used outside a session ctrl runs",
  TIMEOUT: "--timeout passed before the app answered, or `session wait` ran out",
}

export type CliErrorBody = {
  code: ErrorCode
  message: string
  hint?: string
  candidates?: unknown[]
}

export type CliReply = { ok: true; data: unknown } | { ok: false; error: CliErrorBody }

export class CliError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public extra: { hint?: string; candidates?: unknown[] } = {},
  ) {
    super(message)
  }

  body(): CliErrorBody {
    return { code: this.code, message: this.message, ...this.extra }
  }
}

/** Socket file inside ctrl's state folder (`~/Library/Application Support/ctrl`). */
export const SOCKET_NAME = "ctrl.sock"
