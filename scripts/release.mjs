// Publishes the version in package.json as a GitHub release with arm64 + x64 zips.
// Bump first (npm version minor --no-git-tag-version, commit, merge), then: npm run release
// Installed apps see the new release within a few hours (src/main/updater.ts).
import { execFileSync, execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const REPO = "lucleray/ctrl"
const { version } = JSON.parse(readFileSync("package.json", "utf8"))
const tag = `v${version}`
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim()
const ok = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

if (out("git", ["status", "--porcelain"])) throw new Error("Commit or stash your changes first")
if (ok("gh", ["release", "view", tag, "--repo", REPO])) throw new Error(`${tag} is already released. Bump the version first`)
const sha = out("git", ["rev-parse", "HEAD"])
execSync("git fetch origin --quiet")
if (!out("git", ["branch", "-r", "--contains", sha])) throw new Error("Push this commit first, the release points at it")

execSync("node scripts/package.mjs --arch all --zip", { stdio: "inherit" })

const zips = ["arm64", "x64"].map((arch) => `release/ctrl-${version}-mac-${arch}.zip`)
execFileSync(
  "gh",
  ["release", "create", tag, ...zips, "--repo", REPO, "--target", sha, "--title", `ctrl ${version}`, "--generate-notes"],
  { stdio: "inherit" },
)
console.log(`[release] published ${tag}`)
