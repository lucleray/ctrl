// The `ctrl` CLI end to end: bin/ctrl + dist/cli/cli.cjs against a fake app socket, and the
// `session new` handler against a fake host. Run with `npm test`.
import * as esbuild from "esbuild"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { configs } from "../scripts/build.mjs"

const tmp = mkdtempSync(join(tmpdir(), "ctrl-test-"))
const launcher = "dist/cli/ctrl"
let createHandlers
let Store

before(async () => {
  const cli = configs.find((c) => c.outfile === "dist/cli/cli.cjs")
  await esbuild.build({ ...cli, logLevel: "warning" })
  const handlers = join(tmp, "cli-handlers.cjs")
  await esbuild.build({
    entryPoints: ["src/main/cli-handlers.ts"],
    outfile: handlers,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "warning",
  })
  ;({ createHandlers } = createRequire(import.meta.url)(handlers))
  const store = join(tmp, "store.cjs")
  await esbuild.build({ entryPoints: ["src/main/store.ts"], outfile: store, bundle: true, platform: "node", format: "cjs", logLevel: "warning" })
  ;({ Store } = createRequire(import.meta.url)(store))
})

after(() => rmSync(tmp, { recursive: true, force: true }))

/** A stand-in for the app's socket: `answer(req)` returns the reply, or undefined to never answer. */
async function fakeApp(answer) {
  const path = join(mkdtempSync(join(tmp, "sock-")), "ctrl.sock")
  const requests = []
  const server = createServer((sock) => {
    let buf = ""
    sock.setEncoding("utf8")
    sock.on("error", () => {})
    sock.on("data", (chunk) => {
      buf += chunk
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      const req = JSON.parse(buf.slice(0, nl))
      requests.push(req)
      const reply = answer(req)
      if (reply) sock.end(JSON.stringify(reply) + "\n")
    })
  })
  await new Promise((r) => server.listen(path, r))
  return { path, requests, close: () => new Promise((r) => server.close(r)) }
}

/**
 * A `node` first in PATH that behaves like the endpoint security tools that broke long prompts: it
 * SIGKILLs itself when any argument is over 1 KB, before running anything.
 */
function strictNode() {
  const dir = mkdtempSync(join(tmp, "bin-"))
  writeFileSync(
    join(dir, "node"),
    `#!/bin/sh
for a in "$@"; do
  if [ \${#a} -gt 1000 ]; then kill -9 $$; fi
done
exec ${JSON.stringify(process.execPath)} "$@"
`,
  )
  chmodSync(join(dir, "node"), 0o755)
  return { dir }
}

function run(args, { socket, path, stdin } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const env = { ...process.env, PATH: path ? `${path}:${process.env.PATH}` : process.env.PATH }
    if (socket) env.CTRL_SOCKET = socket
    delete env.CTRL_ARGC
    const child = spawn(launcher, args, { env })
    let stdout = ""
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d))
    child.stdin.end(stdin ?? "")
    child.on("close", (code, signal) => {
      let json
      try {
        json = JSON.parse(stdout)
      } catch {}
      resolve({ code, signal, stdout, json, ms: Date.now() - started })
    })
  })
}

const bigPrompt = [
  "# Review `cli.ts` <carefully>",
  "",
  "- quotes \"double\" and 'single', $HOME, $(whoami), `backticks`, a < b > c, \\ backslash",
  "-",
  "--space none",
  "```ts",
  "function f<T extends { a: number }>(v: T): T { return v }",
  "```",
  ...Array.from({ length: 2000 }, (_, i) => `- line ${i}: lorem ipsum <tag> \`code\` & more`),
].join("\n")

describe("ctrl launcher", () => {
  test("a CLI killed before it answers still replies in JSON, and points long values to stdin", async () => {
    const app = await fakeApp(() => ({ ok: true, data: { id: "ses_new" } }))
    const node = strictNode()
    const res = await run(["session", "new", "--space", "self", "--prompt", bigPrompt], { socket: app.path, path: node.dir })
    await app.close()
    assert.equal(res.code, 1, res.stdout)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error.code, "INTERNAL")
    assert.match(res.json.error.message, /killed \(signal 9\)/)
    assert.match(res.json.error.hint, /--prompt - < prompt.md/)
    assert.equal(app.requests.length, 0)
  })

  test("a killed CLI with short arguments gets a generic hint", async () => {
    const dir = mkdtempSync(join(tmp, "bin-"))
    writeFileSync(join(dir, "node"), "#!/bin/sh\nkill -TERM $$\n")
    chmodSync(join(dir, "node"), 0o755)
    const res = await run(["app", "status"], { path: dir })
    assert.equal(res.code, 1, res.stdout)
    assert.match(res.json.error.message, /signal 15/)
    assert.doesNotMatch(res.json.error.hint, /stdin/)
  })

  test("--prompt - gets long text with special characters through intact, even where long arguments get killed", async () => {
    const app = await fakeApp(() => ({ ok: true, data: { id: "ses_new" } }))
    const node = strictNode()
    const res = await run(["session", "new", "--space", "self", "--title", "t", "--prompt", "-"], {
      socket: app.path,
      path: node.dir,
      stdin: bigPrompt + "\n",
    })
    await app.close()
    assert.equal(res.code, 0, res.stdout)
    assert.deepEqual(res.json, { ok: true, data: { id: "ses_new" } })
    assert.deepEqual(app.requests[0].args, { space: "self", title: "t", prompt: bigPrompt })
  })

  test("CLI errors keep their own exit code", async () => {
    const res = await run(["session", "nope"])
    assert.equal(res.code, 2)
    assert.equal(res.json.error.code, "USAGE")
  })

  test("empty and repeated arguments keep their order", async () => {
    const app = await fakeApp(() => ({ ok: true, data: {} }))
    const res = await run(["session", "list", "--status", "running", "--status", "failed", "--space", "self"], { socket: app.path })
    await app.close()
    assert.equal(res.code, 0, res.stdout)
    assert.deepEqual(app.requests[0].args.status, ["running", "failed"])
    const help = await run([])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /^ctrl /)
  })

  test("an app that never answers gives a TIMEOUT reply, not a silent wait", async () => {
    const app = await fakeApp(() => undefined)
    const res = await run(["session", "new", "--prompt", "hi", "--timeout", "500"], { socket: app.path })
    await app.close()
    assert.equal(res.code, 7, res.stdout)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error.code, "TIMEOUT")
    assert.match(res.json.error.hint, /may still have done it/)
    assert.ok(res.ms < 5000, `took ${res.ms}ms`)
  })

  test("help documents `self` for every --space", async () => {
    const res = await run(["help", "--json"])
    const spaceArgs = res.json.data.commands.flatMap((c) =>
      c.args.filter((a) => a.name === "space" && !c.name.startsWith("space delete")).map((a) => [c.name, a.description]),
    )
    assert.ok(spaceArgs.length > 5)
    for (const [name, description] of spaceArgs) assert.match(description, /`self`/, `${name} --space`)
  })
})

// ---------- session new, against a fake host ----------

const never = () => new Promise(() => {})

function fakeHost(overrides = {}) {
  const sessions = []
  const listeners = new Set()
  const data = {
    assignments: { ses_me: "spc_mine" },
    archived: {},
    createdByAgent: {},
    parents: {},
    spaces: [{ id: "spc_mine", name: "Mine" }],
    settings: { defaultHarness: "opencode" },
  }
  const changed = () => listeners.forEach((cb) => cb())
  const host = {
    calls: [],
    store: {
      data,
      space: (id) => data.spaces.find((s) => s.id === id),
      setCreatedByAgent: () => {},
      isAncestor: (ancestor, id) => {
        for (let cur = id; cur; cur = data.parents[cur]) if (cur === ancestor) return true
        return false
      },
      setParent: (id, parent) => {
        if (parent) data.parents[id] = parent
        else delete data.parents[id]
        return true
      },
    },
    sessions: () => sessions,
    currentSessionID: () => null,
    termSession: () => undefined,
    isLive: () => false,
    window: () => ({}),
    changed,
    onChange: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    newSession: async (opts) => {
      host.calls.push(["newSession", opts])
      const id = "ses_new"
      if (opts.spaceID) data.assignments[id] = opts.spaceID
      if (opts.parentID) data.parents[id] = opts.parentID
      sessions.push({ id, harness: "opencode", title: "", directory: "/", status: "idle", updated: 1 })
      return { id }
    },
    move: (id, spaceID) => {
      host.calls.push(["move", id, spaceID])
      if (spaceID) data.assignments[id] = spaceID
      else delete data.assignments[id]
      return []
    },
    renameSession: async (id, title) => void (sessions.find((s) => s.id === id).title = title),
    prompt: async (id) => {
      const s = sessions.find((x) => x.id === id)
      s.status = "running"
      s.updated = 2
      changed()
    },
    ...overrides,
  }
  return host
}

const req = (args, caller = { opencodeSessionID: "ses_me" }) => [args, { v: 1, command: "session new", args, caller }, {}]

describe("session new handler", () => {
  test("--space self starts the session in the caller's space", async () => {
    const host = fakeHost()
    const handlers = createHandlers(host)
    const out = await handlers["session new"](...req({ space: "self", title: "t", prompt: "go" }))
    assert.equal(host.calls[0][1].spaceID, "spc_mine")
    assert.equal(out.spaceID, "spc_mine")
    assert.equal(out.status, "running")
  })

  test("a harness that never creates the session times out within the budget", async () => {
    const handlers = createHandlers(fakeHost({ newSession: never }), { sessionNewBudget: 300 })
    const started = Date.now()
    await assert.rejects(handlers["session new"](...req({ prompt: "go" })), (err) => {
      assert.equal(err.code, "TIMEOUT")
      assert.match(err.extra.hint, /ctrl app status/)
      return true
    })
    assert.ok(Date.now() - started < 2000)
  })

  test("a prompt that never goes through times out and names the created session", async () => {
    const handlers = createHandlers(fakeHost({ prompt: never }), { sessionNewBudget: 300 })
    await assert.rejects(handlers["session new"](...req({ space: "self", prompt: "go" })), (err) => {
      assert.equal(err.code, "TIMEOUT")
      assert.match(err.extra.hint, /ses_new was created/)
      assert.match(err.extra.hint, /ctrl session send ses_new --text -/)
      return true
    })
  })

  test("a rename that never finishes times out too", async () => {
    const handlers = createHandlers(fakeHost({ renameSession: never }), { sessionNewBudget: 300 })
    await assert.rejects(handlers["session new"](...req({ title: "t" })), { code: "TIMEOUT" })
  })
})

describe("child sessions", () => {
  const me = { id: "ses_me", harness: "fx", title: "me", directory: "/me", status: "idle", updated: 1 }

  test("session new from a session starts a child in its space, folder and harness", async () => {
    const host = fakeHost()
    host.sessions().push({ ...me })
    const out = await createHandlers(host)["session new"](...req({ title: "t" }))
    const opts = host.calls[0][1]
    assert.equal(opts.parentID, "ses_me")
    assert.equal(opts.spaceID, "spc_mine")
    assert.equal(opts.directory, "/me")
    assert.equal(opts.harness, "fx")
    assert.equal(out.parentID, "ses_me")
  })

  test("--parent none starts a top-level session in no space", async () => {
    const host = fakeHost()
    host.sessions().push({ ...me })
    const out = await createHandlers(host)["session new"](...req({ parent: "none" }))
    assert.equal(host.calls[0][1].parentID, null)
    assert.equal(host.calls[0][1].spaceID, null)
    assert.equal(out.parentID, null)
  })

  test("--space keeps the parent but uses the space's settings", async () => {
    const host = fakeHost()
    host.sessions().push({ ...me })
    host.store.data.spaces.push({ id: "spc_other", name: "Other" })
    await createHandlers(host)["session new"](...req({ space: "spc_other" }))
    const opts = host.calls[0][1]
    assert.equal(opts.parentID, "ses_me")
    assert.equal(opts.spaceID, "spc_other")
    assert.equal(opts.directory, undefined)
  })

  test("session move --parent nests it, joins the parent's space, and refuses cycles", async () => {
    const host = fakeHost()
    host.sessions().push({ ...me }, { ...me, id: "ses_kid", title: "kid" })
    const handlers = createHandlers(host)
    const move = (args) => handlers["session move"](args, { v: 1, command: "session move", args, caller: {} }, {})
    const out = await move({ session: "ses_kid", parent: "ses_me" })
    assert.equal(out.parentID, "ses_me")
    assert.equal(out.spaceID, "spc_mine")
    assert.equal(out.changed, true)
    assert.deepEqual(handlers["session get"]({ session: "ses_me" }, { caller: {} }).children, ["ses_kid"])
    await assert.rejects(async () => move({ session: "ses_me", parent: "ses_kid" }), { code: "CONFLICT" })
    await assert.rejects(async () => move({ session: "ses_me" }), { code: "USAGE" })
    const detached = await move({ session: "ses_kid", parent: "none" })
    assert.equal(detached.parentID, null)
    assert.equal(detached.spaceID, "spc_mine")
  })

  test("moving a session takes the children in its space along, not the ones filed elsewhere", () => {
    const store = new Store(join(mkdtempSync(join(tmp, "store-")), "state.json"))
    const a = store.createSpace("A")
    const b = store.createSpace("B")
    const c = store.createSpace("C")
    for (const id of ["ses_root", "ses_kid", "ses_grandkid", "ses_other"]) store.assign(id, a)
    store.assign("ses_away", c)
    store.assign("ses_away_kid", c)
    store.setParent("ses_kid", "ses_root")
    store.setParent("ses_grandkid", "ses_kid")
    store.setParent("ses_away", "ses_root")
    store.setParent("ses_away_kid", "ses_away")
    assert.deepEqual(store.assignTree("ses_root", b), ["ses_kid", "ses_grandkid"])
    const where = (id) => store.data.assignments[id] ?? null
    assert.deepEqual(["ses_root", "ses_kid", "ses_grandkid"].map(where), [b, b, b])
    assert.equal(where("ses_other"), a)
    assert.deepEqual(["ses_away", "ses_away_kid"].map(where), [c, c])
    assert.deepEqual(store.assignTree("ses_kid", null), ["ses_grandkid"])
    assert.deepEqual(["ses_kid", "ses_grandkid"].map(where), [null, null])
  })
})
