// The `ctrl` command handlers (src/main/cli-handlers.ts) against a real Store and a fake host: spaces,
// session lookup and listing, settings. No app, no harness. Run with `npm test`.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-handlers-test-")
let createHandlers, Store, COMMANDS, referenceMarkdown

before(async () => {
  ;[{ createHandlers }, { Store }, { COMMANDS }, { referenceMarkdown }] = await load(
    tmp,
    "src/main/cli-handlers.ts",
    "src/main/store.ts",
    "src/shared/cli/commands.ts",
    "src/shared/cli/docs.ts",
  )
})

const session = (id, extra = {}) => ({ id, harness: "opencode", title: id, directory: "/w", status: "idle", updated: 1, ...extra })

/** Handlers over a real Store; `run(command, args, caller)` calls one like the CLI server would. */
function setup({ sessions = [], current = null } = {}) {
  const store = new Store(join(mkdtempSync(join(tmp, "state-")), "state.json"))
  const listeners = new Set()
  const calls = []
  const host = {
    store,
    sessions: () => sessions,
    currentSessionID: () => current,
    termSession: () => undefined,
    isLive: () => false,
    changed: () => listeners.forEach((cb) => cb()),
    onChange: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    createSpace: (name) => store.createSpace(name),
    deleteSpace: (id) => store.deleteSpace(id),
    move: (id, spaceID) => store.assignTree(id, spaceID),
    archive: (ids) => (calls.push(["archive", ids]), store.setArchived(ids, true)),
    unarchive: (ids) => store.setArchived(ids, false),
    renameSession: async (id, title) => void (sessions.find((s) => s.id === id).title = title),
    setSettings: (patch) => store.setSettings(patch),
    adapters: () => [
      { id: "github", mode: store.data.settings.adapterModes.github ?? "live", cli: { command: "gh" } },
      { id: "notion", mode: store.data.settings.adapterModes.notion ?? "links" },
    ],
    themes: () => ({ builtin: ["opencode", "tokyonight"], custom: [] }),
    toast: (message, view) => (calls.push(["toast", message, view]), "t1"),
  }
  const handlers = createHandlers(host)
  const run = (command, args = {}, caller = {}) => handlers[command](args, { v: 1, command, args, caller }, {})
  return { store, host, handlers, run, calls, sessions }
}

const fails = (fn, code) => assert.throws(fn, (err) => (assert.equal(err.code, code, err.message), true))

test("every command has a handler, and every handler a command", () => {
  const { handlers } = setup()
  const remote = COMMANDS.filter((c) => !c.local).map((c) => c.name)
  assert.deepEqual(remote.filter((n) => !handlers[n]), [], "commands without a handler")
  assert.deepEqual(Object.keys(handlers).filter((n) => !remote.includes(n)), [], "handlers without a command")
})

test("docs/CLI-REFERENCE.md is up to date", () => {
  assert.ok(referenceMarkdown() === readFileSync("docs/CLI-REFERENCE.md", "utf8"), "run `npm run cli-docs` and commit the result")
})

describe("spaces", () => {
  test("create, rename, set, fold, move: each says whether it changed anything", () => {
    const { run, store } = setup()
    const a = run("space create", { name: " Alpha ", directory: tmp, harness: "fx", "ctrl-instructions": "off" })
    assert.equal(a.name, "Alpha")
    assert.equal(a.directory, tmp)
    assert.equal(a.harness, "fx")
    assert.equal(a.ctrlInstructions, false)
    const b = run("space create", { name: "Beta", index: 1 })
    assert.deepEqual(store.data.spaces.map((s) => s.id), [a.id, b.id])

    assert.equal(run("space rename", { space: a.id, name: "Alpha" }).changed, false)
    assert.equal(run("space rename", { space: "name:alpha", name: "A" }).changed, true)
    assert.equal(run("space set", { space: a.id, harness: "default", model: "vercel/claude#high" }).model, "vercel/claude#high")
    assert.equal(store.space(a.id).harness, undefined)
    fails(() => run("space set", { space: a.id }), "USAGE")
    fails(() => run("space set", { space: a.id, model: "nope" }), "USAGE")
    fails(() => run("space set", { space: a.id, directory: join(tmp, "missing") }), "NOT_FOUND")

    assert.equal(run("space fold", { space: a.id }).changed, true)
    assert.equal(run("space fold", { space: a.id }).collapsed, true)
    assert.equal(run("space fold", { space: a.id }).changed, false)
    assert.equal(run("space unfold", { space: a.id }).changed, true)
    assert.equal(run("space move", { space: a.id, index: 5 }).changed, true)
    assert.deepEqual(run("space list").items.map((s) => s.name), ["Beta", "A"])
    fails(() => run("space create", { name: "  " }), "USAGE")
  })

  test("lookup: ids, name:, self, current; ambiguous names list candidates", () => {
    const { run, store } = setup({ sessions: [session("ses_me")], current: "ses_me" })
    const a = run("space create", { name: "Dup" }).id
    run("space create", { name: "dup" })
    store.assign("ses_me", a)
    assert.equal(run("space get", { space: "self" }, { opencodeSessionID: "ses_me" }).id, a)
    assert.equal(run("space get", { space: "current" }).id, a)
    assert.throws(() => run("space get", { space: "name:dup" }), (err) => err.code === "AMBIGUOUS" && err.extra.candidates.length === 2)
    assert.throws(() => run("space get", { space: "Dup" }), (err) => err.code === "NOT_FOUND" && /name:Dup/.test(err.extra.hint))
    fails(() => run("space get", { space: "self" }), "NO_SELF")
    assert.deepEqual(run("space get", { space: a, sessions: true }).items.map((s) => s.id), ["ses_me"])
  })

  test("delete returns an undo that recreates the space with its settings and sessions", () => {
    const { run, store } = setup({ sessions: [session("ses_1"), session("ses_2")] })
    const id = run("space create", { name: "Old one", instructions: "it's fine", "model-enabled": false }).id
    store.assign("ses_1", id)
    store.assign("ses_2", id)
    store.setArchived(["ses_2"], true)
    const { undo } = run("space delete", { id })
    assert.equal(store.space(id), undefined)
    assert.equal(
      undo,
      "ctrl space create 'Old one' --index 0 --no-model-enabled --instructions 'it'\\''s fine'" +
        " && ctrl session move ses_1 --space 'name:Old one' && ctrl session move ses_2 --space 'name:Old one'" +
        " && ctrl session archive ses_2",
    )
    fails(() => run("space delete", { id }), "NOT_FOUND")
  })

  test("archive-all takes sub-sessions filed elsewhere along", () => {
    const { run, store, calls } = setup({ sessions: [session("ses_1"), session("ses_kid")] })
    const id = run("space create", { name: "S" }).id
    store.assign("ses_1", id)
    store.setParent("ses_kid", "ses_1")
    assert.deepEqual(run("space archive-all", { space: id }), { archived: ["ses_1", "ses_kid"], undo: "ctrl session unarchive ses_1 ses_kid" })
    assert.deepEqual(run("space archive-all", { space: id }), { archived: [] })
    assert.equal(calls.length, 1)
  })
})

describe("sessions", () => {
  const list = [
    session("ses_a", { title: "Fix the build", status: "running", updated: 3 }),
    session("ses_b", { title: "Review PR", harness: "fx", directory: "/w/x/", updated: 2 }),
    session("ses_c", { title: "review pr", status: "failed", updated: 1 }),
  ]

  test("lookup by id, self, current and name:, with hints when it fails", () => {
    const { run } = setup({ sessions: list, current: "ses_a" })
    assert.equal(run("session get", { session: "self" }, { opencodeSessionID: "ses_b" }).id, "ses_b")
    assert.equal(run("session get", { session: "current" }).id, "ses_a")
    assert.equal(run("session get", { session: "name: fix the BUILD " }).id, "ses_a")
    assert.throws(() => run("session get", { session: "name:review pr" }), (err) => err.code === "AMBIGUOUS" && err.extra.candidates.length === 2)
    assert.throws(() => run("session get", { session: "ses_zzz" }), (err) => err.code === "NOT_FOUND" && /--all/.test(err.extra.hint))
    assert.throws(() => run("session get", { session: "zzz" }), (err) => /look like/.test(err.extra.hint))
    fails(() => run("session get", { session: 42 }), "USAGE")
    fails(() => setup({ sessions: list }).run("session get", { session: "current" }), "NOT_FOUND")
  })

  test("list filters: archived, space, status, harness, query, folder, parent", () => {
    const { run, store } = setup({ sessions: list })
    const ids = (args) => run("session list", args).items.map((s) => s.id)
    const space = run("space create", { name: "S" }).id
    store.assign("ses_a", space)
    store.setArchived(["ses_c"], true)
    store.setParent("ses_b", "ses_a")
    assert.deepEqual(ids({}), ["ses_a", "ses_b"])
    assert.deepEqual(ids({ all: true }), ["ses_a", "ses_b", "ses_c"])
    assert.deepEqual(ids({ archived: true }), ["ses_c"])
    assert.deepEqual(ids({ space }), ["ses_a"])
    assert.deepEqual(ids({ space: "none" }), ["ses_b"])
    assert.deepEqual(ids({ status: ["running"] }), ["ses_a"])
    assert.deepEqual(ids({ harness: "fx" }), ["ses_b"])
    assert.deepEqual(ids({ query: "REVIEW", all: true }), ["ses_b", "ses_c"])
    assert.deepEqual(ids({ directory: "/w/x" }), ["ses_b"])
    assert.deepEqual(ids({ parent: "ses_a" }), ["ses_b"])
  })

  test("list pages with a cursor", () => {
    const { run } = setup({ sessions: list })
    const first = run("session list", { all: true, limit: 2 })
    assert.deepEqual([first.items.length, first.next, first.total], [2, "c2", 3])
    const second = run("session list", { all: true, limit: 2, cursor: first.next })
    assert.deepEqual([second.items.map((s) => s.id), second.next], [["ses_c"], null])
    fails(() => run("session list", { cursor: "bogus" }), "USAGE")
  })

  test("rename trims, refuses empty titles, and says when nothing changed", async () => {
    const { run } = setup({ sessions: list.map((s) => ({ ...s })) })
    assert.equal((await run("session rename", { session: "ses_a", title: "  New  " })).title, "New")
    assert.equal((await run("session rename", { session: "ses_a", title: "New" })).changed, false)
    await assert.rejects(run("session rename", { session: "ses_a", title: " " }), { code: "USAGE" })
  })

  test("wait resolves on the next matching change, and times out otherwise", async () => {
    const sessions = [session("ses_a", { status: "running" })]
    const { run, host } = setup({ sessions })
    const done = run("session wait", { session: "ses_a", for: "done" })
    sessions[0].status = "unread"
    host.changed()
    assert.equal((await done).status, "unread")
    await assert.rejects(run("session wait", { session: "ses_a", for: "running", timeout: 20 }), { code: "TIMEOUT" })
  })

  test("refs escape titles for opencode and fx", () => {
    const { run } = setup({ sessions: [session("ses_a", { title: "A [b] (c)\nd" })] })
    assert.equal(run("session ref", { session: "ses_a" }).ref, "@session[A b c d](ses_a)")
    assert.equal(run("session ref", { session: "ses_a", for: "fx" }).ref, "session[A b c d](ses_a)")
  })

  test("toasts can link to a session", () => {
    const { run, calls } = setup({ sessions: list })
    assert.deepEqual(run("ui toast", { message: "hi", view: "name:Fix the build" }), { id: "t1" })
    assert.deepEqual(calls[0], ["toast", "hi", "ses_a"])
  })
})

describe("settings", () => {
  test("list covers every key with its default and current value", () => {
    const { run } = setup()
    const items = run("settings list").items
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]))
    assert.equal(byKey.fontSize.value, byKey.fontSize.default)
    assert.deepEqual(byKey.tuiTheme.values, ["opencode", "tokyonight"])
    assert.deepEqual(byKey["shortcuts.palette"].value, ["Cmd+P", "Cmd+K"])
    assert.equal(byKey["adapterModes.github"].value, "live")
    assert.ok(byKey["soundChoices.failed"])
  })

  test("set parses and validates each type", () => {
    const { run, store } = setup()
    const set = (key, value) => run("settings set", { key, value })
    assert.deepEqual(set("fontSize", "15"), { key: "fontSize", value: 15, changed: true })
    assert.equal(set("fontSize", 15).changed, false)
    fails(() => set("fontSize", "99"), "USAGE")
    fails(() => set("fontSize", "1.5"), "USAGE")
    fails(() => set("appearance", "purple"), "USAGE")
    assert.equal(set("sounds", "false").value, false)
    fails(() => set("sounds", "nope"), "USAGE")
    assert.equal(set("tuiTheme", "tokyonight").value, "tokyonight")
    fails(() => set("tuiTheme", "nope"), "USAGE")
    assert.equal(set("defaultModel", "vercel/claude#high").value, "vercel/claude#high")
    assert.deepEqual(store.data.settings.defaultModel, { providerID: "vercel", id: "claude", variant: "high" })
    assert.equal(set("defaultFxModel", "gpt#low").value, "gpt#low")
    assert.equal(set("soundChoices.failed", "Ping").value, "Ping")
    fails(() => set("soundChoices.failed", "Nope"), "USAGE")
    assert.deepEqual(set("shortcuts.palette", "Cmd+J").value, ["Cmd+J"])
    assert.equal(set("adapterModes.notion", "off").value, "off")
    fails(() => set("adapterModes.notion", "live"), "UNSUPPORTED_HARNESS")
    const space = run("space create", { name: "S" }).id
    assert.equal(set("defaultSpace", "name:S").value, space)
    assert.equal(set("defaultSpace", "none").value, null)
    assert.throws(() => set("fontsize", 12), (err) => err.code === "NOT_FOUND" && err.extra.candidates.includes("fontSize"))
  })

  test("reset goes back to the default", () => {
    const { run } = setup()
    run("settings set", { key: "fontSize", value: 20 })
    run("settings set", { key: "shortcuts.palette", value: ["Cmd+J"] })
    run("settings set", { key: "adapterModes.github", value: "off" })
    assert.equal(run("settings reset", { key: "fontSize" }).value, run("settings list").items.find((i) => i.key === "fontSize").default)
    assert.deepEqual(run("settings reset", { key: "shortcuts.palette" }).value, ["Cmd+P", "Cmd+K"])
    assert.equal(run("settings reset", { key: "adapterModes.github" }).value, "live")
    assert.equal(run("settings reset", { key: "fontSize" }).changed, false)
  })
})
