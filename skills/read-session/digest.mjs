#!/usr/bin/env node
// Prints a compact Markdown digest of an opencode session, for referencing it
// from another session. Usage:
//   node digest.mjs <sessionID>            digest (prompts, outcomes, activity)
//   node digest.mjs <sessionID> --turn N   one full turn (user prompt + all replies)
//
// Reads through `opencode api`, which reuses the TUI's service discovery + auth.
// Its stdout gets truncated when piped, so responses go through a temp file.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [id, flag, flagValue] = process.argv.slice(2)
if (!id?.startsWith("ses_")) {
  console.error("usage: digest.mjs <ses_…> [--turn N]")
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), "read-session-"))
function api(path) {
  const file = join(dir, "out.json")
  execFileSync("/bin/sh", ["-c", `opencode api get '${path}' > '${file}'`], { stdio: ["ignore", "ignore", "inherit"] })
  const body = JSON.parse(readFileSync(file, "utf8"))
  return body.data ?? body
}

let info, messages
try {
  info = api(`/api/session/${id}`)
  messages = api(`/api/session/${id}/context`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const clip = (s, n) => {
  const t = (s ?? "").trim()
  return t.length > n ? `${t.slice(0, n)}… [+${t.length - n} chars]` : t
}
const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?")

// Split into turns: each user message starts one.
const turns = []
for (const m of messages) {
  if (m.type === "user") turns.push({ prompt: m.text ?? "", texts: [], tools: [] })
  else if (m.type === "assistant" && turns.length) {
    for (const c of m.content ?? []) {
      if (c.type === "text" && c.text?.trim()) turns.at(-1).texts.push(c.text)
      if (c.type === "tool") turns.at(-1).tools.push(c)
    }
  }
}

if (flag === "--turn") {
  const n = Number(flagValue)
  const t = turns[n - 1]
  if (!t) {
    console.error(`turn ${n} not found (session has ${turns.length})`)
    process.exit(1)
  }
  console.log(`# Turn ${n} of "${info.title ?? id}"\n\n## User\n\n${t.prompt}\n\n## Assistant\n`)
  for (const text of t.texts) console.log(`${text}\n`)
  process.exit(0)
}

// Activity across the whole session.
const toolCounts = {}
const commands = []
const files = new Set()
for (const t of turns) {
  for (const c of t.tools) {
    toolCounts[c.name] = (toolCounts[c.name] ?? 0) + 1
    const input = c.state?.input ?? {}
    if (typeof input.command === "string") commands.push(input.command.split("\n")[0])
    for (const [k, v] of Object.entries(input)) {
      if (/path|file/i.test(k) && typeof v === "string" && v.length < 300) files.add(v)
    }
  }
}

const out = []
out.push(`# Session: ${info.title ?? "(untitled)"}`)
out.push("")
out.push(`- id: ${id}`)
out.push(`- directory: ${info.location?.directory ?? "?"}`)
out.push(`- created ${when(info.time?.created)} · updated ${when(info.time?.updated)}${info.outcome ? ` · last run ${info.outcome}` : ""}`)
out.push(`- ${turns.length} turn(s), ${messages.length} messages`)
out.push("")
out.push("## Conversation")
turns.forEach((t, i) => {
  // Recent turns matter most: keep them longer, compress older ones.
  const recent = i >= turns.length - 3
  out.push("")
  out.push(`### Turn ${i + 1}`)
  out.push(`**User:** ${clip(t.prompt, recent ? 1500 : 300)}`)
  const answer = t.texts.at(-1)
  out.push(answer ? `**Assistant (final reply):** ${clip(answer, recent ? 2500 : 400)}` : "**Assistant:** (no text reply)")
})
out.push("")
out.push("## Activity")
out.push(`- tools: ${Object.entries(toolCounts).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`)
if (files.size) out.push(`- files touched: ${[...files].slice(0, 30).join(", ")}${files.size > 30 ? ` (+${files.size - 30} more)` : ""}`)
if (commands.length) {
  out.push("- last commands:")
  for (const c of commands.slice(-12)) out.push(`  - \`${clip(c, 140)}\``)
}
out.push("")
out.push(`_Full detail for one turn: \`node digest.mjs ${id} --turn N\`_`)
console.log(out.join("\n"))
