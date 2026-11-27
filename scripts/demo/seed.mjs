// Seeds a throwaway opencode (its own HOME, XDG dirs and service port), or with --harness fx
// a throwaway ~/.fx in that HOME, and a ctrl state folder with demo spaces and sessions, for
// README screenshots and previews. Nothing touches your real opencode, fx or ctrl state.
// Usage: node scripts/demo/seed.mjs <demo dir> [--harness fx] [--port <opencode service port>] [--preview]
//   --preview  adds the sessions previews test with (PREVIEW_SESSIONS) to the screenshot ones
// Then scripts/demo/capture.mjs takes the screenshots (docs/DEVELOPMENT.md → Screenshots).
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { demoEnv, opencodeBin } from "./env.mjs"

const dir = process.argv[2]
if (!dir) throw new Error("usage: seed.mjs <demo dir> [--harness fx]")
const option = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const harness = option("--harness") ?? "opencode"
const port = option("--port") ?? "49411"
const preview = process.argv.includes("--preview")
rmSync(dir, { recursive: true, force: true })
const env = demoEnv(dir)
const home = env.HOME
const oc = (...args) => execFileSync(opencodeBin(), args, { env, encoding: "utf8" })
const api = (method, path, body) => {
  const out = oc("api", method, path, ...(body ? ["--data", JSON.stringify(body)] : []))
  if (!out.trim()) return null
  const json = JSON.parse(out)
  return json.data ?? json
}

const folders = { next: join(home, "code/next.js"), ai: join(home, "code/ai"), notes: join(home, "notes") }
for (const f of Object.values(folders)) mkdirSync(f, { recursive: true })
if (harness === "opencode") {
  // A separate port, so the demo service never collides with the real one.
  oc("service", "set", "port", port)
  mkdirSync(env.XDG_CONFIG_HOME + "/opencode", { recursive: true })
  writeFileSync(env.XDG_CONFIG_HOME + "/opencode/opencode.json", JSON.stringify({ model: "opencode/big-pickle" }))
}

// A model the demo opencode knows without any login (OpenCode Zen), so the TUI shows its name.
const MODEL = { id: "big-pickle", providerID: "opencode" }
const ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const now = Date.now()
const min = 60_000
let seq = 0
const msgID = (t) => `msg_${(t * 0x1000 + seq++).toString(16).padStart(12, "0")}demo${String(seq).padStart(10, "0")}`

/** Real-looking, stable ids: what the mention pasted by a drag shows. */
const fakeID = (prefix, seed) => {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  let h = 2166136261
  let out = ""
  for (let i = 0; out.length < 26; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i % seed.length) ^ i, 16777619) >>> 0
    out += chars[h % (out.length < 12 ? 16 : chars.length)]
  }
  return prefix + out
}

const shell = (command, output, t) => ({
  type: "tool",
  id: `toolu_demo${seq++}`,
  name: "shell",
  executed: false,
  state: { status: "completed", input: { command }, content: [{ type: "text", text: output }], metadata: { status: "completed", truncated: false, exit: 0 } },
  time: { created: t, ran: t + 200, completed: t + 900 },
})

/**
 * key, title, folder, ago (minutes since its last turn), status, space, archived, parent (key of the
 * session that started it with `ctrl session new`), and turns:
 * [user text, assistant text, optional shell tool [command, output]]
 */
const SESSIONS = [
  {
    key: "loopback",
    title: "Allow loopback IPs in dev origin check",
    folder: "next",
    ago: 1,
    status: "idle",
    space: "next",
    turns: [
      [
        "Requests from 127.0.0.1 get blocked by the dev origin check when next dev runs behind a local proxy. Can we allow loopback IPs by default?",
        "Found it. The check only trusts `localhost`, so `127.0.0.1` and `::1` count as cross-site. I added the loopback ranges next to it, with a test for each.\n\nOpened https://github.com/vercel/next.js/pull/99932 with the fix. The preview is at https://next-site-git-loopback-origins-acme.vercel.app",
        ['rg -n "allowedDevOrigins" packages/next/src | head -3', "packages/next/src/server/lib/router-utils/block-cross-site.ts:14:  allowedDevOrigins: string[]\npackages/next/src/server/config-shared.ts:212:  allowedDevOrigins?: string[]\n"],
      ],
      [
        "Nice. Post it in the Slack thread and link the Linear ticket",
        "Done. Posted in https://acme.slack.com/archives/C07DEVTOOLS/p1791551200123456 and linked https://linear.app/acme/issue/DX-142/allow-loopback-ips-in-dev-origin-check, both point at the PR.\n\nThe same file also shows up in https://github.com/vercel/next.js/issues/99919, but that one is about type-checking, so I left it alone.",
      ],
    ],
  },
  {
    key: "gtm",
    title: "Fix flaky GTM e2e test",
    folder: "next",
    ago: 6,
    status: "unread",
    space: "next",
    turns: [
      [
        "The google tag manager e2e test fails about once a day. Can you look?",
        "It asserts a 404 from googletagmanager.com, which now answers 200. I changed it to expect 200: https://github.com/vercel/next.js/pull/99896",
      ],
    ],
  },
  {
    key: "unused",
    title: "Type-check fails with noUnusedLocals",
    folder: "next",
    ago: 14,
    status: "failed",
    space: "next",
    turns: [
      [
        "Look into https://github.com/vercel/next.js/issues/99919, it says type-check fails since 16.4.0",
        "The generated `validator.ts` imports types it never uses for metadata-only apps. I started a fix but the type tests failed on the first run.",
      ],
    ],
  },
  {
    key: "frames",
    title: "Code frames keep old terminal width",
    folder: "next",
    ago: 70,
    status: "idle",
    space: "next",
    turns: [
      [
        "Why do code frames in next dev ignore terminal resizes? https://github.com/vercel/next.js/issues/99915",
        "The width is read once at startup and cached. Reading `process.stdout.columns` when each frame is printed fixes it.",
      ],
    ],
  },
  {
    key: "review33",
    title: "Review #99933 prerender coverage",
    folder: "next",
    ago: 9,
    status: "unread",
    space: "reviews",
    turns: [
      [
        "review https://github.com/vercel/next.js/pull/99933",
        "Looks good. The new test covers the fully prerendered catch-all case and fails without the fix. One nit on a test name, no blockers.",
      ],
    ],
  },
  {
    key: "review34",
    title: "Review #99934 skills branch prefix",
    folder: "next",
    ago: 180,
    status: "idle",
    space: "reviews",
    turns: [["review https://github.com/vercel/next.js/pull/99934", "Approved, it's a docs-only change."]],
  },
  {
    key: "heygen",
    title: "Revert HeyGen video provider",
    folder: "ai",
    ago: 120,
    status: "idle",
    space: "ai",
    turns: [
      [
        "Why was the HeyGen provider reverted?",
        "It broke the provider registry types in a minor release: https://github.com/vercel/ai/pull/22352",
      ],
    ],
  },
  {
    key: "release",
    title: "Release notes for Version Packages",
    folder: "ai",
    ago: 300,
    status: "idle",
    space: "ai",
    turns: [["Summarize https://github.com/vercel/ai/pull/22348 for the changelog", "Six packages bump, mostly provider fixes. Here's a short changelog entry."]],
  },
  {
    key: "roadmap",
    title: "Plan the Q4 roadmap doc",
    folder: "notes",
    ago: 25,
    status: "idle",
    turns: [
      [
        "Draft the outline for our Q4 roadmap",
        "Here's the outline. I put it in https://www.notion.so/acme/Q4-roadmap-3f2a9c1e8b7d4e6fa1c2b3d4e5f60718",
      ],
    ],
  },
  {
    key: "budget",
    title: "What's eating the deploy test budget?",
    folder: "next",
    ago: 1500,
    status: "idle",
    turns: [
      [
        "Our deploy tests got 30% slower this month. Where does the time go?",
        "Mostly module-scope tests waiting on cold starts. Details in https://linear.app/acme/issue/DX-131/deploy-tests-slow-cold-starts",
      ],
    ],
  },
  {
    key: "turbo",
    title: "Bump turbopack snapshot",
    folder: "next",
    ago: 4000,
    status: "idle",
    archived: true,
    turns: [["Bump the turbopack snapshot", "Done, snapshots updated."]],
  },
]

/** Previews only (--preview), so the README screenshots stay as they are. Add what you want to test with. */
const PREVIEW_SESSIONS = [
  {
    key: "monorepo",
    title: "Speed up next build on large monorepos",
    folder: "next",
    ago: 4,
    status: "idle",
    space: "next",
    turns: [
      [
        "next build takes 9 minutes on our 400-package monorepo. Split the investigation in two sub sessions.",
        "Started 2 child sessions: one profiles the webpack cache, the other opens a PR that builds the route manifest in parallel.",
      ],
    ],
  },
  {
    key: "monorepo-cache",
    title: "Profile webpack cache hits",
    folder: "next",
    ago: 3,
    status: "unread",
    space: "next",
    parent: "monorepo",
    turns: [["Profile webpack cache hits on the monorepo build", "62% of modules miss the cache: the hash includes absolute paths."]],
  },
  {
    key: "monorepo-pr",
    title: "PR: build the route manifest in parallel",
    folder: "next",
    ago: 2,
    status: "idle",
    space: "next",
    parent: "monorepo",
    turns: [["Open a PR that builds the route manifest in parallel", "Opened https://github.com/vercel/next.js/pull/99940, 9m to 6m on the monorepo."]],
  },
  {
    // A table wider than the chat column, to see it spill into the margins in chat view.
    key: "webhooks",
    title: "Compare webhook auto-disable rules",
    folder: "notes",
    ago: 1,
    status: "idle",
    turns: [
      [
        "How do other platforms alert and auto-disable failing webhooks? Put it in a table.",
        [
          "Here's how they compare:",
          "",
          "| Provider | How they alert | What triggers the alert | Auto-disable: when? |",
          "| --- | --- | --- | --- |",
          "| **Cloudflare Logpush** (closest to drains) | opt-in notification by email or webhook (at most 1 per job per 24h), plus a health dashboard | the job gets disabled | ✅ after **24h with no successful push**. Manual re-enable, logs from the gap are lost |",
          "| **Svix** | events to the platform (`failing`, `exhausted`, `disabled`, `recovered`), plus an optional email to the end customer when disabled | a message fails its 4th attempt (~35 min), retries run out (~1 day), endpoint disabled | ✅ after **5 days of every attempt failing**. Can be turned off. Bulk replay of failed messages |",
          "| **Stripe webhooks** | warning email that gives the disable date, then a second email when it's disabled | the endpoint keeps failing across retries (which cover up to 3 days) | ✅ after **several days of failing**. Re-enabling resumes new events only, no replay |",
          "| **GitHub webhooks** | none (failed deliveries only show in the delivery log) | n/a | ❌ **never**. Also no automatic retries, manual redelivery for 3 days |",
        ].join("\n"),
      ],
    ],
  },
]
if (preview) SESSIONS.push(...PREVIEW_SESSIONS)

/** Previews only: skills in each folder Settings → Skills reads, with one of each case it points out. */
const PREVIEW_SKILLS = [
  [".agents/skills/release-notes", "Write release notes from the merged PRs since the last tag."],
  [".claude/skills/pdf", "Read, fill and merge PDF files."],
  [".agents/skills/pdf", "Read and fill PDF forms (older copy)."],
  [".fx/skills/changelog", "Keep CHANGELOG.md in the Keep a Changelog format."],
  [".codex/skills/code-review", "Review a diff for bugs, missing tests and unclear names."],
  [".codex/skills/pdf", "Read, fill and merge PDF files."],
  [".cursor/skills/storybook", "Add a Storybook story for a React component."],
  [".claude/plugins/cache/acme/frontend/1.0.0/skills/accessibility", "Audit a page for accessibility issues (WCAG 2.2)."],
  [".claude/plugins/cache/acme/frontend/1.0.0/skills/web-vitals", "Find what slows down LCP, INP and CLS on a page."],
]
if (preview) {
  for (const [path, description] of PREVIEW_SKILLS) {
    mkdirSync(join(home, path), { recursive: true })
    const name = path.split("/").pop()
    writeFileSync(join(home, path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
  }
  writeFileSync(
    join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "frontend@acme": [{ scope: "user", installPath: join(home, ".claude/plugins/cache/acme/frontend/1.0.0") }] } }),
  )
}

const SPACES = [
  { id: "spc_demo_next", name: "next.js", directory: folders.next },
  { id: "spc_demo_reviews", name: "Reviews", directory: folders.next },
  { id: "spc_demo_ai", name: "AI SDK", directory: folders.ai },
]
const ui = { skillPrompted: true, resourcesOpen: true, recentsCollapsed: false, archivedCollapsed: true, sidebarWidth: 280, resourcesWidth: 320 }
// The demo links point at made-up Slack and Vercel teams: show them as links only.
// Previews print a phone link, so their phone view is on.
const settings = { adapterModes: { slack: "links", vercel: "links" }, ...(preview ? { remoteControl: true } : {}) }

/** Writes ctrl's state for the demo sessions, plus the ids capture.mjs drives them by. */
function writeState(ids, extra = {}) {
  const state = {
    spaces: SPACES,
    assignments: Object.fromEntries(SESSIONS.filter((s) => s.space).map((s) => [ids[s.key], `spc_demo_${s.space}`])),
    archived: Object.fromEntries(SESSIONS.filter((s) => s.archived).map((s) => [ids[s.key], now - s.ago * min])),
    parents: Object.fromEntries(SESSIONS.filter((s) => s.parent).map((s) => [ids[s.key], ids[s.parent]])),
    createdByAgent: Object.fromEntries(
      SESSIONS.filter((s) => s.parent).map((s) => [ids[s.key], { agent: harness, by: ids[s.parent], at: now - s.ago * min }]),
    ),
    ui,
    settings,
    ...extra,
  }
  mkdirSync(join(dir, "ctrl"), { recursive: true })
  writeFileSync(join(dir, "ctrl/state.json"), JSON.stringify(state, null, 2))
  writeFileSync(join(dir, "ids.json"), JSON.stringify(ids, null, 2))
  console.log(`[demo] seeded ${SESSIONS.length} ${harness} sessions in ${dir}`)
}

if (harness === "fx") {
  seedFx()
  process.exit(0)
}

/**
 * fx sessions are plain files: ~/.fx/sessions/<id>/session.json + events.jsonl (one event per line), all
 * 0600 since fx refuses files others can read. No tool calls: their output lives in separate files.
 */
function seedFx() {
  const ids = {}
  const viewed = {}
  const sessionsDir = join(home, ".fx/sessions")
  for (const s of SESSIONS) {
    const raw = fakeID("", s.key).slice(12, 24)
    ids[s.key] = `fx:${raw}`
    const end = now - s.ago * min
    const start = end - s.turns.length * 3 * min
    const folder = join(sessionsDir, raw)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const write = (file, text) => writeFileSync(join(folder, file), text, { mode: 0o600 })
    write(
      "session.json",
      JSON.stringify({
        schema_version: 4, id: raw, origin_workspace_root: folders[s.folder], workspace_root: folders[s.folder],
        created_at_ms: start, updated_at_ms: end, conversation_language: "und-Latn", provider: "gateway",
        model: "anthropic/claude-opus-5.5", effort: "auto", fast_mode: false, title: s.title, subagent_child: false,
      }),
    )
    const events = []
    const event = (t, body) => events.push(JSON.stringify({ schema_version: 3, seq: events.length + 1, timestamp_ms: t, event: body }))
    s.turns.forEach(([user, reply], n) => {
      // The last turn ends at `end`, so the sidebar's age and unread state follow the demo times.
      const t = n === s.turns.length - 1 ? end : start + n * 3 * min
      event(t, { user: { text: user, images: [], work_id: null } })
      event(t, { assistant: { text: reply, provider_replay: null, standalone_response: false } })
      const summary = { started_at_ms: t - 60_000, completed_at_ms: t, thinking_duration_ms: 4200, turn_duration_ms: 60_000, token_progress: { input_tokens: 1200, output_tokens: 300, input_exact: false, output_exact: true } }
      event(t, { turn_completed: { files: [], turn_summary: summary } })
    })
    write("events.jsonl", `${events.join("\n")}\n`)
    // ctrl reads "last updated" from the log's mtime too: put it back at the demo time.
    utimesSync(join(folder, "events.jsonl"), end / 1000, end / 1000)
    write("permissions.json", JSON.stringify({ schema_version: 2, next_generation: 1, rules: [] }))
    // fx has no read state: ctrl keeps it. Failed turns only show for open fx sessions, so those stay unread.
    if (s.status === "idle") viewed[ids[s.key]] = end
  }
  writeState(ids, { viewed, viewedSince: now - 10_000 * min, settings: { ...settings, defaultHarness: "fx" } })
}

// A real session in each folder gives a valid projectID for the imports, then goes away.
const projects = {}
for (const [name, directory] of Object.entries(folders)) {
  const s = api("post", "/api/session", { location: { directory } })
  projects[name] = s.projectID
  api("delete", `/api/session/${s.id}`)
}

const ids = {}
for (const [i, s] of SESSIONS.entries()) {
  const end = now - s.ago * min
  const start = end - s.turns.length * 3 * min
  const id = fakeID("ses_", s.key)
  ids[s.key] = id
  const messages = []
  s.turns.forEach(([user, reply, tool], n) => {
    const t = start + n * 3 * min
    messages.push({ id: msgID(t), time: { created: t }, text: user, files: [], agents: [], type: "user" })
    const content = []
    if (tool) content.push(shell(tool[0], tool[1], t + 20_000))
    content.push({ type: "text", text: reply })
    messages.push({
      id: msgID(t + 30_000),
      time: { created: t + 30_000, streamed: t + 60_000, completed: t + 90_000 },
      type: "assistant",
      agent: "build",
      model: MODEL,
      content,
      finish: "stop",
      cost: 0,
      tokens: ZERO,
    })
  })
  const outcome = s.status === "failed" ? "failed" : "succeeded"
  messages.push({ id: msgID(end), time: { created: end }, type: "idle", outcome })
  api("post", "/api/experimental/session/import", {
    info: {
      id,
      projectID: projects[s.folder],
      agent: "build",
      model: MODEL,
      cost: 0,
      tokens: ZERO,
      outcome,
      time: { created: start, updated: end, idle: end, ...(s.status === "idle" ? { viewed: end } : {}) },
      title: s.title,
      location: { directory: folders[s.folder] },
    },
    messages,
    // The import files the session under this location, not info.location.
    location: { directory: folders[s.folder] },
  })
}

// Import stamps `updated` with the current time; put back the demo times (throwaway database).
oc("service", "stop")
const db = join(env.XDG_DATA_HOME, "opencode/opencode.db")
const updates = SESSIONS.map((s) => `UPDATE session_v2 SET time_updated = ${now - s.ago * min} WHERE id = '${ids[s.key]}';`)
execFileSync("sqlite3", [db, updates.join("\n")])

writeState(ids)
