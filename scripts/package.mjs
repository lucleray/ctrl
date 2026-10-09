// Builds ctrl.app for macOS, signed with the "ctrl Code Signing" certificate (ad hoc without it, releases refuse).
//   node scripts/package.mjs                  this Mac's arch → release/mac*/ctrl.app
//   node scripts/package.mjs --install        same, then replaces /Applications/ctrl.app (quitting it first)
//   node scripts/package.mjs --arch all --zip arm64 + x64, zipped as release/ctrl-mac-<arch>.zip
import { execFileSync, execSync } from "node:child_process"
import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { sign } from "./sign.mjs"

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const host = process.arch === "arm64" ? "arm64" : "x64"
const archs = { all: ["arm64", "x64"], arm64: ["arm64"], x64: ["x64"] }[option("--arch") ?? host]
if (!archs) throw new Error("--arch must be arm64, x64 or all")

const run = (cmd) => execSync(cmd, { stdio: "inherit" })

run("npm run build")
rmSync("release", { recursive: true, force: true })
run(`npx electron-builder --mac --dir ${archs.map((a) => `--${a}`).join(" ")}`)

// electron-builder names the output folder mac-arm64 for arm64, and plain mac for x64.
const appFor = (arch) => {
  const dir = readdirSync("release").find((d) => d === (arch === "x64" ? "mac" : `mac-${arch}`))
  const app = dir && join("release", dir, "ctrl.app")
  if (!app || !existsSync(app)) throw new Error(`no ${arch} app in release/`)
  return app
}

for (const arch of archs) {
  const app = appFor(arch)
  // Not notarized (no Developer ID). Downloads through curl or ctrl's updater aren't quarantined,
  // so Gatekeeper lets it run. Releases must use the certificate: an ad-hoc release would make
  // every user grant folder access again.
  const signer = sign(app, { requireIdentity: flag("--zip") })
  console.log(`[package] built ${app} (signed: ${signer})`)
  if (flag("--zip")) {
    // No version in the name, so install.sh can download releases/latest/download/ctrl-mac-<arch>.zip.
    const zip = join("release", `ctrl-mac-${arch}.zip`)
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip])
    console.log(`[package] zipped ${zip}`)
  }
}

if (flag("--install")) {
  if (!archs.includes(host)) throw new Error(`--install needs a ${host} build`)
  const built = appFor(host)
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
