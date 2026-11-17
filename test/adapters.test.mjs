// Resource links (src/shared/adapters): which URLs become which resource, how they're found in text,
// ranked, and placed on the Board. Run with `npm test`.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-adapters-test-")
let parseResourceUrl, extractResources, byRank, boardPlacement, adapterMode, ADAPTERS

before(async () => {
  ;[{ parseResourceUrl, extractResources, byRank, boardPlacement, adapterMode, ADAPTERS }] = await load(tmp, "src/shared/adapters/index.ts")
})

/** url → [key, canonical url] */
const CASES = {
  "https://github.com/vercel/next.js/pull/123/files#diff": ["github-pr:vercel/next.js#123", "https://github.com/vercel/next.js/pull/123"],
  "https://github.com/vercel/next.js/issues/9": ["github-issue:vercel/next.js#9", "https://github.com/vercel/next.js/issues/9"],
  "https://github.com/vercel/next.js/commit/abc123def": ["github-commit:vercel/next.js@abc123def", "https://github.com/vercel/next.js/commit/abc123def"],
  "https://github.com/vercel/next.js/tree/canary/packages": ["github-repo:vercel/next.js", "https://github.com/vercel/next.js"],
  "https://linear.app/vercel/issue/OBS-123/some-title": ["linear-issue:vercel/OBS-123", "https://linear.app/vercel/issue/OBS-123"],
  "https://app.notion.com/p/vercel/agent-docs-381e06b059c480d2b767c878ff0e1820": [
    "notion-page:381e06b059c480d2b767c878ff0e1820",
    "https://www.notion.so/381e06b059c480d2b767c878ff0e1820",
  ],
  "https://www.notion.so/vercel/My-Page-381e06b059c480d2b767c878ff0e1820": [
    "notion-page:381e06b059c480d2b767c878ff0e1820",
    "https://www.notion.so/381e06b059c480d2b767c878ff0e1820",
  ],
  "https://vercel.enterprise.slack.com/archives/C0BQ9MRSSPJ": ["slack-channel:C0BQ9MRSSPJ", "https://vercel.slack.com/archives/C0BQ9MRSSPJ"],
  "https://vercel.enterprise.slack.com/archives/C0BQ9MRSSPJ/p1700000000123456": [
    "slack-thread:C0BQ9MRSSPJ/1700000000.123456",
    "https://vercel.slack.com/archives/C0BQ9MRSSPJ/p1700000000123456",
  ],
  "https://vercel.com/vercel/front/deployments": ["vercel-project:vercel/front", "https://vercel.com/vercel/front"],
  "https://front-abc123-vercel.vercel.app": ["vercel-deployment:front-abc123-vercel.vercel.app", "https://front-abc123-vercel.vercel.app"],
  "ctrl://session/ses_abc?title=Hi": ["session:ses_abc", "ctrl://session/ses_abc"],
}

describe("parseResourceUrl", () => {
  test("known links get their canonical key and URL", () => {
    for (const [url, [key, canonical]] of Object.entries(CASES)) {
      const r = parseResourceUrl(url)
      assert.equal(r?.key, key, url)
      assert.equal(r.url, canonical, url)
      assert.equal(r.type, key.split(":")[0], url)
    }
  })

  test("titles come from the URL's slug, without fetching", () => {
    assert.equal(parseResourceUrl("https://linear.app/vercel/issue/OBS-1/fix-the-thing").data.title, "Fix the thing")
    assert.equal(parseResourceUrl("ctrl://session/ses_a?title=Hello").data.title, "Hello")
  })

  test("anything else is null", () => {
    for (const url of ["not a url", "ftp://github.com/a/b", "https://example.com", "https://github.com/orgs/vercel", "javascript:alert(1)"])
      assert.equal(parseResourceUrl(url), null, url)
  })
})

describe("extractResources", () => {
  test("finds session mentions and URLs once each, without trailing punctuation", () => {
    const text = [
      "see @session[My (one)](ses_abc1) and https://github.com/vercel/next.js/pull/1.",
      "again (https://github.com/vercel/next.js/pull/1/files) and `https://linear.app/vercel/issue/OBS-1`",
      "fx one: session[Other](fx:abc_1-2), nothing at https://example.com",
    ].join("\n")
    const found = extractResources(text)
    assert.deepEqual(
      found.map((r) => r.key),
      ["session:ses_abc1", "session:fx:abc_1-2", "github-pr:vercel/next.js#1", "linear-issue:vercel/OBS-1"],
    )
    assert.equal(found[0].data.title, "My (one)")
  })

  test("later mentions of the same resource add what the URL says", () => {
    const [issue] = extractResources("https://linear.app/vercel/issue/OBS-1 then https://linear.app/vercel/issue/OBS-1/a-title")
    assert.equal(issue.data.title, "A title")
  })
})

describe("ranking and the Board", () => {
  const pr = (fields) => ({ type: "github-pr", meta: fields && { fields }, last: Date.now() })

  test("open PRs before merged, merged before closed, otherwise keeping the order", () => {
    const items = [pr({ state: "closed" }), pr({ state: "merged" }), pr({ state: "open" }), pr(undefined)].map((p, i) => ({ ...p, i }))
    assert.deepEqual(
      byRank(items).map((p) => p.i),
      [2, 3, 1, 0],
    )
  })

  test("PR stages: your turn, someone else's, moving, done", () => {
    const now = Date.now()
    const at = (fields, me = "luc") => boardPlacement(pr({ author: "luc", state: "open", ...fields }), { me, now })
    assert.deepEqual(at({ state: "merged" }), { stage: "done", reason: "Merged" })
    assert.equal(at({ ci: "failure" }).stage, "you")
    assert.equal(at({ mergeable: "conflicting" }).reason, "Merge conflicts")
    assert.equal(at({ draft: true, ci: "pending" }).reason, "Draft, CI running")
    assert.equal(at({ review: "approved", autoMerge: true }).stage, "moving")
    assert.equal(at({ review: "approved" }).reason, "Approved, ready to merge")
    assert.equal(at({ author: "someone" }).stage, "waiting")
  })

  test("types without a stage stay off the Board", () => {
    assert.equal(boardPlacement({ type: "github-repo", last: 0 }, { now: Date.now() }), null)
    assert.equal(boardPlacement({ type: "nope", last: 0 }, { now: Date.now() }), null)
  })

  test("adapters without live details can't be live", () => {
    const linksOnly = ADAPTERS.find((a) => !a.live)
    const live = ADAPTERS.find((a) => a.live)
    assert.equal(adapterMode(linksOnly, {}), "links")
    assert.equal(adapterMode(linksOnly, { [linksOnly.id]: "live" }), "links")
    assert.equal(adapterMode(live, {}), "live")
    assert.equal(adapterMode(live, { [live.id]: "off" }), "off")
  })

  test("every resource type id is unique and owned by one adapter", () => {
    const ids = ADAPTERS.flatMap((a) => a.types.map((t) => t.id))
    assert.equal(new Set(ids).size, ids.length)
  })
})
