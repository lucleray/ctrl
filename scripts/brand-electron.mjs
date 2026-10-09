// Makes the dev app show up as "ctrl" (dock, ⌘-Tab, menu bar, notifications).
// macOS reads the name from the app bundle and caches it per bundle id, so we
// clone Electron.app into ctrl.app with its own id/name/icon and point the
// `electron` package at it. Runs on postinstall; packaged builds get this from
// electron-builder instead.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { sign } from "./sign.mjs"

if (process.platform !== "darwin") process.exit(0)

const NAME = "ctrl"
const BUNDLE_ID = "im.luc.ctrl.dev"
const dist = join("node_modules", "electron", "dist")
const source = join(dist, "Electron.app")
const target = join(dist, `${NAME}.app`)

if (!existsSync(source)) {
  console.log("[brand] Electron.app not found yet, skipping (rerun: npm run brand)")
  process.exit(0)
}

rmSync(target, { recursive: true, force: true })
execFileSync("ditto", [source, target])

const plist = join(target, "Contents", "Info.plist")
const set = (key, value) => {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "pipe" })
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist], { stdio: "pipe" })
  }
}
set("CFBundleName", NAME)
set("CFBundleDisplayName", NAME)
set("CFBundleIdentifier", BUNDLE_ID)
// Same folder-access explanations as the packaged app (package.json → build.mac.extendInfo).
const { extendInfo } = JSON.parse(readFileSync("package.json", "utf8")).build.mac
for (const [key, value] of Object.entries(extendInfo)) set(key, `"${value}"`)

const icon = join("build", "icon.icns")
if (existsSync(icon)) copyFileSync(icon, join(target, "Contents", "Resources", "electron.icns"))

// Editing the bundle breaks its signature; re-sign so macOS still launches it (and keeps folder grants).
sign(target, { stdio: "pipe" })

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
try {
  execFileSync(lsregister, ["-f", target], { stdio: "pipe" })
} catch {}

// `require("electron")` / `npx electron` resolve the binary through path.txt.
writeFileSync(join("node_modules", "electron", "path.txt"), `${NAME}.app/Contents/MacOS/Electron`)

console.log(`[brand] dev app is now ${target} (${BUNDLE_ID})`)
