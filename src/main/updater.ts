import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AdapterError } from "../shared/adapters/adapter"
import type { UpdateStatus } from "../shared/types"
import { runCli } from "./adapters/cli"
import { compareVersions } from "./opencode-bin"

export const REPO = "lucleray/ctrl"
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 10_000

type Release = { tag: string; version: string; asset: string }

/**
 * Updates from GitHub Releases. The repo is private, so everything goes through the
 * gh CLI's login: ctrl never handles a token, and files gh downloads aren't quarantined
 * by Gatekeeper (it isn't a browser), so the unsigned app keeps launching.
 *
 * Installing downloads the release zip, unpacks it next to the running app, quits, and a
 * detached script swaps the bundles once ctrl has exited, then relaunches it. The old
 * bundle is only removed after the new one is in place.
 */
export class Updater {
  status: UpdateStatus = { state: "idle" }
  private release?: Release
  private notified = new Set<string>()
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private current: string,
    private events: {
      onChange(): void
      /** A newer version was found, once per version */
      onAvailable(version: string): void
      /** Everything's ready: quit so the swap script can run */
      quit(): void
    },
  ) {}

  start() {
    setTimeout(() => void this.check(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  stop() {
    clearInterval(this.timer)
  }

  private set(status: UpdateStatus) {
    this.status = status
    this.events.onChange()
  }

  async check() {
    if (this.status.state === "checking" || this.status.state === "downloading") return
    this.set({ state: "checking" })
    try {
      const res = await runCli("gh", ["api", `repos/${REPO}/releases/latest`], { timeout: 20_000 })
      if (res.code !== 0) {
        const err = res.stderr.trim().split("\n")[0] ?? ""
        const detail = /not found/i.test(err)
          ? `No releases visible to your gh account. Ask Luc for access to ${REPO}`
          : /auth|log ?in|token/i.test(err)
            ? "gh isn't logged in. Run gh auth login"
            : err || "gh api failed"
        return this.set({ state: "unavailable", detail })
      }
      const data = JSON.parse(res.stdout) as { tag_name: string; assets: { name: string }[] }
      const version = data.tag_name.replace(/^v/, "")
      const asset = data.assets.find((a) => a.name.endsWith(`-mac-${process.arch}.zip`))?.name
      if (!asset || compareVersions(version, this.current) <= 0) return this.set({ state: "up-to-date" })
      this.release = { tag: data.tag_name, version, asset }
      this.set({ state: "available", version })
      if (!this.notified.has(version)) {
        this.notified.add(version)
        this.events.onAvailable(version)
      }
    } catch (err) {
      if (err instanceof AdapterError && err.kind === "no-cli") {
        return this.set({ state: "unavailable", detail: "Updates need the gh CLI: brew install gh, then gh auth login" })
      }
      this.set({ state: "error", detail: err instanceof Error ? err.message : String(err) })
    }
  }

  /** The running .app bundle, from …/ctrl.app/Contents/MacOS/ctrl. */
  private bundle() {
    const bundle = resolve(process.execPath, "../../..")
    if (!bundle.endsWith(".app")) throw new Error("ctrl isn't running from an app bundle")
    return bundle
  }

  async install() {
    const release = this.release
    if (!release || this.status.state === "downloading") return
    this.set({ state: "downloading", version: release.version })
    const tmp = mkdtempSync(join(tmpdir(), "ctrl-update-"))
    try {
      const bundle = this.bundle()
      const run = async (cmd: string, args: string[], timeout = 60_000) => {
        const res = await runCli(cmd, args, { timeout })
        if (res.code !== 0) throw new Error(res.stderr.trim().split("\n")[0] || `${cmd} failed`)
      }
      await run("gh", ["release", "download", release.tag, "--repo", REPO, "--pattern", release.asset, "--dir", tmp], 10 * 60_000)
      await run("ditto", ["-x", "-k", join(tmp, release.asset), join(tmp, "unpacked")])
      const fresh = join(tmp, "unpacked", "ctrl.app")
      if (!existsSync(fresh)) throw new Error("The release zip has no ctrl.app")
      // Staged next to the app: same volume, so the swap is two renames. Also fails early
      // (before quitting) when the folder isn't writable.
      const staged = `${bundle}.new`
      rmSync(staged, { recursive: true, force: true })
      await run("ditto", [fresh, staged])

      const script = join(tmp, "swap.sh")
      writeFileSync(
        script,
        [
          `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
          `B=${JSON.stringify(bundle)}`,
          `if mv "$B" "$B.old" && mv "$B.new" "$B"; then rm -rf "$B.old"; else [ -d "$B" ] || mv "$B.old" "$B"; fi`,
          `xattr -dr com.apple.quarantine "$B" 2>/dev/null`,
          // CTRL_UPDATE_NO_RELAUNCH=1 is a test hook (docs/DEVELOPMENT.md): swap without opening a window.
          process.env.CTRL_UPDATE_NO_RELAUNCH === "1" ? "" : `open "$B"`,
          `rm -rf ${JSON.stringify(tmp)}`,
        ].join("\n"),
      )
      spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref()
      this.events.quit()
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true })
      this.set({ state: "error", detail: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }
}
