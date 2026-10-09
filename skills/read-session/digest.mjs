#!/usr/bin/env node
// Prints a compact Markdown digest of an opencode or fx session, for referencing
// it from another session. Usage:
//   node digest.mjs <sessionID>            digest (prompts, outcomes, activity)
//   node digest.mjs <sessionID> --turn N   one full turn (user prompt + all replies)
//
// opencode ("ses_…"): reads through `opencode api`, which reuses the TUI's service
// discovery + auth. Its stdout gets truncated when piped, so responses go through a
// temp file.
// fx ("fx:<id>"): reads ~/.fx/sessions/<id>/ directly (session.json, events.jsonl).
import { execFileSync } from "node:child_process"
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"

const [id, flag, flagValue] = process.argv.slice(2)
const fxMatch = /^fx:([A-Za-z0-9_-]+)$/.exec(id ?? "")
if (!fxMatch && !/^ses_[A-Za-z0-9]+$/.test(id ?? "")) {
  console.error("usage: digest.mjs <ses_… | fx:…> [--turn N]")
  process.exit(1)
}

const clip = (s, n) => {
  const t = (s ?? "").trim()
  return t.length > n ? `${t.slice(0, n)}… [+${t.length - n} chars]` : t
}
const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?")

// Both harnesses become: header lines + turns of { prompt, texts, tools: [{ name, input }], outcome? }
const { title, header, turns } = fxMatch ? readFx(fxMatch[1]) : readOpencode()

if (flag === "--turn") {
  const n = Number(flagValue)
  const t = turns[n - 1]
  if (!t) {
    console.error(`turn ${n} not found (session has ${turns.length})`)
    process.exit(1)
  }
  console.log(`# Turn ${n} of "${title ?? id}"\n\n## User\n\n${t.prompt}\n\n## Assistant\n`)
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
    const input = c.input ?? {}
    if (typeof input.command === "string") commands.push(input.command.split("\n")[0])
    for (const [k, v] of Object.entries(input)) {
      if (/path|file/i.test(k) && typeof v === "string" && v.length < 300) files.add(v)
    }
  }
}

const out = []
out.push(`# Session: ${title ?? "(untitled)"}`)
out.push("")
out.push(`- id: ${id}`)
out.push(...header)
out.push("")
out.push("## Conversation")
turns.forEach((t, i) => {
  // Recent turns matter most: keep them longer, compress older ones.
  const recent = i >= turns.length - 3
  out.push("")
  out.push(`### Turn ${i + 1}${t.outcome && t.outcome !== "completed" ? ` · ${t.outcome}` : ""}`)
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
out.push(`_Full detail for one turn: \`digest.sh ${id} --turn N\`_`)
console.log(out.join("\n"))

function readOpencode() {

  // PATH first, then where installers put it (the agent's shell may not have it on PATH).
  const opencode =
    [
      ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "opencode")),
      join(homedir(), ".opencode/bin/opencode"),
      "/opt/homebrew/bin/opencode",
      "/usr/local/bin/opencode",
    ].find((p) => existsSync(p)) ?? "opencode"

  const dir = mkdtempSync(join(tmpdir(), "read-session-"))
  function api(path) {
    const file = join(dir, "out.json")
    // A file fd as stdout, not a pipe, so the output isn't truncated.
    const fd = openSync(file, "w")
    try {
      execFileSync(opencode, ["api", "get", path], { stdio: ["ignore", fd, "inherit"] })
    } finally {
      closeSync(fd)
    }
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

  // Split into turns: each user message starts one.
  const turns = []
  for (const m of messages) {
    if (m.type === "user") turns.push({ prompt: m.text ?? "", texts: [], tools: [] })
    else if (m.type === "assistant" && turns.length) {
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text?.trim()) turns.at(-1).texts.push(c.text)
        if (c.type === "tool") turns.at(-1).tools.push({ name: c.name, input: c.state?.input })
      }
    }
  }
  return {
    title: info.title,
    header: [
      `- harness: opencode`,
      `- directory: ${info.location?.directory ?? "?"}`,
      `- created ${when(info.time?.created)} · updated ${when(info.time?.updated)}${info.outcome ? ` · last run ${info.outcome}` : ""}`,
      `- ${turns.length} turn(s), ${messages.length} messages`,
    ],
    turns,
  }
}

function readFx(rawID) {
  const dir = join(process.env.FX_HOME || join(homedir(), ".fx"), "sessions", rawID)
  let info, lines
  try {
    info = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"))
    lines = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean)
  } catch (err) {
    console.error(`can't read fx session ${rawID} in ${dir}: ${err.message}`)
    process.exit(1)
  }
  // Each user prompt starts a turn; steering joins the current one.
  const turns = []
  let last = 0
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    last = Math.max(last, e.timestamp_ms ?? 0)
    const [kind, p] = Object.entries(e.event ?? {})[0] ?? []
    if (kind === "user") turns.push({ prompt: p.text ?? "", texts: [], tools: [], outcome: "running" })
    const t = turns.at(-1)
    if (!t) continue
    if (kind === "steering" && p.text) t.prompt += `\n\n[steering] ${p.text}`
    if (kind === "assistant" && p.text?.trim()) t.texts.push(p.text)
    if (kind === "tool_call") {
      let input = {}
      try {
        input = JSON.parse(p.arguments_json ?? "{}")
      } catch {}
      t.tools.push({ name: p.tool_name, input })
    }
    if (kind === "turn_completed") t.outcome = "completed"
    if (kind === "interrupted") t.outcome = `interrupted (${p.reason ?? "?"})`
  }
  return {
    title: info.title,
    header: [
      `- harness: fx`,
      `- directory: ${info.workspace_root ?? "?"}`,
      `- model: ${info.model ?? "?"} (${info.provider ?? "?"})`,
      `- created ${when(info.created_at_ms)} · last activity ${when(last || info.updated_at_ms)}`,
      `- ${turns.length} turn(s), ${lines.length} events`,
    ],
    turns,
  }
}
