// The ACP client (src/main/acp/client.ts) over a fake agent process, and the transcript that turns an ACP
// session's updates into chat items (src/main/acp/transcript.ts). Run with `npm test`.
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-acp-test-")
let AcpClient, AcpError, Transcript

before(async () => {
  ;[{ AcpClient, AcpError }, { Transcript }] = await load(tmp, "src/main/acp/client.ts", "src/main/acp/transcript.ts")
})

/** A fake agent: what the client writes shows up in `sent` (parsed), `emit(msg)` is a line from the agent. */
function fakeAgent() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const emitter = new EventEmitter()
  const sent = []
  let buffer = ""
  const arrived = []
  stdin.on("data", (d) => {
    buffer += d
    let at
    while ((at = buffer.indexOf("\n")) >= 0) {
      sent.push(JSON.parse(buffer.slice(0, at)))
      buffer = buffer.slice(at + 1)
      arrived.shift()?.()
    }
  })
  return {
    transport: { stdin, stdout, once: (ev, cb) => emitter.once(ev, cb) },
    sent,
    /** Resolves once the client has written one more message. */
    next: () => new Promise((r) => (sent.length > arrived.length ? r() : arrived.push(r))),
    emit: (msg) => stdout.write((typeof msg === "string" ? msg : JSON.stringify(msg)) + "\n"),
    close: (code) => emitter.emit("close", code),
  }
}

const tick = () => new Promise((r) => setImmediate(r))

describe("AcpClient", () => {
  test("requests get numbered ids and resolve with their result, in any order", async () => {
    const agent = fakeAgent()
    const client = new AcpClient(agent.transport)
    const a = client.request("initialize", { protocolVersion: 1 })
    const b = client.request("session/new", { cwd: "/p" })
    await tick()
    assert.deepEqual(agent.sent, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/p" } },
    ])
    agent.emit({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1" } })
    agent.emit({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })
    assert.deepEqual(await b, { sessionId: "s1" })
    assert.deepEqual(await a, { protocolVersion: 1 })
  })

  test("an error reply rejects with an AcpError carrying code, message and data", async () => {
    const agent = fakeAgent()
    const client = new AcpClient(agent.transport)
    const p = client.request("session/load", { sessionId: "x" })
    await tick()
    agent.emit({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Session is busy", data: { sessionId: "x" } } })
    const err = await p.catch((e) => e)
    assert.ok(err instanceof AcpError)
    assert.equal(err.code, -32603)
    assert.equal(err.message, "Session is busy")
    assert.deepEqual(err.data, { sessionId: "x" })
  })

  test("notifications reach onNotification; lines that aren't JSON or aren't ours are ignored", async () => {
    const agent = fakeAgent()
    const client = new AcpClient(agent.transport)
    const got = []
    client.onNotification = (method, params) => got.push([method, params])
    agent.emit("not json at all")
    agent.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "usage_update" } } })
    agent.emit({ jsonrpc: "2.0", id: 99, result: {} })
    agent.emit("")
    await tick()
    assert.deepEqual(got, [["session/update", { sessionId: "s1", update: { sessionUpdate: "usage_update" } }]])
  })

  test("a chunked line is reassembled", async () => {
    const agent = fakeAgent()
    const client = new AcpClient(agent.transport)
    const got = []
    client.onNotification = (method) => got.push(method)
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }) + "\n"
    agent.transport.stdout.write(line.slice(0, 10))
    await tick()
    assert.deepEqual(got, [])
    agent.transport.stdout.write(line.slice(10))
    await tick()
    assert.deepEqual(got, ["session/update"])
  })

  test("requests from the agent are answered through onRequest: result, AcpError, other errors, no handler", async () => {
    const agent = fakeAgent()
    const client = new AcpClient(agent.transport)
    agent.emit({ jsonrpc: "2.0", id: "r0", method: "session/request_permission", params: {} })
    await agent.next()
    assert.deepEqual(agent.sent[0], { jsonrpc: "2.0", id: "r0", error: { code: -32601, message: "Method not found: session/request_permission" } })

    client.onRequest = async (method, params) => {
      if (method === "ok") return { outcome: params.want }
      if (method === "acp") throw new AcpError(-32002, "No such session", { sessionId: "x" })
      if (method === "void") return undefined
      throw new Error("boom")
    }
    agent.emit({ jsonrpc: "2.0", id: "r1", method: "ok", params: { want: "selected" } })
    agent.emit({ jsonrpc: "2.0", id: "r2", method: "acp", params: {} })
    agent.emit({ jsonrpc: "2.0", id: "r3", method: "other", params: {} })
    agent.emit({ jsonrpc: "2.0", id: "r4", method: "void", params: {} })
    for (let i = 0; i < 4; i++) await agent.next()
    const byID = Object.fromEntries(agent.sent.map((m) => [m.id, m]))
    assert.deepEqual(byID.r1, { jsonrpc: "2.0", id: "r1", result: { outcome: "selected" } })
    assert.deepEqual(byID.r2, { jsonrpc: "2.0", id: "r2", error: { code: -32002, message: "No such session", data: { sessionId: "x" } } })
    assert.deepEqual(byID.r3, { jsonrpc: "2.0", id: "r3", error: { code: -32603, message: "boom" } })
    assert.deepEqual(byID.r4, { jsonrpc: "2.0", id: "r4", result: null })
  })

  test("when the process closes, requests in flight and later ones reject, and onClose fires once", async () => {
    const agent = fakeAgent()
    const client = new AcpClient(agent.transport)
    const closes = []
    client.onClose = (code) => closes.push(code)
    const inFlight = client.request("session/prompt", {})
    await tick()
    agent.close(1)
    await assert.rejects(inFlight, /exited with code 1/)
    await assert.rejects(client.request("session/cancel", {}), /exited with code 1/)
    assert.equal(client.isClosed, true)
    client.notify("ignored", {})
    agent.close(1)
    assert.deepEqual(closes, [1])
    assert.equal(agent.sent.length, 1)
  })

  test("notify writes without an id", async () => {
    const agent = fakeAgent()
    const client = new AcpClient(agent.transport)
    client.notify("session/cancel", { sessionId: "s1" })
    await agent.next()
    assert.deepEqual(agent.sent, [{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } }])
  })
})

// ---------- Transcript ----------

const text = (sessionUpdate, text, extra = {}) => ({ sessionUpdate, content: { type: "text", text }, ...extra })
const user = (t, messageId) => text("user_message_chunk", t, messageId ? { messageId } : {})
const agent = (t, messageId = "m") => text("agent_message_chunk", t, { messageId })
const thought = (t) => text("agent_thought_chunk", t)
const toolCall = (toolCallId, rawInput, extra = {}) => ({ sessionUpdate: "tool_call", toolCallId, status: "pending", rawInput, ...extra })
const toolUpdate = (toolCallId, status, extra = {}) => ({ sessionUpdate: "tool_call_update", toolCallId, status, ...extra })

/** A transcript with a fixed clock, so times are deterministic. */
function transcript(updates = []) {
  let now = 1000
  const t = new Transcript(() => now)
  t.tick = (ms) => (now += ms)
  for (const u of updates) t.apply(u)
  return t
}

describe("Transcript", () => {
  test("a prompt, a reply with thinking, text and a tool call, ended by endTurn", () => {
    const t = transcript()
    assert.equal(t.apply(user("Run the tests", "u-1")), true)
    assert.equal(t.apply(thought("Let me ")), true)
    assert.equal(t.apply(thought("look.")), true)
    assert.equal(t.apply(agent("Running ")), true)
    assert.equal(t.apply(toolCall("tc1", { action: "run", command: "npm test" }, { name: "shell", title: "Running", kind: "execute" })), true)
    assert.equal(t.apply(toolUpdate("tc1", "in_progress")), true)
    assert.equal(t.apply(toolUpdate("tc1", "completed", { content: [{ type: "content", content: { type: "text", text: "ok" } }] })), true)
    assert.equal(t.apply(agent("them: all green.")), true)
    assert.equal(t.open, true)
    assert.deepEqual(t.page(undefined, true), {
      cursor: null,
      items: [
        { id: "u1", kind: "user", time: 1000, text: "Run the tests" },
        {
          id: "a2",
          kind: "assistant",
          time: 1001,
          live: true,
          parts: [
            { type: "reasoning", text: "Let me look." },
            { type: "text", text: "Running " },
            { type: "tool", name: "shell", summary: "npm test", status: "done", command: "npm test" },
            { type: "text", text: "them: all green." },
          ],
        },
      ],
    })
    assert.equal(t.endTurn(), true)
    assert.equal(t.open, false)
    assert.equal(t.items[1].live, false)
    assert.equal(t.items[1].error, undefined)
    assert.equal(t.endTurn(), false)
  })

  test("without detail, thinking text and commands stay on the desktop", () => {
    const t = transcript([user("hi"), thought("hmm"), toolCall("tc1", { command: "ls" }, { name: "shell" }), toolCall("tc2", { path: "/a/" + "x".repeat(200) }, { name: "read_file" })])
    const [, reply] = t.page().items
    assert.deepEqual(reply.parts[0], { type: "reasoning" })
    assert.deepEqual(reply.parts[1], { type: "tool", name: "shell", summary: "ls", status: "running" })
    assert.equal(reply.parts[2].detail, undefined)
    assert.ok(reply.parts[2].summary.endsWith("…"))
    // With detail, the cut input is given whole.
    assert.equal(t.page(undefined, true).items[1].parts[2].detail, "/a/" + "x".repeat(200))
  })

  test("tool statuses: pending and in_progress run, completed is done, failed is an error; unknown calls are ignored", () => {
    const t = transcript([user("x"), toolCall("a", {}, { name: "t", status: "in_progress" }), toolCall("b", {}, { name: "t" }), toolCall("c", {}, { name: "t" })])
    t.apply(toolUpdate("b", "completed"))
    t.apply(toolUpdate("c", "failed"))
    assert.equal(t.apply(toolUpdate("zzz", "completed")), false)
    assert.deepEqual(
      t.items[1].parts.map((p) => p.status),
      ["running", "done", "error"],
    )
  })

  test("a tool call's name falls back to its title, then kind; its summary to the title", () => {
    const t = transcript([user("x"), toolCall("a", {}, { title: "Reading notes.txt" }), toolCall("b", {}, { kind: "read" }), toolCall("c", {})])
    assert.deepEqual(
      t.items[1].parts.map((p) => [p.name, p.summary]),
      [
        ["Reading notes.txt", "Reading notes.txt"],
        ["read", ""],
        ["tool", ""],
      ],
    )
  })

  test("chunks of one user message join; a new messageId or none starts another", () => {
    const t = transcript([user("Hel", "m1"), user("lo", "m1"), user("again", "m2"), user("x"), user("y")])
    assert.deepEqual(
      t.items.map((i) => i.text),
      ["Hello", "again", "x", "y"],
    )
  })

  test("a steer mid-reply ends the reply, and what follows is a new one", () => {
    const t = transcript([user("go", "m1"), agent("first"), user("also BANANA", "m2", { _meta: { fx: { steering: { requestId: 4 } } } }), agent("second BANANA")])
    assert.deepEqual(
      t.items.map((i) => [i.kind, i.kind === "user" ? i.text : [i.live, i.parts[0].text]]),
      [
        ["user", "go"],
        ["assistant", [false, "first"]],
        ["user", "also BANANA"],
        ["assistant", [true, "second BANANA"]],
      ],
    )
    t.endTurn()
    assert.equal(t.items[3].live, false)
  })

  test("images attached to a prompt are counted and kept for the chat's <img>", () => {
    const t = transcript([
      user("see", "m1"),
      { sessionUpdate: "user_message_chunk", messageId: "m1", content: { type: "image", data: "AAA", mimeType: "image/jpeg" } },
      { sessionUpdate: "user_message_chunk", messageId: "m1", content: { type: "image", data: "BBB" } },
    ])
    assert.deepEqual(t.items[0], { id: "u1", kind: "user", time: 1000, text: "see", images: 2 })
    assert.deepEqual(t.image("u1", 0), { mime: "image/jpeg", data: "AAA" })
    assert.deepEqual(t.image("u1", 1), { mime: "image/png", data: "BBB" })
    assert.equal(t.image("u1", 2), undefined)
    assert.equal(t.image("nope", 0), undefined)
  })

  test("an empty reply is dropped; a failed one keeps its error", () => {
    const t = transcript([user("a")])
    t.apply(agent(""))
    assert.equal(t.open, false)
    assert.equal(t.endTurn(), false)
    assert.equal(t.items.length, 1)
    t.apply(user("b"))
    t.apply(thought("x"))
    t.endTurn("HTTP error")
    assert.equal(t.items.length, 3)
    assert.deepEqual([t.items[2].live, t.items[2].error], [false, "HTTP error"])
    // An empty reply on a user message that interrupted it also goes.
    const t2 = transcript([user("a"), toolCall("tc", {}, { name: "t" })])
    t2.items[1].parts.length = 0
    t2.apply(user("b"))
    assert.deepEqual(
      t2.items.map((i) => i.kind),
      ["user", "user"],
    )
  })

  test("updates that aren't part of the transcript change nothing", () => {
    const t = transcript([user("a")])
    for (const u of [
      { sessionUpdate: "session_info_update", title: "T" },
      { sessionUpdate: "usage_update" },
      { sessionUpdate: "available_commands_update" },
      { sessionUpdate: "notice", content: { type: "text", text: "[context] shortened" } },
      { sessionUpdate: "user_message_chunk" },
      { sessionUpdate: "tool_call" },
    ])
      assert.equal(t.apply(u), false, u.sessionUpdate)
    assert.equal(t.items.length, 1)
  })

  test("fx's notices sent as reply text are left out", () => {
    const t = transcript([
      user("a"),
      agent('skill discovery warning: candidate "/x" was skipped', "n1"),
      agent("[context] skill descriptions shortened: 15; source=compiled default\n", "n1"),
      agent("OK", "r1"),
      thought("[context] in a thought is fine"),
    ])
    assert.deepEqual(t.items[1].parts, [
      { type: "text", text: "OK" },
      { type: "reasoning", text: "[context] in a thought is fine" },
    ])
  })

  test("times only grow, even when the clock stands still", () => {
    const t = transcript([user("a", "1"), user("b", "2"), user("c", "3")])
    assert.deepEqual(
      t.items.map((i) => i.time),
      [1000, 1001, 1002],
    )
    t.tick(5000)
    t.apply(user("d", "4"))
    assert.equal(t.items[3].time, 6000)
  })

  test("pages: the newest 40, then the 40 before the cursor, oldest first; a short page has no cursor", () => {
    const updates = []
    for (let i = 0; i < 50; i++) updates.push(user(`m${i}`, `id${i}`))
    const t = transcript(updates)
    const newest = t.page()
    assert.equal(newest.items.length, 40)
    assert.deepEqual([newest.items[0].text, newest.items.at(-1).text, newest.cursor], ["m10", "m49", "10"])
    const older = t.page(newest.cursor)
    assert.deepEqual(
      older.items.map((i) => i.text),
      Array.from({ length: 10 }, (_, i) => `m${i}`),
    )
    assert.equal(older.cursor, null)
    assert.deepEqual(t.page("garbage"), { items: [], cursor: null })
    assert.equal(transcript([user("one")]).page().cursor, null)
  })
})
