// Opens a demo ctrl whose sessions have real background work, to check how it looks: shells started
// through the opencode API (tagged with a session, like the agent's own), and subagents that keep running
// because their model never finishes answering (a local fake provider that streams nothing, forever).
// Usage: node scripts/demo/activity.mjs [demo dir]   (Ctrl+C stops ctrl, the shells and the fake model)
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { demoEnv, opencodeBin } from "./env.mjs"

const DEMO = resolve(process.argv[2] ?? join(tmpdir(), "ctrl-demo-activity"))
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

// OpenAI-compatible model that accepts the request, then streams keep-alives and never finishes.
const streams = new Set()
const fake = createServer((req, res) => {
  req.resume()
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const chunk = { id: "hang", object: "chat.completion.chunk", created: 0, model: "hang", choices: [{ index: 0, delta: { role: "assistant" } }] }
  const beat = setInterval(() => res.write(`data: ${JSON.stringify(chunk)}\n\n`), 2000)
  streams.add(res)
  res.on("close", () => (clearInterval(beat), streams.delete(res)))
})
await new Promise((r) => fake.listen(0, "127.0.0.1", r))
const port = fake.address().port

const configPath = join(env.XDG_CONFIG_HOME, "opencode/opencode.json")
const config = JSON.parse(readFileSync(configPath, "utf8"))
config.providers = {
  hang: {
    name: "Never finishes",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "demo" },
    models: { slow: { name: "Slow subagent" } },
  },
}
writeFileSync(configPath, JSON.stringify(config))

const sessions = api("get", "/api/session?limit=50")
const dirOf = (key) => sessions.find((s) => s.id === ids[key]).location.directory

/** A shell tagged with the session, like the ones the agent starts in the background. */
const shell = (key, command) =>
  api("post", `/api/shell?location[directory]=${encodeURIComponent(dirOf(key))}`, { command, metadata: { sessionID: ids[key] } })

/** A subagent of `key` whose turn never ends. */
const subagent = (key, title) => {
  const location = { directory: dirOf(key) }
  const child = api("post", "/api/session", { location, parentID: ids[key], title, model: { providerID: "hang", id: "slow" } })
  api("post", `/api/session/${child.id}/prompt`, { text: "Look into it" })
  return child.id
}

// The states to look at, one per session:
shell("loopback", "sleep 7200 # next dev") //       on screen: shell in the TUI footer + sidebar
subagent("loopback", "Check other origin checks")
shell("frames", "sleep 7200 # pnpm test --watch") // idle + 1 shell        → shell icon
shell("frames", "sleep 7200 # tail -f dev.log") //   idle + 2 shells       → shell icon
subagent("heygen", "Find the breaking change") //    idle + 1 subagent     → subagent icon
subagent("release", "Draft entry") //                idle + subagent + shell → both icons
shell("release", "sleep 7200 # pnpm changeset")
shell("gtm", "sleep 7200 # e2e loop") //             idle + shell          → shell icon
shell("review33", "sleep 7200 # pnpm test") //       unread + shell        → the unread dot wins
console.log("[demo] shells and subagents started")

// Skip the welcome screen.
const statePath = join(DEMO, "ctrl/state.json")
const state = JSON.parse(readFileSync(statePath, "utf8"))
state.ui.onboarded = true
writeFileSync(statePath, JSON.stringify(state, null, 2))

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
// Open the session with a shell and a subagent, so the TUI's prompt footer shows both.
setTimeout(() => {
  const cli = ["dist/cli/cli.cjs", "session", "focus", ids.loopback]
  spawn("node", cli, { env: { ...process.env, CTRL_SOCKET: join(DEMO, "ctrl/ctrl.sock") }, stdio: "ignore" })
}, 12000)
const quit = () => {
  app.kill()
  for (const res of streams) res.destroy()
  fake.close()
  stopService()
  process.exit(0)
}
app.on("exit", quit)
process.on("SIGINT", quit)
process.on("SIGTERM", quit)
