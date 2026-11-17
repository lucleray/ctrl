// The state file (src/main/store.ts): defaults, migrations from older state, spaces, assignments and the
// session tree. Run with `npm test`.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-store-test-")
let Store

before(async () => {
  ;[{ Store }] = await load(tmp, "src/main/store.ts")
})

const file = () => join(mkdtempSync(join(tmp, "state-")), "state.json")
const fresh = () => new Store(file())

describe("loading", () => {
  test("a missing or broken file starts from defaults", () => {
    const missing = fresh()
    assert.deepEqual(missing.data.spaces, [])
    assert.equal(missing.data.settings.defaultHarness, "opencode")
    assert.equal(missing.data.ui.sidebarWidth, 280)
    const path = file()
    writeFileSync(path, "{ not json")
    assert.equal(new Store(path).data.settings.appearance, "system")
  })

  test("saves and reads back", () => {
    const path = file()
    const a = new Store(path)
    const id = a.createSpace("Work")
    a.assign("ses_1", id)
    a.setSettings({ fontSize: 15 })
    const b = new Store(path)
    assert.equal(b.space(id).name, "Work")
    assert.equal(b.data.assignments.ses_1, id)
    assert.equal(b.data.settings.fontSize, 15)
  })

  test("older state migrates: disabled adapters, the default model toggle, CLI checks", () => {
    const path = file()
    writeFileSync(
      path,
      JSON.stringify({
        viewedSince: 1,
        ui: { sidebarWidth: 400 },
        settings: { disabledAdapters: ["slack"], defaultModel: { providerID: "a", id: "b" }, cliTools: [{}], soundChoices: { failed: "Ping" } },
      }),
    )
    const s = new Store(path).data.settings
    assert.deepEqual(s.adapterModes, { slack: "links" })
    assert.equal(s.defaultModelEnabled, true)
    assert.equal(s.disabledAdapters, undefined)
    assert.equal(s.cliTools, undefined)
    assert.equal(s.soundChoices.failed, "Ping")
    assert.equal(s.soundChoices.finished, "Hero", "missing sound choices keep their default")
    assert.equal(new Store(path).data.ui.recentsCollapsed, false, "missing ui fields keep their default")
  })
})

describe("spaces", () => {
  test("new spaces go first; move clamps the index", () => {
    const store = fresh()
    const a = store.createSpace("A")
    const b = store.createSpace("B")
    const names = () => store.data.spaces.map((s) => s.name)
    assert.deepEqual(names(), ["B", "A"])
    store.moveSpace(b, 99)
    assert.deepEqual(names(), ["A", "B"])
    store.moveSpace(b, -5)
    assert.deepEqual(names(), ["B", "A"])
    store.moveSpace("spc_nope", 0)
    assert.equal(store.space(a).name, "A")
  })

  test("patchSpace trims names and drops blank or null fields, but never the name", () => {
    const store = fresh()
    const id = store.createSpace("A")
    store.patchSpace(id, { name: "  B  ", directory: "/x", instructions: "be nice" })
    assert.deepEqual(store.space(id), { id, name: "B", directory: "/x", instructions: "be nice" })
    store.patchSpace(id, { name: "", directory: null, instructions: "   " })
    assert.deepEqual(store.space(id), { id, name: "B" })
  })

  test("deleting a space unfiles its sessions; restoring puts both back", () => {
    const store = fresh()
    const a = store.createSpace("A")
    const b = store.createSpace("B")
    store.assign("ses_1", a)
    store.assign("ses_2", b)
    const space = store.space(a)
    const index = store.data.spaces.indexOf(space)
    store.deleteSpace(a)
    assert.equal(store.space(a), undefined)
    assert.deepEqual(store.data.assignments, { ses_2: b })
    store.restoreSpace(space, index, ["ses_1"])
    assert.equal(store.data.spaces.indexOf(store.space(a)), index)
    assert.equal(store.data.assignments.ses_1, a)
    store.restoreSpace(space, 0, [])
    assert.equal(store.data.spaces.length, 2, "restoring twice is a no-op")
  })

  test("assigning to a missing space or null unfiles the session", () => {
    const store = fresh()
    const a = store.createSpace("A")
    store.assign("ses_1", a)
    store.assign("ses_1", "spc_gone")
    assert.equal(store.data.assignments.ses_1, undefined)
  })
})

describe("sessions", () => {
  test("archiving keeps the first archive time; resources restart theirs", async () => {
    const store = fresh()
    store.setArchived(["ses_1"], true)
    const at = store.data.archived.ses_1
    store.data.archived.ses_1 = at - 1000
    store.setArchived(["ses_1"], true)
    assert.equal(store.data.archived.ses_1, at - 1000)
    store.setArchived(["ses_1"], false)
    assert.equal(store.data.archived.ses_1, undefined)

    store.setResourcesArchived(["r"], true)
    store.data.archivedResources.r = 1
    store.setResourcesArchived(["r"], true)
    assert.ok(store.data.archivedResources.r > 1)
  })

  test("setParent refuses cycles, and withDescendants walks every level", () => {
    const store = fresh()
    assert.equal(store.setParent("ses_b", "ses_a"), true)
    assert.equal(store.setParent("ses_c", "ses_b"), true)
    assert.equal(store.setParent("ses_a", "ses_c"), false)
    assert.equal(store.setParent("ses_a", "ses_a"), false)
    assert.equal(store.isAncestor("ses_a", "ses_c"), true)
    assert.equal(store.isAncestor("ses_c", "ses_a"), false)
    assert.deepEqual(store.withDescendants(["ses_a"]).sort(), ["ses_a", "ses_b", "ses_c"])
    assert.equal(store.setParent("ses_b", null), true)
    assert.deepEqual(store.withDescendants(["ses_a"]), ["ses_a"])
  })

  test("isAncestor survives a cycle already in the file", () => {
    const store = fresh()
    store.data.parents = { ses_a: "ses_b", ses_b: "ses_a" }
    assert.equal(store.isAncestor("ses_x", "ses_a"), false)
  })

  test("forgetting a session drops what ctrl kept and moves its children up", () => {
    const store = fresh()
    const a = store.createSpace("A")
    store.assign("ses_mid", a)
    store.setArchived(["ses_mid"], true)
    store.setTitle("ses_mid", "pending title")
    store.setParent("ses_mid", "ses_top")
    store.setParent("ses_kid", "ses_mid")
    store.forgetSession("ses_mid")
    assert.equal(store.data.assignments.ses_mid, undefined)
    assert.equal(store.data.archived.ses_mid, undefined)
    assert.equal(store.data.titles.ses_mid, undefined)
    assert.deepEqual(store.data.parents, { ses_kid: "ses_top" })
  })

  test("the remote token is made once and persisted", () => {
    const path = file()
    const token = new Store(path).remoteToken()
    assert.match(token, /^[\w-]{32}$/)
    assert.equal(new Store(path).remoteToken(), token)
    assert.equal(JSON.parse(readFileSync(path, "utf8")).remoteToken, token)
  })
})
