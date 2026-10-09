import { spawn } from "node:child_process"
import { createWriteStream, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { UpdateStatus } from "../shared/types"
import { runCli } from "./adapters/cli"
import { compareVersions } from "./opencode-bin"

export const REPO = "lucleray/ctrl"
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 10_000

type Release = { version: string; asset: string; url: string }

/**
 * Updates from GitHub Releases, through GitHub's public API (no login; unauthenticated calls
 * allow 60 an hour, and ctrl makes one every 6h). Files ctrl downloads itself aren't
 * quarantined by Gatekeeper (it isn't a browser), so the unsigned app keeps launching.
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
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "ctrl" },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 404) return this.set({ state: "up-to-date" })
      if (res.status === 403 || res.status === 429) {
        return this.set({ state: "error", detail: "GitHub rate limit reached, ctrl will try again later" })
      }
      if (!res.ok) return this.set({ state: "error", detail: `GitHub answered ${res.status}` })
      const data = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
      const version = data.tag_name.replace(/^v/, "")
      const asset = data.assets.find((a) => a.name.endsWith(`-mac-${process.arch}.zip`))
      if (!asset || compareVersions(version, this.current) <= 0) return this.set({ state: "up-to-date" })
      this.release = { version, asset: asset.name, url: asset.browser_download_url }
      this.set({ state: "available", version })
      if (!this.notified.has(version)) {
        this.notified.add(version)
        this.events.onAvailable(version)
      }
    } catch (err) {
      const offline = err instanceof Error && (err.name === "TimeoutError" || /fetch failed/i.test(err.message))
      this.set({ state: "error", detail: offline ? "Couldn't reach GitHub" : err instanceof Error ? err.message : String(err) })
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
      const res = await fetch(release.url, { headers: { "User-Agent": "ctrl" }, signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok || !res.body) throw new Error(`Download failed: GitHub answered ${res.status}`)
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(join(tmp, release.asset)))
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
