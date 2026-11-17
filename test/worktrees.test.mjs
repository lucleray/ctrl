// The worktree pool (src/main/worktrees): pool sizing, and the service against throwaway git repos
// (take, release, recycle, cleanup), all inside a temp folder.
import * as esbuild from "esbuild"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ctrl-worktrees-test-")))
let WorktreeService, poolTarget, simulateMisses, MINUTE, DAY, createHandlers

const load = async (entry) => {
  const outfile = join(tmp, entry.replace(/\W/g, "_") + ".cjs")
  await esbuild.build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "cjs", logLevel: "warning" })
  return createRequire(import.meta.url)(outfile)
}

before(async () => {
  ;({ WorktreeService } = await load("src/main/worktrees/service.ts"))
  ;({ poolTarget, simulateMisses, MINUTE, DAY } = await load("src/shared/worktrees.ts"))
  ;({ createHandlers } = await load("src/main/cli-handlers.ts"))
})

after(() => rmSync(tmp, { recursive: true, force: true }))

const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

let n = 0
/** A repo with an origin, one commit on main, node_modules ignored. */
const makeRepo = (name = `repo${++n}`) => {
  const origin = join(tmp, `${name}-origin.git`)
  const source = join(tmp, name)
  mkdirSync(source)
  sh(tmp, "git", "init", "--bare", "-b", "main", origin)
  sh(source, "git", "init", "-b", "main")
  sh(source, "git", "config", "user.email", "test@example.com")
  sh(source, "git", "config", "user.name", "Test")
  writeFileSync(join(source, ".gitignore"), "node_modules\n")
  writeFileSync(join(source, "README.md"), "hello\n")
  sh(source, "git", "add", ".")
  sh(source, "git", "commit", "-m", "init")
  sh(source, "git", "remote", "add", "origin", origin)
  sh(source, "git", "push", "-u", "origin", "main")
  return source
}

const SETUP = "mkdir -p node_modules && echo installed > node_modules/marker"

/** A service on its own state file and folder, with sessions the test controls. */
const makeService = (settings = {}) => {
  const dir = mkdtempSync(join(tmp, "svc-"))
  const sessions = new Map()
  const changes = []
  const service = new WorktreeService(join(dir, "worktrees.json"), join(dir, "worktrees"), {
    settings: () => ({ root: null, poolAuto: true, poolMax: 3, cleanup: true, updateRepos: false, ...settings }),
    sessionState: async (id) => sessions.get(id) ?? "active",
    changed: (ids) => changes.push(...ids),
  })
  return { service, sessions, changes, dir }
}

const until = async (check, what, ms = 20000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const ready = (service, source) => service.all().filter((w) => w.repo === source && w.status === "ready")
const settled = (service) => until(() => service.all().every((w) => ["ready", "attached"].includes(w.status)), "the pool to settle")

describe("pool sizing", () => {
  test("a request finding the pool empty is a miss, and refills come back after the build time", () => {
    const m = 60_000
    assert.equal(simulateMisses([0, 1, 2], 1, 5 * m), 2)
    assert.equal(simulateMisses([0, 1, 2], 3, 5 * m), 0)
    assert.equal(simulateMisses([0, 6 * m, 12 * m], 1, 5 * m), 0)
    // Two refills at a time: the third waits for a slot.
    assert.equal(simulateMisses([0, 1, 2, 5 * m + 10, 5 * m + 11, 5 * m + 12], 3, 5 * m, 2), 1)
  })

  test("the smallest pool that serves the week, one for a quiet repo, none for a dormant one", () => {
    const now = 100 * DAY
    assert.equal(poolTarget([], now, MINUTE, 8), 0)
    assert.equal(poolTarget([now - 40 * DAY], now, MINUTE, 8), 0)
    assert.equal(poolTarget([now - 10 * DAY], now, MINUTE, 8), 1)
    assert.equal(poolTarget([now - DAY], now, MINUTE, 8), 1)
    // Three within a build time need three warm; spread out, one is enough.
    assert.equal(poolTarget([now - DAY, now - DAY + 1000, now - DAY + 2000], now, 5 * MINUTE, 8), 3)
    assert.equal(poolTarget([now - 3 * DAY, now - 2 * DAY, now - DAY], now, 5 * MINUTE, 8), 1)
    assert.equal(poolTarget([now - DAY, now - DAY + 1, now - DAY + 2, now - DAY + 3], now, 5 * MINUTE, 2), 2)
    assert.equal(poolTarget([now - DAY], now, MINUTE, 0), 0)
  })
})

describe("WorktreeService", () => {
  test("up registers a new repo, builds a worktree for the session, then keeps one warm", async () => {
    const source = makeRepo()
    const { service, changes } = makeService()
    await service.configure(source, { setup: SETUP })
    const { worktree, cold } = await service.up(source, "ses_a")
    assert.equal(cold, true)
    assert.equal(worktree.status, "attached")
    assert.equal(worktree.sessionID, "ses_a")
    assert.equal(readFileSync(join(worktree.path, "node_modules/marker"), "utf8").trim(), "installed")
    assert.equal(sh(worktree.path, "git", "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
    assert.ok(changes.includes("ses_a"))
    const repo = await service.repo(source)
    assert.deepEqual([repo.baseBranch, repo.setup, repo.auto, repo.target], ["main", SETUP, true, 1])

    // One request in the last week: the pool keeps one warm, and the next request gets it right away.
    await until(() => ready(service, source).length === 1, "a warm worktree")
    const second = await service.up(source, "ses_b")
    assert.equal(second.cold, false)
    assert.notEqual(second.worktree.path, worktree.path)
    assert.deepEqual(service.ofSession("ses_a").map((w) => w.id), [worktree.id])
    const view = await service.repo(source)
    assert.equal(view.usage.taken, 2)
    assert.equal(view.usage.instant, 0.5)
    await settled(service)
    service.stop()
  })

  test("a path inside the repo, one of its worktrees, or its name all mean the same repo", async () => {
    const source = makeRepo("named")
    mkdirSync(join(source, "packages/app"), { recursive: true })
    const { service } = makeService()
    const first = await service.up(join(source, "packages/app"), "ses_a")
    const viaWorktree = await service.repo(first.worktree.path)
    const viaName = await service.repo("named")
    assert.equal(viaWorktree.source, source)
    assert.equal(viaName.source, source)
    await assert.rejects(service.repo("nope"), /No repo called/)
    await assert.rejects(service.up(tmp, "ses_a"), /isn't a git repo/)
    await settled(service)
    service.stop()
  })

  test("down refuses unsaved work, and a released worktree comes back warm in a new folder", async () => {
    const source = makeRepo()
    const { service } = makeService()
    await service.configure(source, { setup: SETUP, warm: 1 })
    const { worktree } = await service.up(source, "ses_a")
    await settled(service)
    const path = worktree.path

    writeFileSync(join(path, "scratch.txt"), "work in progress\n")
    await assert.rejects(service.down(service.find(path)), /1 uncommitted file \(scratch.txt\)/)
    sh(path, "git", "switch", "-c", "feature")
    sh(path, "git", "add", ".")
    sh(path, "git", "commit", "-m", "wip")
    await assert.rejects(service.down(service.find(worktree.id)), /1 commit on feature that no remote has/)
    sh(path, "git", "push", "-u", "origin", "feature")

    // Found from a folder inside it, like an agent running `ctrl worktree down` there.
    mkdirSync(join(path, "src"))
    const res = await service.down(service.find(undefined, join(path, "src")))
    assert.deepEqual(res, { branch: "feature", forced: false, rescueRef: null })
    // The pool is full (one warm already), so the released one is removed: nothing left at its path.
    await until(() => !existsSync(path), "the released worktree to go")
    assert.equal(ready(service, source).length, 1)

    // With room in the pool it's recycled instead: reset to main, under another id and folder.
    const next = await service.up(source, "ses_b")
    writeFileSync(join(next.worktree.path, "README.md"), "changed\n")
    const forced = await service.down(next.worktree, { force: true })
    assert.equal(forced.forced, true)
    const [warm] = await until(() => (ready(service, source).length === 1 ? ready(service, source) : null), "the recycled worktree")
    assert.notEqual(warm.path, next.worktree.path)
    assert.equal(existsSync(next.worktree.path), false)
    assert.equal(readFileSync(join(warm.path, "README.md"), "utf8"), "hello\n")
    assert.equal(sh(source, "git", "worktree", "list").split("\n").length, 2)
    service.stop()
  })

  test("a build goes on when its caller leaves, and the session's next up gets that worktree", async () => {
    const source = makeRepo()
    const { service } = makeService()
    await service.configure(source, { setup: `sleep 0.3 && ${SETUP}`, warm: 0 })
    const gone = await service.up(source, "ses_a", { alive: () => false })
    assert.equal(gone.worktree.undelivered, true)
    const again = await service.up(source, "ses_a")
    assert.equal(again.worktree.id, gone.worktree.id)
    assert.equal(again.worktree.undelivered, undefined)
    // Delivered now: the next one is a worktree of its own.
    const other = await service.up(source, "ses_a")
    assert.notEqual(other.worktree.id, gone.worktree.id)
    assert.equal(service.ofSession("ses_a").length, 2)
    service.stop()
  })

  test("a failing setup: warm builds are dropped and remembered, a session still gets its checkout", async () => {
    const source = makeRepo()
    const { service } = makeService()
    await service.configure(source, { setup: "echo nope >&2; exit 3", warm: 1 })
    const { worktree } = await service.up(source, "ses_a")
    assert.equal(worktree.setupFailed, true)
    assert.ok(existsSync(join(worktree.path, "README.md")))
    await until(() => service.all().length === 1, "the failed warm build to be dropped")
    const repo = await service.repo(source)
    assert.match(repo.error, /Setup failed: echo nope/)
    assert.equal(repo.counts.ready, 0)
    service.stop()
  })

  test("cleanup releases the worktrees of archived and deleted sessions and removes folders nothing tracks", async () => {
    const source = makeRepo()
    const { service, sessions, dir } = makeService()
    await service.configure(source, { warm: 0 })
    const kept = await service.up(source, "ses_active")
    const archived = await service.up(source, "ses_archived")
    const deleted = await service.up(source, "ses_deleted")
    const unknown = await service.up(source, "ses_unknown")
    writeFileSync(join(archived.worktree.path, "dirty.txt"), "never committed\n")
    sessions.set("ses_archived", "archived").set("ses_deleted", "gone").set("ses_unknown", "unknown")

    const slugDir = join(dir, "worktrees", readdirOnly(join(dir, "worktrees")))
    const stray = join(slugDir, "stray")
    const fresh = join(slugDir, "fresh")
    mkdirSync(stray)
    mkdirSync(fresh)
    const old = new Date(Date.now() - 2 * 3600_000)
    utimesSync(stray, old, old)

    const preview = await service.cleanup({ apply: false })
    assert.deepEqual(preview.released.map((r) => [r.sessionID, r.reason]).sort(), [
      ["ses_archived", "session archived"],
      ["ses_deleted", "session deleted"],
    ])
    assert.deepEqual(preview.removed, [stray])
    assert.equal(service.ofSession("ses_archived").length, 1)

    assert.match(await service.runJob("cleanup"), /released 2 worktrees.*removed 1 folder/)
    await until(() => service.all().length === 2, "released worktrees to go")
    assert.deepEqual(service.all().map((w) => w.sessionID).sort(), ["ses_active", "ses_unknown"])
    assert.equal(existsSync(archived.worktree.path), false)
    assert.equal(existsSync(deleted.worktree.path), false)
    assert.equal(existsSync(stray), false)
    assert.ok(existsSync(fresh))
    assert.ok(existsSync(kept.worktree.path) && existsSync(unknown.worktree.path))
    service.stop()
  })

  test("releasing a session keeps commits made on a detached HEAD under a rescue ref", async () => {
    const source = makeRepo()
    const { service } = makeService()
    await service.configure(source, { warm: 0 })
    const { worktree } = await service.up(source, "ses_a")
    writeFileSync(join(worktree.path, "new.txt"), "x\n")
    sh(worktree.path, "git", "add", ".")
    sh(worktree.path, "git", "commit", "-m", "detached work")
    const commit = sh(worktree.path, "git", "rev-parse", "HEAD")
    await service.releaseSession("ses_a")
    await until(() => service.all().length === 0, "the worktree to go")
    assert.match(sh(source, "git", "for-each-ref", "--format=%(objectname) %(refname)", "refs/ctrl/rescue"), new RegExp(`^${commit} refs/ctrl/rescue/${worktree.id}-`))
    service.stop()
  })

  test("a folder another ctrl owns is never used: this one falls back to its own", async () => {
    const shared = mkdtempSync(join(tmp, "shared-"))
    const a = makeService({ root: shared })
    const b = makeService({ root: shared })
    assert.equal(a.service.root(), shared)
    assert.equal(b.service.root(), join(b.dir, "worktrees"))
  })

  test("state survives a restart, and a build cut short by one is cleared away", async () => {
    const source = makeRepo()
    const first = makeService()
    await first.service.configure(source, { warm: 0 })
    const { worktree } = await first.service.up(source, "ses_a")
    first.service.stop()
    const file = join(first.dir, "worktrees.json")
    const saved = JSON.parse(readFileSync(file, "utf8"))
    const half = join(first.dir, "worktrees", "half")
    mkdirSync(half)
    saved.worktrees.push({ id: "half", repo: source, path: half, status: "building", sessionID: null, baseCommit: null, warmedAt: null, attachedAt: null, since: 0 })
    writeFileSync(file, JSON.stringify(saved))

    const service = new WorktreeService(file, join(first.dir, "worktrees"), {
      settings: () => ({ root: null, poolAuto: true, poolMax: 3, cleanup: true, updateRepos: false }),
      sessionState: async () => "active",
      changed: () => {},
    })
    service.start()
    await until(() => service.all().length === 1, "the half-built worktree to be cleared")
    assert.equal(existsSync(half), false)
    assert.deepEqual(service.ofSession("ses_a").map((w) => w.path), [worktree.path])
    service.stop()
  })

  test("forget stops managing a repo once no session holds a worktree of it", async () => {
    const source = makeRepo()
    const { service } = makeService()
    await service.configure(source, { warm: 1 })
    const { worktree } = await service.up(source, "ses_a")
    await settled(service)
    await assert.rejects(service.forget(source), /1 session still holds a worktree/)
    await service.releaseSession("ses_a")
    await until(() => !existsSync(worktree.path), "the released worktree to go")
    await settled(service)
    const { removed } = await service.forget(source)
    assert.equal(removed, 1)
    assert.equal(service.view().repos.length, 0)
    assert.equal(service.all().length, 0)
    service.stop()
  })
})

describe("worktree handlers", () => {
  const setup = () => {
    const { service, sessions } = makeService()
    const data = { assignments: {}, archived: {}, createdByAgent: {}, parents: {}, spaces: [], settings: { worktreePoolMax: 3 } }
    const list = ["ses_a", "ses_b"].map((id) => ({ id, harness: "opencode", title: id, directory: "/", status: "idle", updated: 1 }))
    const host = {
      store: { data },
      sessions: () => list,
      currentSessionID: () => null,
      termSession: () => undefined,
      isLive: () => false,
      worktrees: service,
      // ses_sub is a subagent of ses_a: ctrl doesn't list it.
      rootSession: async (id) => (id === "ses_sub" ? "ses_a" : null),
    }
    const handlers = createHandlers(host)
    const call = (command, args = {}, caller = { opencodeSessionID: "ses_a" }) =>
      handlers[command](args, { v: 1, command, args, caller }, { emit: () => {}, closed: new Promise(() => {}) })
    return { service, sessions, data, call }
  }

  test("up takes a worktree for the calling session, a subagent's goes to the session it works for", async () => {
    const source = makeRepo()
    const { service, data, call } = setup()
    await service.configure(source, { warm: 0 })
    const first = await call("worktree up", { repo: source })
    assert.equal(first.sessionID, "ses_a")
    assert.equal(first.cold, true)
    assert.equal(first.branch, null)
    assert.equal(first.baseBranch, "main")
    assert.match(first.hint, /create a branch before committing/)
    assert.ok(existsSync(join(first.path, "README.md")))

    const second = await call("worktree up", { repo: source }, { opencodeSessionID: "ses_sub" })
    assert.equal(second.sessionID, "ses_a")
    assert.match(second.hint, new RegExp(`also holds 1 other worktree .*${first.id}`))

    await assert.rejects(call("worktree up", { repo: source }, {}), (err) => err.code === "NO_SELF" && /--session/.test(err.extra.hint))
    const forB = await call("worktree up", { repo: source, session: "ses_b" }, {})
    assert.equal(forB.sessionID, "ses_b")
    data.archived.ses_b = 1
    await assert.rejects(call("worktree up", { repo: source, session: "ses_b" }), (err) => err.code === "CONFLICT")

    const session = await call("session get", { session: "ses_a" })
    assert.deepEqual(session.worktrees.map((w) => w.path).sort(), [first.path, second.path].sort())
    service.stop()
  })

  test("list shows the session's worktrees by default, down releases the one you're in", async () => {
    const source = makeRepo()
    const { service, call } = setup()
    await service.configure(source, { warm: 1, name: "app" })
    const mine = await call("worktree up", { repo: "app" })
    const theirs = await call("worktree up", { repo: "app", session: "ses_b" })
    await settled(service)

    const listed = await call("worktree list")
    assert.equal(listed.scope, "session")
    assert.deepEqual(listed.items.map((w) => w.id), [mine.id])
    const all = await call("worktree list", { all: true })
    assert.equal(all.scope, "all")
    assert.deepEqual(all.items.map((w) => w.status).sort(), ["attached", "attached", "ready"])
    const outside = await call("worktree list", {}, {})
    assert.equal(outside.scope, "all")

    sh(mine.path, "git", "switch", "-c", "feature")
    assert.equal((await call("worktree list", { repo: "app" })).items[0].branch, "feature")
    writeFileSync(join(mine.path, "x.txt"), "x\n")
    await assert.rejects(call("worktree down", {}, { opencodeSessionID: "ses_a", cwd: mine.path }), (err) => err.code === "CONFLICT" && /--force/.test(err.extra.hint))
    const down = await call("worktree down", { force: true }, { opencodeSessionID: "ses_a", cwd: mine.path })
    assert.deepEqual([down.id, down.released, down.forced, down.branch], [mine.id, true, true, "feature"])
    assert.equal((await call("worktree down", { worktree: theirs.path })).id, theirs.id)
    await assert.rejects(call("worktree down", { worktree: "nope" }), (err) => err.code === "NOT_FOUND")
    await settled(service)
    service.stop()
  })

  test("config shows every repo, or registers and changes one", async () => {
    const source = makeRepo()
    const { service, call } = setup()
    const added = await call("worktree config", { repo: source, name: "lib", warm: "2", setup: SETUP })
    assert.deepEqual([added.label, added.warm, added.target, added.auto, added.setup, added.changed], ["lib", 2, 2, false, SETUP, true])
    await until(() => ready(service, source).length === 2, "two warm worktrees")
    const auto = await call("worktree config", { repo: "lib", warm: "auto", setup: "" })
    assert.deepEqual([auto.warm, auto.auto, auto.setup], [null, true, null])
    await assert.rejects(call("worktree config", { repo: "lib", warm: "many" }), (err) => err.code === "USAGE")
    await assert.rejects(call("worktree config", { warm: "2" }), (err) => err.code === "USAGE")
    const overview = await call("worktree config")
    assert.deepEqual(overview.repos.map((r) => r.label), ["lib"])
    assert.equal(overview.settings.worktreePoolMax, 3)
    assert.equal(overview.root, service.root())
    const preview = await call("worktree cleanup")
    assert.deepEqual([preview.applied, preview.released, preview.removed], [false, [], []])
    await settled(service)
    assert.equal((await call("worktree config", { repo: "lib", forget: true })).removed, 2)
    service.stop()
  })
})

function readdirOnly(dir) {
  const entries = execFileSync("ls", [dir], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
  assert.equal(entries.length, 1, `expected one folder in ${dir}, got ${entries}`)
  return entries[0]
}
