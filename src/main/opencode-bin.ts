import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import type { OpencodeCheck } from "../shared/types"

/**
 * Oldest opencode ctrl is tested with. ctrl relies on V2-only APIs (forms, session.view,
 * instruction entries, the TUI plugin API), so V1 can't work at all.
 */
export const MIN_OPENCODE = "2.0.25"

/** Where installers put opencode, for when PATH doesn't have it (bare launchd env, broken shell rc). */
const KNOWN_LOCATIONS = [
  join(homedir(), ".opencode/bin/opencode"),
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
]

/** CTRL_OPENCODE overrides the lookup (odd installs, and tests: point it at a fake or missing binary). */
export function findOpencode(): string | undefined {
  const override = process.env.CTRL_OPENCODE
  if (override) return existsSync(override) ? override : undefined
  const fromPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "opencode"))
  return [...fromPath, ...KNOWN_LOCATIONS].find((p) => existsSync(p))
}

const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0)

/** Compares x.y.z versions (prerelease suffixes ignored): <0 if a is older than b. */
export function compareVersions(a: string, b: string) {
  const [x, y] = [parse(a.replace(/^v/, "").split("-")[0]), parse(b.replace(/^v/, "").split("-")[0])]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

export async function checkOpencode(): Promise<OpencodeCheck> {
  const bin = findOpencode()
  if (!bin) return { state: "missing" }
  const out = await new Promise<string | Error>((resolve) =>
    execFile(bin, ["--version"], { timeout: 10_000 }, (err, stdout) => resolve(err ?? stdout)),
  )
  if (out instanceof Error) return { state: "missing", detail: `${bin} --version failed: ${out.message}` }
  const version = out.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? (out.trim() || "unknown")
  if (compareVersions(version, MIN_OPENCODE) < 0) return { state: "outdated", version, min: MIN_OPENCODE, bin }
  return { state: "ok", version, bin }
}
