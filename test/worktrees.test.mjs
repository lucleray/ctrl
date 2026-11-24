// Worktrees, the fast part: pool sizing (src/shared/worktrees.ts) and the `ctrl worktree` handlers over a
// fake pool. The pool itself runs real git, so its tests are in test/slow (npm run test:slow).
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-worktrees-test-")
let createHandlers, poolTarget, simulateMisses, MINUTE, DAY, TrashEmptier, DELETER, deleterAlive, runSetup

before(async () => {
  ;[{ createHandlers }, { poolTarget, simulateMisses, MINUTE, DAY }, { TrashEmptier, DELETER, deleterAlive }, { runSetup }] = await load(
    tmp,
    "src/main/cli-handlers.ts",
    "src/shared/worktrees.ts",
    "src/main/worktrees/trash.ts",
    "src/main/worktrees/git.ts",
  )
})

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

/** What the pool throws for "no such repo", "unsaved work"… (WorktreeError in src/main/worktrees/service.ts). */
const poolError = (code, message, extra = {}) => Object.assign(new Error(message), { name: "WorktreeError", code, extra })

const repoView = (label, extra = {}) => ({ source: `/src/${label}`, label, baseBranch: "main", setup: "npm ci", warm: null, target: 1, auto: true, ...extra })

/** The pool as the handlers see it, in memory: worktrees are plain records, nothing touches git. */
function fakePool() {
  const worktrees = []
  const calls = []
  const pool = {
    worktrees,
    calls,
    up: async (repo, sessionID, opts) => {
      calls.push(["up", repo, sessionID, opts.skipSetup])
      const id = `w${worktrees.length + 1}`
      const wt = { id, repo: `/src/${repo}`, path: `/wt/${repo}/${id}`, status: "attached", sessionID, baseCommit: "abc123", warmedAt: Date.now(), attachedAt: Date.now(), since: 1 }
      worktrees.push(wt)
      return { worktree: wt, cold: worktrees.length === 1 }
    },
    all: () => worktrees,
    ofSession: (id) => worktrees.filter((w) => w.sessionID === id),
    name: (w) => w.repo.split("/").pop(),
    delivered: (wts) => calls.push(["delivered", wts.map((w) => w.id)]),
    settingUp: (w) => !!w.settingUp,
    setup: async (wt) => {
      calls.push(["setup", wt.id])
      if (wt.failing) return { worktree: { ...wt, setupFailed: true }, ran: true, detail: "ERR_PNPM_X\nlockfile is out of date" }
      delete wt.setupSkipped
      return { worktree: wt, ran: true }
    },
    describe: async (w) => ({ ...w, name: pool.name(w), branch: w.branch ?? null, commit: "abc1234" }),
    find: (selector, cwd) => {
      const wt = worktrees.find((w) => w.id === selector || w.path === (selector ?? cwd))
      if (!wt) throw poolError("NOT_FOUND", `No worktree ${selector ?? cwd}`, { hint: "ctrl worktree list --all shows ids and paths" })
      return wt
    },
    down: async (wt, { force }) => {
      if (wt.dirty && !force) throw poolError("CONFLICT", `Worktree ${wt.id} has 1 uncommitted file (x.txt)`, { hint: "Commit and push first, or pass --force" })
      worktrees.splice(worktrees.indexOf(wt), 1)
      return { branch: wt.branch ?? null, forced: !!force && !!wt.dirty, rescueRef: null }
    },
    view: () => ({ root: "/wt", repos: [repoView("app")], jobs: { pool: { at: 1, summary: "1 warm" }, cleanup: { at: null, summary: null }, update: { at: null, summary: null } } }),
    repo: async (token) => {
      if (token !== "app") throw poolError("NOT_FOUND", `No repo called "${token}"`, { candidates: ["app"] })
      return repoView("app")
    },
    configure: async (token, patch) => (calls.push(["configure", token, patch]), { repo: repoView(token, patch), changed: true }),
    forget: async (token) => (calls.push(["forget", token]), { source: `/src/${token}`, removed: 1 }),
    prewarm: async (token, count) => (calls.push(["prewarm", token, count]), repoView(token)),
    cleanup: async ({ apply }) => (calls.push(["cleanup", apply]), { released: [], dropped: [], removed: ["/wt/app/stray"] }),
    update: async () => "1 already up to date",
  }
  return pool
}

function setup() {
  const pool = fakePool()
  const data = { assignments: {}, archived: {}, createdByAgent: {}, parents: {}, spaces: [], settings: { worktreeRoot: null, worktreePoolAuto: true, worktreeCleanup: true, worktreeUpdateRepos: false } }
  const sessions = ["ses_a", "ses_b"].map((id) => ({ id, harness: "opencode", title: id, directory: "/", status: "idle", updated: 1 }))
  const host = {
    store: { data },
    sessions: () => sessions,
    currentSessionID: () => null,
    termSession: () => undefined,
    isLive: () => false,
    worktrees: pool,
    // ses_sub is a subagent of ses_a: ctrl doesn't list it.
    rootSession: async (id) => (id === "ses_sub" ? "ses_a" : null),
  }
  const handlers = createHandlers(host)
  const run = (command, args = {}, caller = { opencodeSessionID: "ses_a" }, closed = new Promise(() => {})) =>
    handlers[command](args, { v: 1, command, args, caller }, { emit: () => {}, closed })
  return { pool, data, run }
}

const fails = (promise, code, hint) =>
  assert.rejects(promise, (err) => (assert.equal(err.code, code, err.message), hint && assert.match(err.extra.hint, hint), true))

describe("worktree handlers", () => {
  test("up takes a worktree for the calling session, and a subagent's goes to the session it works for", async () => {
    const { pool, data, run } = setup()
    const first = await run("worktree up", { repo: "app", "skip-setup": true })
    assert.deepEqual([first.sessionID, first.repo, first.path, first.cold, first.branch, first.baseBranch], ["ses_a", "app", "/wt/app/w1", true, null, "main"])
    assert.match(first.hint, /Detached at main as of just now: create a branch before committing/)
    assert.match(first.hint, /Work in \/wt\/app\/w1/)
    assert.deepEqual(pool.calls[0], ["up", "app", "ses_a", true])

    const second = await run("worktree up", { repo: "app" }, { opencodeSessionID: "ses_sub" })
    assert.equal(second.sessionID, "ses_a")
    assert.match(second.hint, /also holds 1 other worktree of app \(w1\)/)

    assert.equal((await run("worktree up", { repo: "app", session: "ses_b" }, {})).sessionID, "ses_b")
    await fails(run("worktree up", { repo: "app" }, {}), "NO_SELF", /--session/)
    await fails(run("worktree up", { repo: "app" }, { opencodeSessionID: "ses_gone" }), "NOT_FOUND")
    data.archived.ses_b = 1
    await fails(run("worktree up", { repo: "app", session: "ses_b" }), "CONFLICT", /session unarchive ses_b/)

    const session = await run("session get", { session: "ses_a" })
    assert.deepEqual(session.worktrees, [
      { id: "w1", repo: "app", path: "/wt/app/w1" },
      { id: "w2", repo: "app", path: "/wt/app/w2" },
    ])
  })

  test("up gives up after its timeout or when the caller leaves, and tells the pool nobody is waiting", async () => {
    const { pool, run } = setup()
    let alive
    pool.up = (_repo, _session, opts) => ((alive = opts.alive), new Promise(() => {}))
    await fails(run("worktree up", { repo: "app", timeout: 5 }), "TIMEOUT", /run the same command again/)
    assert.equal(alive(), false)

    let left, building, started
    const closed = new Promise((r) => (left = r))
    const asked = new Promise((r) => (started = r))
    pool.up = (_repo, _session, opts) => ((alive = opts.alive), started(), new Promise((r) => (building = r)))
    const call = run("worktree up", { repo: "app", timeout: 2000 }, { opencodeSessionID: "ses_a" }, closed)
    await asked
    assert.equal(alive(), true)
    left()
    await closed
    assert.equal(alive(), false)
    building({ worktree: { id: "w1", repo: "/src/app", path: "/wt/app/w1", status: "attached", sessionID: "ses_a" }, cold: true })
    await call
  })

  test("up with --skip-setup says what's missing, and its TIMEOUT suggests --skip-setup otherwise", async () => {
    const { pool, run } = setup()
    pool.up = async (repo, sessionID) => {
      const wt = { id: "w1", repo: `/src/${repo}`, path: `/wt/${repo}/w1`, status: "attached", sessionID, baseCommit: "abc", warmedAt: Date.now(), attachedAt: Date.now(), since: 1, setupSkipped: true }
      pool.worktrees.push(wt)
      return { worktree: wt, cold: true }
    }
    const up = await run("worktree up", { repo: "app", "skip-setup": true })
    assert.equal(up.setupSkipped, true)
    assert.match(up.hint, /Dependencies aren't installed \(--skip-setup\).*run ctrl worktree setup w1/)
    pool.up = () => new Promise(() => {})
    await fails(run("worktree up", { repo: "app", timeout: 5 }), "TIMEOUT", /Add --skip-setup/)
    await assert.rejects(run("worktree up", { repo: "app", timeout: 5, "skip-setup": true }), (err) => err.code === "TIMEOUT" && !/Add --skip-setup/.test(err.extra.hint))
  })

  test("setup installs in the worktree you name or are in, says when it failed, and times out like up", async () => {
    const { pool, run } = setup()
    const a = await run("worktree up", { repo: "app" })
    pool.worktrees[0].setupSkipped = true
    const done = await run("worktree setup", { worktree: a.id })
    assert.deepEqual([done.ran, done.setupSkipped, done.id], [true, undefined, "w1"])
    assert.match(done.hint, /Set up \(npm ci\): dependencies are installed/)
    pool.worktrees[0].failing = true
    const failed = await run("worktree setup", {}, { opencodeSessionID: "ses_a", cwd: a.path })
    assert.equal(failed.setupFailed, true)
    assert.match(failed.hint, /failed \(npm ci\): ERR_PNPM_X \| lockfile is out of date/)
    pool.setup = () => new Promise(() => {})
    await fails(run("worktree setup", { worktree: a.id, timeout: 5 }), "TIMEOUT", /run the same command again/)
    await fails(run("worktree setup", { worktree: "nope" }), "NOT_FOUND")
  })

  test("list shows the session's worktrees by default, everything with --all or outside a session", async () => {
    const { pool, run } = setup()
    await run("worktree up", { repo: "app" })
    await run("worktree up", { repo: "app", session: "ses_b" })
    pool.worktrees.push({ id: "warm", repo: "/src/app", path: "/wt/app/warm", status: "ready", sessionID: null })

    const mine = await run("worktree list")
    assert.deepEqual([mine.scope, mine.items.map((w) => w.id), mine.total], ["session", ["w1"], 1])
    // The session's own list delivers them (they're never reclaimed); --all or --session doesn't.
    assert.deepEqual(pool.calls.filter((c) => c[0] === "delivered"), [["delivered", ["w1"]]])
    const all = await run("worktree list", { all: true })
    assert.deepEqual([all.scope, all.items.map((w) => w.status)], ["all", ["attached", "attached", "ready"]])
    assert.equal((await run("worktree list", {}, {})).scope, "all")
    assert.deepEqual((await run("worktree list", { session: "ses_b" }, {})).items.map((w) => w.id), ["w2"])
    assert.deepEqual((await run("worktree list", { all: true, status: ["ready"], repo: "app" })).items.map((w) => w.id), ["warm"])
    await fails(run("worktree list", { repo: "nope" }), "NOT_FOUND")
  })

  test("down releases by id, path or the folder you're in, and passes the pool's refusal on with its hint", async () => {
    const { pool, run } = setup()
    const a = await run("worktree up", { repo: "app" })
    const b = await run("worktree up", { repo: "app" })
    pool.worktrees[0].dirty = true
    pool.worktrees[0].branch = "feature"
    await fails(run("worktree down", {}, { cwd: a.path }), "CONFLICT", /--force/)
    assert.deepEqual(await run("worktree down", { force: true }, { cwd: a.path }), {
      id: a.id,
      repo: "app",
      path: a.path,
      released: true,
      branch: "feature",
      forced: true,
      rescueRef: null,
    })
    assert.equal((await run("worktree down", { worktree: b.id })).forced, false)
    await fails(run("worktree down", { worktree: "nope" }), "NOT_FOUND", /worktree list --all/)
  })

  test("config shows everything, adds or changes a repo, and forgets one", async () => {
    const { pool, run } = setup()
    const overview = await run("worktree config")
    assert.deepEqual(Object.keys(overview), ["root", "settings", "jobs", "repos"])
    assert.deepEqual(overview.settings, { worktreeRoot: null, worktreePoolAuto: true, worktreeCleanup: true, worktreeUpdateRepos: false })
    assert.deepEqual(overview.repos.map((r) => r.label), ["app"])

    const changed = await run("worktree config", { repo: "app", name: "", base: "dev", setup: "", warm: "3", "max-total": 10 })
    assert.deepEqual(pool.calls.at(-1), ["configure", "app", { name: null, baseBranch: "dev", setup: null, warm: 3, maxTotal: 10 }])
    assert.equal(changed.changed, true)
    await run("worktree config", { repo: "app", warm: "auto" })
    assert.deepEqual(pool.calls.at(-1), ["configure", "app", { warm: null }])
    await run("worktree config", { repo: "/src/new" })
    assert.deepEqual(pool.calls.at(-1), ["configure", "/src/new", {}])

    await fails(run("worktree config", { repo: "app", warm: "many" }), "USAGE")
    await fails(run("worktree config", { warm: "2" }), "USAGE")
    await fails(run("worktree config", { repo: "app", forget: true, warm: "2" }), "USAGE")
    assert.deepEqual(await run("worktree config", { repo: "app", forget: true }), { source: "/src/app", removed: 1, changed: true })
  })

  test("prewarm, cleanup and update run the pool's jobs", async () => {
    const { pool, run } = setup()
    assert.equal((await run("worktree prewarm", { repo: "app", count: 2 })).label, "app")
    assert.deepEqual(pool.calls.at(-1), ["prewarm", "app", 2])
    assert.deepEqual(await run("worktree cleanup"), { released: [], dropped: [], removed: ["/wt/app/stray"], applied: false })
    assert.equal((await run("worktree cleanup", { apply: true })).applied, true)
    assert.deepEqual(pool.calls.at(-1), ["cleanup", true])
    assert.deepEqual(await run("worktree update"), { summary: "1 already up to date", repos: [] })
  })
})

describe("trash", () => {
  let n = 0
  const trashDir = (...entries) => {
    const dir = join(tmp, `trash-${n++}`)
    for (const e of entries) mkdirSync(join(dir, e), { recursive: true })
    return dir
  }
  /** rm calls recorded instead of run: each a child that exits when the test says so. */
  const fakeRm = () => {
    const calls = []
    const spawnRm = (paths) => {
      const child = Object.assign(new EventEmitter(), { pid: 90_000 + calls.length, unref() {} })
      calls.push({ names: paths.map((p) => p.split("/").pop()), child })
      return child
    }
    return { calls, spawnRm }
  }

  test("one rm per folder at a time, the next one for what was trashed meanwhile", () => {
    const dir = trashDir("a", "b")
    const { calls, spawnRm } = fakeRm()
    const trasher = new TrashEmptier(spawnRm)
    trasher.empty(dir)
    trasher.empty(dir)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].names.sort(), ["a", "b"])
    assert.equal(readFileSync(join(dir, DELETER), "utf8"), String(calls[0].child.pid))
    mkdirSync(join(dir, "c"))
    trasher.empty(dir)
    assert.equal(calls.length, 1)
    // "b" failed to delete: the next rm takes only the new folder, not the one that just failed.
    rmDir(join(dir, "a"))
    calls[0].child.emit("exit", 1)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].names, ["c"])
    rmDir(join(dir, "c"))
    calls[1].child.emit("exit", 0)
    // Then "b" gets one more try, and nothing spins after that.
    assert.equal(calls.length, 3)
    assert.deepEqual(calls[2].names, ["b"])
    calls[2].child.emit("exit", 1)
    assert.equal(calls.length, 3)
    assert.equal(trasher.busy(dir), false)
    assert.equal(existsSync(join(dir, DELETER)), false)
  })

  test("a marker holds back only a live rm, never a dead or reused pid, nor an old one", () => {
    const dir = trashDir("a")
    const marker = join(dir, DELETER)
    writeFileSync(marker, "2147483646")
    assert.equal(deleterAlive(dir), false)
    // This test's own pid is alive but isn't an rm.
    writeFileSync(marker, String(process.pid))
    assert.equal(deleterAlive(dir), false)
    writeFileSync(marker, "garbage")
    assert.equal(deleterAlive(dir), false)
    const { calls, spawnRm } = fakeRm()
    new TrashEmptier(spawnRm).empty(dir)
    assert.equal(calls.length, 1)
    const old = Date.now() / 1000 - 7 * 3600
    utimesSync(marker, old, old)
    assert.equal(deleterAlive(dir), false)
  })

  test("an empty folder clears its marker and starts nothing", () => {
    const dir = trashDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, DELETER), "2147483646")
    const { calls, spawnRm } = fakeRm()
    new TrashEmptier(spawnRm).empty(dir)
    assert.equal(calls.length, 0)
    assert.equal(existsSync(join(dir, DELETER)), false)
  })
})

describe("setup command", () => {
  test("a timeout says so instead of showing the output's tail as the error", async () => {
    const res = await runSetup("echo installing; sleep 5", tmp, 100)
    assert.equal(res.ok, false)
    assert.match(res.detail, /^Timed out after 0s, killed\. Last output:\ninstalling$/)
  })
})

const rmDir = (path) => rmSync(path, { recursive: true, force: true })
