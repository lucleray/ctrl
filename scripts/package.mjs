// Builds release/mac-*/ctrl.app. With --install, replaces /Applications/ctrl.app
// with it (quitting the running copy first) so it launches like any other app.
import { execFileSync, execSync } from "node:child_process"
import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const run = (cmd) => execSync(cmd, { stdio: "inherit" })

run("npm run build")
rmSync("release", { recursive: true, force: true })
run("npx electron-builder --mac --dir")

const out = readdirSync("release").find((d) => d.startsWith("mac"))
const built = join("release", out, "ctrl.app")
if (!existsSync(built)) throw new Error(`no app at ${built}`)

// Not notarized (it's built locally, so no quarantine), but Apple Silicon still
// needs a valid signature to launch: sign it ad hoc.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", built], { stdio: "inherit" })
console.log(`[package] built ${built}`)

if (process.argv.includes("--install")) {
  const target = "/Applications/ctrl.app"
  const running = () => {
    try {
      execFileSync("pgrep", ["-f", `^${target}/Contents/MacOS/`], { stdio: "pipe" })
      return true
    } catch {
      return false
    }
  }
  const wasRunning = running()
  if (wasRunning) {
    execFileSync("osascript", ["-e", 'tell application id "im.luc.ctrl" to quit'], { stdio: "inherit" })
    for (let i = 0; i < 50 && running(); i++) execSync("sleep 0.2")
  }
  rmSync(target, { recursive: true, force: true })
  execFileSync("ditto", [built, target])
  execFileSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", target],
  )
  console.log(`[package] installed ${target}`)
  if (wasRunning) execFileSync("open", [target])
}
