// Regenerates the README screenshots in docs/media from demo data (docs/DEVELOPMENT.md → Screenshots).
// Usage: node scripts/demo/capture.mjs [demo dir]
// Runs ctrl headless (no window, no focus steal) against a throwaway opencode seeded by seed.mjs.
import { execFileSync, spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { demoEnv, opencodeBin } from "./env.mjs"

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null
const DEMO = resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only") ?? join(tmpdir(), "ctrl-demo"))
const OUT = resolve("docs/media")
const RAW = join(DEMO, "raw")
mkdirSync(OUT, { recursive: true })
if (!flag("--no-seed")) {
  // Stop a demo service left over from a previous run before seeding wipes its folder.
  try {
    execFileSync(opencodeBin(), ["service", "stop"], { env: demoEnv(DEMO), stdio: "ignore" })
  } catch {}
  execFileSync("node", ["scripts/demo/seed.mjs", DEMO], { stdio: "inherit" })
}
mkdirSync(RAW, { recursive: true })
// The skill counts as installed (a copy ctrl didn't make), so no "install the skill" toast.
cpSync("skills/read-session", join(DEMO, "skills/read-session"), { recursive: true })
execFileSync("npm", ["run", "build"], { stdio: "ignore" })
const ids = JSON.parse(readFileSync(join(DEMO, "ids.json"), "utf8"))

const branded = "node_modules/electron/dist/ctrl.app/Contents/MacOS/Electron"
const electron = existsSync(branded) ? branded : createRequire(import.meta.url)("electron")

// The demo HOME hides gh's keychain login: hand its token over (env only, never printed),
// so the resources panel shows live PR status. Without it, links still show, without status.
let ghToken
try {
  ghToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()
} catch {}

/** Launches ctrl headless with debug hooks (docs/DEVELOPMENT.md → Debug hooks), kills it after `seconds`. */
function scene(name, { seconds = 22, hooks }) {
  if (only && only !== name) return
  rmSync(join(RAW, name), { recursive: true, force: true })
  return new Promise((done) => {
    console.log(`[demo] ${name}`)
    const env = {
      ...demoEnv(DEMO),
      ...(ghToken ? { GH_TOKEN: ghToken } : {}),
      CTRL_OPENCODE: opencodeBin(),
      CTRL_USER_DATA: join(DEMO, "ctrl"),
      CTRL_HEADLESS: "1",
      CTRL_SKILLS_DIR: join(DEMO, "skills"),
      ...hooks,
    }
    const app = spawn(electron, ["."], { env, stdio: ["ignore", "pipe", "pipe"] })
    const log = (d) => flag("--verbose") ? process.stdout.write(`  ${d}`) : /\[ctrl\] (screenshot|eval|\d+ frames)/.test(d) && process.stdout.write(`  ${d}`)
    app.stdout.on("data", log)
    app.stderr.on("data", (d) => flag("--verbose") && process.stdout.write(`  ${d}`))
    const timer = setTimeout(() => app.kill(), seconds * 1000)
    app.on("exit", () => (clearTimeout(timer), done()))
  })
}

const js = (fn, args) => `(${fn.toString()})(${JSON.stringify(args)})`

/** Renderer-side: open a session, set the resources scope, optionally open the palette with a query. */
async function setup({ session, scope, query }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await window.ctrl.setUi({ resourcesOpen: !query, resourcesScope: scope ?? "session" })
  await window.ctrl.openSession(session)
  if (!query) return "ready"
  await sleep(4000)
  const input = document.querySelector(".palette-input")
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, query)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  return "typed"
}

/** Renderer-side: drags a sidebar session onto the terminal (real drag events), then types a prompt. */
async function dragReference({ open, drag, prompt }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await window.ctrl.setUi({ resourcesOpen: false })
  await window.ctrl.openSession(open)
  await sleep(13000)
  const row = document.querySelector(`.space-sessions [data-session-id="${drag}"]`)
  const main = document.querySelector(".main").getBoundingClientRect()
  const r = row.getBoundingClientRect()
  const dt = new DataTransfer()
  dt.setData("application/x-ctrl-session", drag)
  // What the cursor carries: a copy of the row (synthetic drags draw no drag image).
  const ghost = row.cloneNode(true)
  Object.assign(ghost.style, {
    position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    zIndex: 9999, pointerEvents: "none", background: "var(--card-bg)", borderRadius: "8px",
    boxShadow: "0 10px 30px rgba(0,0,0,.18)", transform: "rotate(-2deg)",
  })
  document.body.appendChild(ghost)
  row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }))
  // Lands just below the drop card, so its text stays readable.
  const to = { x: main.left + main.width / 2 - r.width / 2, y: main.top + main.height / 2 + 56 }
  const steps = 40
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
    ghost.style.left = `${r.left + (to.x - r.left) * e}px`
    ghost.style.top = `${r.top + (to.y - r.top) * e}px`
    if (i === Math.round(steps * 0.55)) {
      document.querySelector(".reference-drop")?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
    await sleep(45)
  }
  const zone = document.querySelector(".reference-drop")
  zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
  await sleep(1000)
  zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }))
  ghost.remove()
  document.dispatchEvent(new DragEvent("dragend", { bubbles: true }))
  await sleep(600)
  for (const ch of prompt) {
    window.ctrl.ptyWrite(ch)
    await sleep(45)
  }
  return "dragged"
}

const shot = (file, at = 16000) => ({ CTRL_SCREENSHOT: join(RAW, file), CTRL_SCREENSHOT_DELAY: String(at) })

// The first launch also starts the demo service and builds the search index: give it longer.
await scene("hero", { seconds: 30, hooks: { CTRL_EVAL: js(setup, { session: ids.loopback }), ...shot("hero.png", 20000) } })
await scene("resources", { hooks: { CTRL_EVAL: js(setup, { session: ids.loopback, scope: "space" }), ...shot("resources.png") } })
await scene("search", {
  hooks: {
    CTRL_EVAL: js(setup, { session: ids.loopback, query: "test" }),
    CTRL_SEND: JSON.stringify(["shortcut", "palette"]),
    ...shot("search.png"),
  },
})
await scene("jump", {
  hooks: {
    CTRL_EVAL: js(setup, { session: ids.loopback }),
    CTRL_INPUT: JSON.stringify([[15000, "keyDown", "Meta", ["meta"]]]),
    ...shot("jump.png", 16000),
  },
})
await scene("reference", {
  seconds: 32,
  hooks: {
    CTRL_EVAL: js(dragReference, { open: ids.roadmap, drag: ids.loopback, prompt: "add this to the roadmap under DX" }),
    CTRL_FRAMES: `${join(RAW, "reference")},15000,100,90`,
  },
})
try {
  execFileSync(opencodeBin(), ["service", "stop"], { env: demoEnv(DEMO), stdio: "ignore" })
} catch {}

// Crop, resize and encode the GIF inside Electron (nativeImage) with gifenc, installed into the demo folder.
const tools = join(DEMO, "tools")
if (!existsSync(join(tools, "node_modules/gifenc"))) {
  execFileSync("npm", ["install", "--prefix", tools, "gifenc", "--no-audit", "--no-fund"], { stdio: "ignore" })
}
execFileSync(electron, ["scripts/demo/media.mjs", RAW, OUT, join(tools, "node_modules")], { stdio: "inherit", env: { ...process.env, CTRL_HEADLESS: "1" } })
console.log(`[demo] done, see ${OUT}`)
