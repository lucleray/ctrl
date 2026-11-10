// OpenCodeService's full sync against a fake opencode client: recent sessions first, older ones on demand,
// and only running sessions' folders asked for pending input. Run with `npm test`.
import * as esbuild from "esbuild"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

const tmp = mkdtempSync(join(tmpdir(), "ctrl-opencode-test-"))
let OpenCodeService

before(async () => {
  const out = join(tmp, "opencode.cjs")
  await esbuild.build({
    entryPoints: ["src/main/opencode.ts"],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "warning",
  })
  ;({ OpenCodeService } = createRequire(import.meta.url)(out))
})

after(() => rmSync(tmp, { recursive: true, force: true }))

const DAY = 24 * 60 * 60_000

/** `count` root sessions, newest first, one day apart, each in its own folder. */
function sessions(count) {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => ({
    id: `ses_${String(i).padStart(4, "0")}`,
    title: `s${i}`,
    location: { directory: `/dir/${i}` },
    time: { created: now - i * DAY, updated: now - i * DAY - 1000 },
  }))
}

/** Pages by offset like opencode's cursors; records every call. */
function fakeClient(all, active = {}, { shells = [], subagents = {} } = {}) {
  const calls = { list: [], asked: [], shells: [] }
  const page = (from, limit = 50) => {
    const data = all.slice(from, from + limit)
    return { data, cursor: { next: from + limit < all.length ? String(from + limit) : undefined } }
  }
  const client = {
    session: {
      list: async (input) => {
        calls.list.push(input)
        return page(input.cursor ? Number(input.cursor) : 0, input.limit)
      },
      active: async () => active,
      get: async ({ sessionID }) => ({ id: sessionID, parentID: subagents[sessionID] }),
    },
    shell: {
      list: async ({ location }) => (
        calls.shells.push(location.directory), { data: shells.filter((s) => s.cwd === location.directory) }
      ),
    },
    permission: { request: { list: async ({ location }) => (calls.asked.push(location.directory), { data: [] }) } },
    form: { list: async () => ({ data: [] }) },
    mcp: { list: async () => ({ data: [] }) },
  }
  return { client, calls }
}

function service(all, active, extra) {
  const { client, calls } = fakeClient(all, active, extra)
  const svc = new OpenCodeService(() => {})
  svc.client = client
  return { svc, calls }
}

test("full sync loads the last 30 days, asks only running sessions' folders, and loads older ones on demand", async () => {
  const all = sessions(700)
  const { svc, calls } = service(all, { ses_0002: { type: "running" } })
  await svc.sync()
  assert.equal(svc.sessions.length, 30)
  assert.deepEqual(calls.asked, ["/dir/2"])
  assert.deepEqual(calls.list.map((c) => c.limit), [300])

  await svc.loadOlder()
  assert.equal(svc.sessions.length, 700)
  assert.ok(calls.list.slice(1).every((c) => c.limit === 300), "every page asks for 300")
  assert.equal(calls.list.length, 3)

  // Asked for once: free afterwards, and a re-sync brings them back.
  await svc.loadOlder()
  assert.equal(calls.list.length, 3)
  await svc.sync()
  await svc.loadOlder()
  assert.equal(svc.sessions.length, 700)
})

test("loadOlder before the first sync is remembered, and is a no-op when nothing is older", async () => {
  const { svc, calls } = service(sessions(10))
  await svc.loadOlder()
  assert.equal(calls.list.length, 0)
  await svc.sync()
  assert.equal(svc.sessions.length, 10)
  await svc.loadOlder()
  assert.equal(calls.list.length, 1)
})

test("loadOlder during a re-sync still ends with the older sessions loaded", async () => {
  const { svc } = service(sessions(400))
  await svc.sync()
  await svc.loadOlder()
  const resync = svc.sync()
  const during = svc.loadOlder()
  await Promise.all([resync, during])
  await svc.loadOlder()
  assert.equal(svc.sessions.length, 400)
})

test("background activity: shells and running subagents count towards their root session", async () => {
  const all = sessions(3).map((s, i) => ({ ...s, time: { ...s.time, updated: Date.now() - i * 60_000 } }))
  const shells = [
    { id: "sh_1", status: "running", cwd: "/dir/0", metadata: { sessionID: "ses_0000" } },
    { id: "sh_2", status: "exited", cwd: "/dir/0", metadata: { sessionID: "ses_0000" } },
    { id: "sh_3", status: "running", cwd: "/dir/1", metadata: { sessionID: "ses_sub2" } },
  ]
  // ses_sub2 is a subagent of ses_sub1, itself a subagent of ses_0001.
  const subagents = { ses_sub1: "ses_0001", ses_sub2: "ses_sub1" }
  const active = { ses_sub1: { type: "running" }, ses_sub2: { type: "running" } }
  const { svc, calls } = service(all, active, { shells, subagents })
  await svc.sync()
  assert.deepEqual(calls.shells.sort(), ["/dir/0", "/dir/1", "/dir/2"])
  assert.deepEqual(svc.activity("ses_0000"), { shells: 1, subagents: 0 })
  assert.deepEqual(svc.activity("ses_0001"), { shells: 1, subagents: 2 })
  assert.equal(svc.activity("ses_0002"), undefined)
  // Subagents never show up as sessions of their own.
  assert.equal(svc.sessions.length, 3)

  svc.apply({ type: "shell.exited", data: { id: "sh_1" } })
  assert.equal(svc.activity("ses_0000"), undefined)
  svc.apply({ type: "shell.created", data: { info: { id: "sh_4", status: "running", metadata: { sessionID: "ses_0002" } } } })
  assert.deepEqual(svc.activity("ses_0002"), { shells: 1, subagents: 0 })
})

test("shells are only listed in the folders of recently updated sessions", async () => {
  const { svc, calls } = service(sessions(5))
  await svc.sync()
  // One day apart: only the newest session was updated in the last 6 hours.
  assert.deepEqual(calls.shells, ["/dir/0"])
})
