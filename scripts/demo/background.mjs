// Opens a demo ctrl in chat view on a session whose turn waits for a shell, to try moving it to the
// background: send a message (it waits above the composer), then "Run in background" (or ⌃B).
// The agent is a local fake model: a message starting with "run" makes it start a one hour shell and wait
// for it ("run sleep 30": a shell that ends on its own), anything else gets a short answer. No real model,
// no real sessions.
// Usage: node scripts/demo/background.mjs [demo dir] [first message]   (Ctrl+C stops ctrl, the shells and the fake model)
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { demoEnv, opencodeBin } from "./env.mjs"

const DEMO = resolve(process.argv[2] ?? join(tmpdir(), "ctrl-demo-background"))
const FIRST = process.argv[3] ?? "run pnpm test --watch"
const env = demoEnv(DEMO)
const oc = (...args) => execFileSync(opencodeBin(), args, { env, encoding: "utf8" })
const api = (method, path, body) => {
  const out = oc("api", method, path, ...(body ? ["--data", JSON.stringify(body)] : []))
  return out.trim() ? (JSON.parse(out).data ?? JSON.parse(out)) : null
}
const stopService = () => {
  try {
    execFileSync(opencodeBin(), ["service", "stop"], { env, stdio: "ignore" })
  } catch {}
}

stopService()
execFileSync("node", ["scripts/demo/seed.mjs", DEMO], { stdio: "inherit" })
const ids = JSON.parse(readFileSync(join(DEMO, "ids.json"), "utf8"))

const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("\n")

/** What the fake agent does next: start a shell and wait for it, or answer. */
function decide(body) {
  const shell = (body.tools ?? []).find((t) => t.function?.name === "shell")
  const last = body.messages.at(-1)
  const said = last?.role === "user" ? textOf(last.content).trim() : ""
  // Not opencode's own notes to the agent (moved to the background, a shell ended), which quote the command.
  const asked = /^run\b/i.test(said)
  if (shell && asked) {
    const what = said.replace(/^run\s+/i, "").replace(/[.!]$/, "") || "it"
    const args = { command: /^sleep \d+$/.test(what) ? what : `sleep 3600 # ${what}` }
    if (shell.function.parameters?.properties?.description) args.description = `Run ${what}`
    return { tool: { name: "shell", args } }
  }
  if (last?.role === "tool") return { text: "Done. What's next?" }
  if (/^<shell\b/.test(said)) return { text: "The shell that was running in the background has ended." }
  if (/^User requested/.test(said)) return { text: "Moved it to the background: it keeps running while we go on." }
  // Context opencode and ctrl add on their own: nothing to say.
  if (said.startsWith("<")) return { text: "" }
  return { text: `Got it: "${said.slice(0, 80)}". (Demo agent: start a message with "run" and I'll wait for a shell.)` }
}

// OpenAI-compatible model: streams one tool call or one short text.
const fake = createServer((req, res) => {
  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    let body = { messages: [] }
    try {
      body = JSON.parse(raw)
    } catch {}
    const next = decide(body)
    const chunk = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", created: 0, model: "agent", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      )
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    if (next.tool) {
      const call = { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }
      chunk({ role: "assistant", tool_calls: [call] })
      chunk({}, "tool_calls")
    } else {
      chunk({ role: "assistant", content: next.text })
      chunk({}, "stop")
    }
    res.end("data: [DONE]\n\n")
  })
})
await new Promise((r) => fake.listen(0, "127.0.0.1", r))
const port = fake.address().port

const configPath = join(env.XDG_CONFIG_HOME, "opencode/opencode.json")
const config = JSON.parse(readFileSync(configPath, "utf8"))
config.providers = {
  demo: {
    name: "Demo",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "demo" },
    models: { agent: { name: "Demo agent" } },
  },
}
config.model = "demo/agent"
config.permissions = [{ action: "shell", resource: "*", effect: "allow" }]
writeFileSync(configPath, JSON.stringify(config))

// A session whose turn waits for a shell.
const sessions = api("get", "/api/session?limit=50")
const directory = sessions.find((s) => s.id === ids.loopback).location.directory
const session = api("post", "/api/session", { location: { directory }, title: "Run the test suite", model: { providerID: "demo", id: "agent" } })
api("post", `/api/session/${session.id}/prompt`, { text: FIRST })
console.log(`[demo] ${session.id} waits for a shell`)

// Chat view, in a space, no welcome screen.
const statePath = join(DEMO, "ctrl/state.json")
const state = JSON.parse(readFileSync(statePath, "utf8"))
state.ui.onboarded = true
state.ui.resourcesOpen = false
state.settings.sessionView = "chat"
state.assignments[session.id] = state.assignments[ids.loopback]
writeFileSync(statePath, JSON.stringify(state, null, 2))
writeFileSync(join(DEMO, "background.json"), JSON.stringify({ sessionID: session.id }))

const branded = "node_modules/electron/dist/ctrl.app/Contents/MacOS/Electron"
const electron = existsSync(branded) ? branded : createRequire(import.meta.url)("electron")
execFileSync("npm", ["run", "build"], { stdio: "ignore" })
const app = spawn(electron, ["."], {
  env: {
    ...env,
    CTRL_OPENCODE: opencodeBin(),
    CTRL_FX: join(DEMO, "no-fx"),
    CTRL_USER_DATA: join(DEMO, "ctrl"),
    CTRL_SKILLS_DIR: join(DEMO, "skills"),
  },
  stdio: "inherit",
})
setTimeout(() => {
  const cli = ["dist/cli/cli.cjs", "session", "focus", session.id]
  spawn("node", cli, { env: { ...process.env, CTRL_SOCKET: join(DEMO, "ctrl/ctrl.sock") }, stdio: "ignore" })
}, 12000)
const quit = () => {
  app.kill()
  fake.close()
  stopService()
  process.exit(0)
}
app.on("exit", quit)
process.on("SIGINT", quit)
process.on("SIGTERM", quit)
