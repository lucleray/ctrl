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
function fakeClient(all, active = {}) {
  const calls = { list: [], asked: [] }
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
    },
    permission: { request: { list: async ({ location }) => (calls.asked.push(location.directory), { data: [] }) } },
    form: { list: async () => ({ data: [] }) },
    mcp: { list: async () => ({ data: [] }) },
  }
  return { client, calls }
}

function service(all, active) {
  const { client, calls } = fakeClient(all, active)
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
