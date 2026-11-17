// fx's session files (src/main/fx-store.ts): v2's index and log, and v1's events.jsonl. Fixtures are shaped
// like what fx 0.0.17 writes. Run with `npm test`.
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-fx-store-test-")
let store

before(async () => {
  ;[store] = await load(tmp, "src/main/fx-store.ts")
})

const line = (seq, ts, kind, rest = "") => `{"v":1,"seq":${seq},"ts":${ts},"kind":"${kind}"${rest},"crc":"00000000"}`
const item = (seq, ts, type, data) => line(seq, ts, "item", `,"turn":1,"type":"${type}","data":${JSON.stringify(data)}`)

const LOG = [
  line(1, 100, "session_created", ',"id":"abc","workspace":"/w","role":"root","host":"app"'),
  line(2, 100, "set", ',"key":"prefs","value":{"model":"m"}'),
  line(3, 101, "turn_started", ',"turn":1'),
  item(4, 101, "user", { text: "fix the bug https://example.com/a", images: [] }),
  item(5, 102, "assistant_running", { text: "looking" }),
  item(6, 102, "tool_call", { tool_name: "shell", arguments_json: '{"command":"ls"}' }),
  item(7, 103, "assistant", { text: "looking" }),
  item(8, 104, "steering", { text: "also the tests" }),
  item(9, 105, "assistant", { text: "done" }),
  line(10, 106, "turn_committed", ',"turn":1'),
  line(11, 106, "set", ',"key":"language","value":"en"'),
  line(12, 107, "closed"),
]

describe("fx v2 index", () => {
  test("keeps the newest put per id, drops deleted ones, skips bad lines", () => {
    const into = new Map()
    const changed = store.foldIndex(
      [
        '{"op":"put","id":"a","role":"root","workspace":"/w","created":1,"updated":1,"crc":"x"}',
        '{"op":"put","id":"a","role":"root","workspace":"/w","title":"Fix it","created":1,"updated":5,"crc":"x"}',
        '{"op":"put","id":"c","role":"child","host":"child","parent":"a","workspace":"/w","created":2,"updated":2,"crc":"x"}',
        '{"op":"put","id":"b","role":"root","workspace":"/v","created":3,"updated":3,"crc":"x"}',
        '{"op":"del","id":"b","crc":"x"}',
        "not json",
      ].join("\n"),
      into,
    )
    assert.deepEqual([...changed].sort(), ["a", "b", "c"])
    assert.deepEqual([...into.keys()].sort(), ["a", "c"])
    assert.equal(into.get("a").title, "Fix it")
    assert.equal(into.get("a").updated, 5)
    assert.equal(into.get("c").role, "child")
    assert.equal(into.get("c").parent, "a")
  })
})

describe("fx v2 log", () => {
  test("the turn state comes from the newest turn line, past settings and closed", async () => {
    const file = join(tmp, "done.jsonl")
    const text = LOG.join("\n") + "\n"
    writeFileSync(file, text)
    assert.deepEqual(await store.lastTurn("v2", file, Buffer.byteLength(text)), { turn: "completed", ended: 106 })
  })

  test("an open turn is in progress", async () => {
    const file = join(tmp, "open.jsonl")
    const text = LOG.slice(0, 7).join("\n") + "\n"
    writeFileSync(file, text)
    assert.deepEqual(await store.lastTurn("v2", file, Buffer.byteLength(text)), { turn: "in-turn" })
  })

  test("an interrupted turn ended", async () => {
    const file = join(tmp, "stopped.jsonl")
    const text = [...LOG.slice(0, 5), line(6, 110, "turn_interrupted", ',"turn":1,"reason":"cancel"')].join("\n") + "\n"
    writeFileSync(file, text)
    assert.deepEqual(await store.lastTurn("v2", file, Buffer.byteLength(text)), { turn: "interrupted", ended: 110 })
  })

  test("no turn yet", async () => {
    const file = join(tmp, "new.jsonl")
    const text = LOG.slice(0, 2).join("\n") + "\n"
    writeFileSync(file, text)
    assert.deepEqual(await store.lastTurn("v2", file, Buffer.byteLength(text)), { turn: "none" })
  })

  test("finds the turn line behind a huge last line", async () => {
    const file = join(tmp, "big.jsonl")
    const big = line(13, 120, "set", `,"key":"usage","value":"${"x".repeat(100_000)}"`)
    const text = [...LOG, big].join("\n") + "\n"
    writeFileSync(file, text)
    assert.deepEqual(await store.lastTurn("v2", file, Buffer.byteLength(text)), { turn: "completed", ended: 106 })
  })

  test("indexes prompts, steering and replies, not previews or tool calls", () => {
    const docs = store.parseLogLines("v2", LOG.join("\n"))
    assert.deepEqual(
      docs.map((d) => [d.seq, d.role, d.created, d.body]),
      [
        [4, "user", 101, "fix the bug https://example.com/a"],
        [7, "assistant", 103, "looking"],
        [8, "user", 104, "also the tests"],
        [9, "assistant", 105, "done"],
      ],
    )
  })
})

describe("fx v1 log", () => {
  const v1 = (seq, ts, kind, payload) => JSON.stringify({ seq, timestamp_ms: ts, event: { [kind]: payload } })

  test("the last line says where the turn is", async () => {
    const file = join(tmp, "events.jsonl")
    const text = [v1(1, 10, "user", { text: "hi" }), v1(2, 11, "assistant", { text: "yo" }), v1(3, 12, "turn_completed", {})].join("\n") + "\n"
    writeFileSync(file, text)
    assert.deepEqual(await store.lastTurn("v1", file, Buffer.byteLength(text)), { turn: "completed", ended: 12 })
    assert.deepEqual(
      store.parseLogLines("v1", text).map((d) => [d.seq, d.role, d.body]),
      [
        [1, "user", "hi"],
        [2, "assistant", "yo"],
      ],
    )
  })
})
