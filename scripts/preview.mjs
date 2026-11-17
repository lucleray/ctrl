// Runs this checkout as its own ctrl, next to the installed app and to other previews, in a sandbox: seeded
// spaces and sessions (scripts/demo/seed.mjs --preview), its own HOME and its own opencode service. Your real
// ctrl state, opencode sessions and fx sessions are never read or written.
//   npm run preview                   labelled with the current branch, keeps its sandbox from last time
//   npm run preview -- --reset        reseed the sandbox from scratch
//   npm run preview -- --auth         copy your opencode login into the sandbox, for real models (default: a free one)
//   npm run preview -- --name <name>  label (and sandbox folder) other than the branch name
// Same live reload as `npm run dev`. Each label gets its own sandbox, socket, phone port and opencode port.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { demoEnv, fxBin, opencodeBin } from "./demo/env.mjs"

const argv = process.argv.slice(2)
const option = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const reset = argv.includes("--reset")
const auth = argv.includes("--auth")

// Fresh checkouts and worktrees can have node_modules without Electron's binary (its postinstall didn't run).
if (!existsSync("node_modules/electron/path.txt")) {
  execFileSync("node", ["node_modules/electron/install.js"], { stdio: "inherit" })
  execFileSync("node", ["scripts/brand-electron.mjs"], { stdio: "inherit" })
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()
const branch = git("rev-parse", "--abbrev-ref", "HEAD")
const label = option("--name") ?? (branch === "HEAD" ? git("rev-parse", "--short", "HEAD") : branch)
const slug = label.replace(/[^\w.-]+/g, "-")

const appData = join(homedir(), "Library", "Application Support")
const dir = join(appData, "ctrl-preview", slug)
mkdirSync(dir, { recursive: true })

// Each preview keeps its phone port, so a bookmarked link keeps working and parallel previews never share one.
// A bind test alone can't tell: ctrl listens on the Tailscale address when there is one, not on localhost.
const portOf = (folder) => {
  try {
    return JSON.parse(readFileSync(join(folder, "preview.json"), "utf8")).port
  } catch {
    return undefined
  }
}
const bindable = (port) =>
  new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen(port, () => server.close(() => resolve(true)))
  })
const taken = new Set(
  readdirSync(join(appData, "ctrl-preview"))
    .filter((name) => name !== slug)
    .map((name) => portOf(join(appData, "ctrl-preview", name))),
)
let port = portOf(dir)
if (!port || taken.has(port)) port = undefined
for (let p = 7340; !port && p < 7400; p++) if (!taken.has(p) && (await bindable(p))) port = p
if (!port) throw new Error("No free port in 7340-7399 for the phone view: delete old folders in ctrl-preview")
writeFileSync(join(dir, "preview.json"), `${JSON.stringify({ port }, null, 2)}\n`)

// The sandbox: a private HOME (opencode, fx and worktrees live there) and ctrl's state folder, seeded once.
// Its opencode service gets a port of its own, paired with the phone port (the demo screenshots use 49411).
const sandbox = join(dir, "sandbox")
const opencodePort = String(49440 + (port - 7340))
const env = demoEnv(sandbox)
const stopService = () => {
  try {
    execFileSync(opencodeBin(), ["service", "stop"], { env, stdio: "ignore" })
  } catch {}
}
const seeded = existsSync(join(sandbox, "ids.json")) && !reset
if (!seeded) {
  // A service left running from the last sandbox would hold the database seeding wipes.
  stopService()
  execFileSync("node", ["scripts/demo/seed.mjs", sandbox, "--port", opencodePort, "--preview"], { stdio: "inherit" })
}
// ctrl watches fx's sessions folder, which fx only creates with its first session.
mkdirSync(join(env.HOME, ".fx/sessions"), { recursive: true, mode: 0o700 })
// Stopping the preview stops its opencode service too (dev.mjs exits on Ctrl+C, a kill, or quitting the app).
process.on("exit", stopService)

if (auth) {
  // Your logins, so agents in the sandbox can use real models. Stays until --reset.
  const real = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode/auth.json")
  if (!existsSync(real)) throw new Error(`--auth: no opencode login at ${real}`)
  mkdirSync(join(env.XDG_DATA_HOME, "opencode"), { recursive: true })
  copyFileSync(real, join(env.XDG_DATA_HOME, "opencode/auth.json"))
  // Your default model instead of the free one the seed pins.
  const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  const model = ["opencode.jsonc", "opencode.json"]
    .map((f) => (existsSync(join(configDir, f)) ? readFileSync(join(configDir, f), "utf8") : ""))
    .join("\n")
    .match(/^\s*"model"\s*:\s*"([^"]+)"/m)?.[1]
  writeFileSync(join(env.XDG_CONFIG_HOME, "opencode/opencode.json"), JSON.stringify(model ? { model } : {}))
}

// Which CLI tools to watch (not state): start from yours.
const tools = join(homedir(), ".config", "ctrl", "tools.json")
if (existsSync(tools) && !existsSync(join(sandbox, "ctrl/tools.json"))) copyFileSync(tools, join(sandbox, "ctrl/tools.json"))

// gh's keychain login is out of reach with the sandbox HOME: pass its token (env only, never printed), so the
// resources panel shows live PR status.
let ghToken
try {
  ghToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
} catch {}

// For the app only: the build keeps your real HOME.
process.env.CTRL_DEV_APP_ENV = JSON.stringify({
  HOME: env.HOME,
  XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: env.XDG_DATA_HOME,
  XDG_STATE_HOME: env.XDG_STATE_HOME,
  XDG_CACHE_HOME: env.XDG_CACHE_HOME,
  // Resolved with the real HOME, before the sandbox one replaces it.
  CTRL_OPENCODE: opencodeBin(),
  CTRL_FX: fxBin(),
  CTRL_USER_DATA: join(sandbox, "ctrl"),
  // Unix socket paths max out at 104 bytes: keep it out of the deeper sandbox folder.
  CTRL_SOCKET_PATH: join(dir, "ctrl.sock"),
  CTRL_SKILLS_DIR: join(sandbox, "skills"),
  ...(ghToken ? { GH_TOKEN: ghToken } : {}),
})
process.env.CTRL_REMOTE_PORT = String(port)
process.env.CTRL_LABEL = label

const tilde = (p) => p.replace(homedir(), "~")
console.log(`[preview] ${label}`)
console.log(`[preview] sandbox ${tilde(sandbox)} (${seeded ? "kept, --reset to reseed" : "freshly seeded"})`)
console.log(`[preview] models  ${auth ? "your opencode login (--auth)" : "free opencode/big-pickle, --auth for yours"}`)
console.log(`[preview] phone   port ${port}, link printed below once it's up`)
console.log(`[preview] cli     CTRL_SOCKET="${join(dir, "ctrl.sock").replace(homedir(), "$HOME")}" node dist/cli/cli.cjs status --pretty`)

await import("./dev.mjs")
