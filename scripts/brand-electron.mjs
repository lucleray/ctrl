// Rebrands the dev Electron.app so the dock, ⌘-Tab and notifications say "ctrl"
// (they read the bundle's Info.plist, not anything the app sets at runtime).
// Runs on postinstall; packaged builds get this from electron-builder instead.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"

if (process.platform !== "darwin") process.exit(0)

const NAME = "ctrl"
const app = join("node_modules", "electron", "dist", "Electron.app")
const plist = join(app, "Contents", "Info.plist")
if (!existsSync(plist)) {
  console.log("[brand] Electron.app not found yet, skipping (rerun: npm run brand)")
  process.exit(0)
}

const buddy = (cmd) => execFileSync("/usr/libexec/PlistBuddy", ["-c", cmd, plist], { stdio: "pipe" })
for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  try {
    buddy(`Set :${key} ${NAME}`)
  } catch {
    buddy(`Add :${key} string ${NAME}`)
  }
}

const icon = join("build", "icon.icns")
if (existsSync(icon)) copyFileSync(icon, join(app, "Contents", "Resources", "electron.icns"))

// Editing Info.plist breaks the bundle's signature; re-sign ad hoc so macOS still launches it.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "pipe" })

// Nudge Launch Services so the dock picks up the new name/icon.
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
try {
  execFileSync(lsregister, ["-f", app], { stdio: "pipe" })
} catch {}

console.log(`[brand] dev Electron.app now shows as "${NAME}"`)
