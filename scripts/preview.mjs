// Runs this checkout as its own ctrl, next to the installed app and to other previews, on a copy of your real data.
//   npm run preview                   labelled with the current branch, starts from a fresh copy of your state
//   npm run preview -- --keep         reuse this preview's state from last time instead
//   npm run preview -- --name <name>  label (and state folder) other than the branch name
// Same live reload as `npm run dev`. Each label gets its own state folder, socket and phone port.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

const argv = process.argv.slice(2)
const option = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const keep = argv.includes("--keep")

// Fresh checkouts and worktrees can have node_modules without Electron's binary (its postinstall didn't run).
if (!existsSync("node_modules/electron/path.txt")) {
  execFileSync("node", ["node_modules/electron/install.js"], { stdio: "inherit" })
  execFileSync("node", ["scripts/brand-electron.mjs"], { stdio: "inherit" })
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()
const branch = git("rev-parse", "--abbrev-ref", "HEAD")
const label = option("--name") ?? (branch === "HEAD" ? git("rev-parse", "--short", "HEAD") : branch)
const slug = label.replace(/[^\w.-]+/g, "-")

// Electron's appData on macOS, where the installed app keeps its state (`ctrl`).
const appData = join(homedir(), "Library", "Application Support")
const real = join(appData, "ctrl")
const dir = join(appData, "ctrl-preview", slug)
mkdirSync(dir, { recursive: true })

// spaces, assignments, settings (state.json) and watched tools (tools.json, see TOOLS_FILE in src/main/main.ts).
// Caches (search index, resource details) rebuild on their own.
const seeds = [
  [join(real, "state.json"), join(dir, "state.json")],
  [join(homedir(), ".config", "ctrl", "tools.json"), join(dir, "tools.json")],
]
for (const [from, to] of seeds) {
  if (!existsSync(from) || (keep && existsSync(to))) continue
  copyFileSync(from, to)
}

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

process.env.CTRL_USER_DATA = dir
// A preview never touches the agent skills you have installed: its copies of them (which point agents at this
// checkout's CLI) would replace the installed app's until that app restarts.
process.env.CTRL_SKILLS_DIR ??= join(dir, "skills")
process.env.CTRL_REMOTE_PORT = String(port)
process.env.CTRL_LABEL = label

const tilde = (p) => p.replace(homedir(), "~")
console.log(`[preview] ${label}`)
console.log(`[preview] state  ${tilde(dir)} (${keep ? "kept" : "fresh copy of your ctrl state"})`)
console.log(`[preview] phone  port ${port}, link printed below once it's up`)
console.log(`[preview] cli    CTRL_SOCKET="${join(dir, "ctrl.sock").replace(homedir(), "$HOME")}" node dist/cli/cli.cjs status --pretty`)

await import("./dev.mjs")
