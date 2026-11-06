// The companion's matching: helper URLs → resource keys → sessions that mentioned them. Run with `npm test`.
import * as esbuild from "esbuild"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

const tmp = mkdtempSync(join(tmpdir(), "ctrl-companion-test-"))
let lookupFor, relatedName, openSearchDb, MentionReader

before(async () => {
  const out = join(tmp, "bundle.cjs")
  await esbuild.build({
    stdin: {
      contents: `export * from "./src/companion/match"; export { openSearchDb, MentionReader } from "./src/main/search-db"`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile: out,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "warning",
  })
  ;({ lookupFor, relatedName, openSearchDb, MentionReader } = createRequire(import.meta.url)(out))
})

after(() => rmSync(tmp, { recursive: true, force: true }))

test("browser and Slack URLs become the indexer's keys", () => {
  const pr = lookupFor(["https://github.com/acme/web/pull/123/files?w=1"])
  assert.deepEqual(pr.exact, ["github-pr:acme/web#123"])
  assert.deepEqual(pr.related, [])

  // Slack thread side panel: a reply link collapses to its thread, then the channel (and its threads).
  const slack = lookupFor([
    "https://acme.slack.com/archives/C123ABC/p1784194033191299?thread_ts=1784193018.484539&cid=C123ABC",
    "https://slack.slack.com/archives/C123ABC",
  ])
  assert.deepEqual(slack.exact, ["slack-thread:C123ABC/1784193018.484539", "slack-channel:C123ABC"])
  assert.deepEqual(slack.related, ["slack-thread:C123ABC/"])
  assert.match(relatedName("slack-thread:C123ABC/1784193018.484539"), /^Thread · /)

  assert.deepEqual(lookupFor(["https://www.google.com/search?q=x", "not a url"]).exact, [])
})

test("mentions: exact keys and channel prefixes, newest first", () => {
  const path = join(tmp, "search.db")
  const db = openSearchDb(path)
  const mention = db.prepare(
    "INSERT INTO resource_mentions (message_id, resource_id, session_id, role, created) VALUES (?, ?, ?, 'user', ?)",
  )
  mention.run("m1", "slack-thread:C123ABC/1784193018.484539", "ses_a", 10)
  mention.run("m2", "slack-thread:C123ABC/1700000000.000001", "ses_b", 30)
  mention.run("m3", "slack-thread:C999/1700000000.000001", "ses_c", 40)
  mention.run("m4", "slack-channel:C123ABC", "ses_d", 20)
  mention.run("m5", "slack-thread:C123ABCD/1700000000.000001", "ses_e", 50)
  const reader = new MentionReader(db)
  const { exact, related } = reader.sessionsMentioning(["slack-channel:C123ABC"], ["slack-thread:C123ABC/"])
  assert.deepEqual(exact.map((m) => m.session_id), ["ses_d"])
  // C123ABCD is another channel: the "/" in the prefix keeps it out.
  assert.deepEqual(related.map((m) => m.session_id), ["ses_b", "ses_a"])
  db.close()
})
