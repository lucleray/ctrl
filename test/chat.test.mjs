// Sessions as a chat: the router every chat view goes through (src/main/chat.ts) and opencode's side of it
// (src/main/opencode-chat.ts), against fake harnesses and a fake opencode client. Run with `npm test`.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-chat-route-test-")
let createChat, BACKGROUND_GRACE_MS, OpenCodeChat

before(async () => {
  ;[{ createChat, BACKGROUND_GRACE_MS }, { OpenCodeChat }] = await load(tmp, "src/main/chat.ts", "src/main/opencode-chat.ts")
})

// ---------- OpenCodeChat ----------

/** A fake opencode client that records every call as [method, input]. */
function fakeClient({ session = {}, messages = [], models = [], fallback = null, sentID = "msg_1" } = {}) {
  const calls = []
  const rec = (name, result) => async (input) => (calls.push([name, input]), typeof result === "function" ? result(input) : result)
  const client = {
    session: {
      // sentID null: opencode answers without a message
      prompt: rec("session.prompt", sentID === null ? undefined : { id: sentID }),
      interrupt: rec("session.interrupt", undefined),
      get: rec("session.get", { location: { directory: "/proj" }, ...session }),
      switchModel: rec("session.switchModel", { ok: true }),
      form: { reply: rec("form.reply", undefined), cancel: rec("form.cancel", undefined) },
      inbox: { list: rec("session.inbox.list", { data: [] }) },
      message: { get: rec("session.message.get", { data: null }) },
    },
    permission: { reply: rec("permission.reply", undefined) },
    message: { list: rec("message.list", { data: messages, cursor: { next: null } }) },
    model: {
      list: rec("model.list", { data: models }),
      default: rec("model.default", () => {
        if (fallback instanceof Error) throw fallback
        return { data: fallback }
      }),
    },
  }
  return { client, calls }
}

function openCodeChat(opts) {
  const { client, calls } = fakeClient(opts)
  const pendingAsked = []
  const chat = new OpenCodeChat({
    client: () => client,
    pending: (id) => (pendingAsked.push(id), [{ id: "per_1", kind: "permission", detail: "Waiting for permission: bash" }]),
  })
  return { chat, calls, pendingAsked }
}

const tokens = (n) => ({ input: n, output: 1, reasoning: 1, cache: { read: 1, write: 1 } })

describe("OpenCodeChat", () => {
  test("send steers, names attachments and marks where their placeholder sits", async () => {
    const { chat, calls } = openCodeChat()
    const text = "see [Image 1] and [PDF 2]"
    const id = await chat.send("ses_a", text, [
      { uri: "data:image/png;base64,AAA", label: "[Image 1]" },
      { uri: "data:application/pdf;base64,BBB", label: "[PDF 2]" },
      { uri: "data:image/jpeg;base64,CCC", label: "[Image 3]" },
      { uri: "data:image/webp;base64,DDD" },
    ])
    assert.equal(id, "msg_1")
    assert.deepEqual(calls, [
      [
        "session.prompt",
        {
          sessionID: "ses_a",
          text,
          delivery: "steer",
          files: [
            { uri: "data:image/png;base64,AAA", name: "photo-1.png", mention: { start: 4, end: 13, text: "[Image 1]" } },
            { uri: "data:application/pdf;base64,BBB", name: "document-2.pdf", mention: { start: 18, end: 25, text: "[PDF 2]" } },
            // Its placeholder isn't in the text, and the last has none: no mention.
            { uri: "data:image/jpeg;base64,CCC", name: "photo-3.jpeg" },
            { uri: "data:image/webp;base64,DDD", name: "photo-4.webp" },
          ],
        },
      ],
    ])
  })

  test("send without attachments sends no files", async () => {
    const { chat, calls } = openCodeChat({ sentID: null })
    assert.equal(await chat.send("ses_a", "hi", []), undefined)
    assert.deepEqual(calls, [["session.prompt", { sessionID: "ses_a", text: "hi", delivery: "steer" }]])
  })

  test("stop, reply and answer go to the session's interrupt, permission and form", async () => {
    const { chat, calls } = openCodeChat()
    assert.equal(await chat.stop("ses_a"), undefined)
    await chat.reply("ses_a", "per_1", "always")
    await chat.answer("ses_a", "frm_1", { pick: "a" })
    await chat.answer("ses_a", "frm_2", null)
    assert.deepEqual(calls, [
      ["session.interrupt", { sessionID: "ses_a" }],
      ["permission.reply", { sessionID: "ses_a", requestID: "per_1", decision: "always" }],
      ["form.reply", { sessionID: "ses_a", formID: "frm_1", answer: { pick: "a" } }],
      ["form.cancel", { sessionID: "ses_a", formID: "frm_2" }],
    ])
  })

  test("pending comes from the service", () => {
    const { chat, pendingAsked } = openCodeChat()
    assert.equal(chat.pending("ses_a")[0].id, "per_1")
    assert.deepEqual(pendingAsked, ["ses_a"])
  })

  test("model: the session's own, else its folder's default, else null", async () => {
    const own = openCodeChat({ session: { model: { providerID: "p", id: "m", variant: "high" } } })
    assert.deepEqual(await own.chat.model.get("ses_a"), { providerID: "p", id: "m", variant: "high" })
    assert.deepEqual(own.calls.map((c) => c[0]), ["session.get"])

    const fallback = openCodeChat({ fallback: { providerID: "p2", id: "m2", extra: 1 } })
    assert.deepEqual(await fallback.chat.model.get("ses_a"), { providerID: "p2", id: "m2" })
    assert.deepEqual(fallback.calls[1], ["model.default", { location: { directory: "/proj" } }])

    assert.equal(await openCodeChat({ fallback: new Error("down") }).chat.model.get("ses_a"), null)
    assert.equal(await openCodeChat({ fallback: null }).chat.model.get("ses_a"), null)
  })

  test("model.set switches the model, with its variant only when there is one", async () => {
    const { chat, calls } = openCodeChat()
    await chat.model.set("ses_a", { providerID: "p", id: "m", variant: "low" })
    await chat.model.set("ses_a", { providerID: "p", id: "m" })
    assert.deepEqual(calls, [
      ["session.switchModel", { sessionID: "ses_a", model: { providerID: "p", id: "m", variant: "low" } }],
      ["session.switchModel", { sessionID: "ses_a", model: { providerID: "p", id: "m" } }],
    ])
  })

  test("stats: cost, and context from the newest assistant message that used tokens", async () => {
    const model = { providerID: "p", id: "m" }
    const { chat, calls } = openCodeChat({
      session: { cost: 1.5 },
      messages: [
        { type: "assistant", model, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        { type: "user" },
        { type: "assistant", model, tokens: tokens(100) },
        { type: "assistant", model, tokens: tokens(1) },
      ],
      models: [{ providerID: "p", id: "m", limit: { context: 200000 } }, { providerID: "p", id: "other", limit: {} }],
    })
    assert.deepEqual(await chat.stats("ses_a"), { cost: 1.5, context: { used: 104, limit: 200000 } })
    assert.deepEqual(calls.find((c) => c[0] === "message.list")[1], { sessionID: "ses_a", limit: 20, order: "desc" })
    // The model list is read once per run, whatever the number of stats.
    await chat.stats("ses_a")
    assert.equal(calls.filter((c) => c[0] === "model.list").length, 1)
  })

  test("stats: no context without a message that used tokens, and no limit for an unknown model", async () => {
    assert.deepEqual(await openCodeChat({ messages: [{ type: "user" }] }).chat.stats("ses_a"), { cost: 0, context: null })
    const unknown = openCodeChat({ messages: [{ type: "assistant", model: { providerID: "x", id: "y" }, tokens: tokens(10) }] })
    assert.deepEqual(await unknown.chat.stats("ses_a"), { cost: 0, context: { used: 14, limit: null } })
  })

  test("page asks for the newest messages, with detail when asked", async () => {
    const { chat, calls } = openCodeChat({ messages: [{ id: "m1", type: "user", time: { created: 1 }, text: "hi" }] })
    const page = await chat.page("ses_a", undefined, true)
    assert.deepEqual(page, { items: [{ id: "m1", kind: "user", time: 1, text: "hi" }], cursor: null })
    assert.deepEqual(calls, [["message.list", { sessionID: "ses_a", limit: 40, order: "desc" }]])
  })

  test("every call fails the same way while opencode isn't connected", async () => {
    const chat = new OpenCodeChat({
      client: () => {
        throw new Error("The opencode service isn't connected")
      },
      pending: () => [],
    })
    await assert.rejects(chat.send("ses_a", "hi", []), /isn't connected/)
    await assert.rejects(chat.stop("ses_a"), /isn't connected/)
    await assert.rejects(chat.stats("ses_a"), /isn't connected/)
  })
})

// ---------- createChat (the router) ----------

/** A harness chat that records calls; `inbox` lists what the session's queue holds, sentID null: send gives no id. */
function fakeHarnessChat({ inbox = [], sentID = "msg_9" } = {}) {
  const calls = []
  const rec = (name, result) => async (...args) => (calls.push([name, ...args]), result)
  return {
    calls,
    chat: {
      page: rec("page", { items: [], cursor: null }),
      pending: (id) => (calls.push(["pending", id]), [{ id: "per_1", kind: "permission", detail: "x" }]),
      send: rec("send", sentID ?? undefined),
      stop: rec("stop", undefined),
      reply: rec("reply", undefined),
      inbox: async (id) => (calls.push(["inbox", id]), inbox),
      answer: rec("answer", undefined),
      image: rec("image", { mime: "image/png", body: Buffer.from("x") }),
      model: { get: rec("model.get", { providerID: "p", id: "m" }), set: rec("model.set", undefined) },
      stats: rec("stats", { cost: 2, context: null }),
    },
  }
}

/**
 * A router over two harnesses: "op:" sessions have `harness` (a chat, maybe background), "tx:" ones have no
 * chat. Scheduled background checks wait in `scheduled` until the test runs them.
 */
function router({ harness, status = "idle", background = true } = {}) {
  const backgrounded = []
  const scheduled = []
  const op = { harness: "opencode", sessions: [], problem: null, chat: harness.chat }
  if (background) op.background = async (id) => void backgrounded.push(id)
  const tx = { harness: "fx", sessions: [], problem: null }
  const chat = createChat({
    source: (id) => (id.startsWith("op:") ? op : id.startsWith("tx:") ? tx : undefined),
    status: () => status,
    title: (id) => `title of ${id}`,
    schedule: (run, ms) => scheduled.push({ run, ms }),
  })
  return { chat, backgrounded, scheduled }
}

describe("createChat", () => {
  test("each call goes to the session's harness", async () => {
    const h = fakeHarnessChat({ inbox: [{ id: "q1", text: "later", images: 0 }] })
    const { chat } = router({ harness: h })
    assert.equal(chat.can("op:1"), true)
    await chat.page("op:1", "cur", true)
    await chat.page("op:1")
    assert.deepEqual(chat.pending("op:1"), [{ id: "per_1", kind: "permission", detail: "x" }])
    assert.deepEqual(await chat.inbox("op:1"), [{ id: "q1", text: "later", images: 0 }])
    await chat.stop("op:1")
    await chat.reply("op:1", "per_1", "once")
    await chat.answer("op:1", "frm_1", null)
    assert.equal((await chat.image("op:1", "m1", 0)).mime, "image/png")
    assert.deepEqual(await chat.model("op:1"), { providerID: "p", id: "m" })
    await chat.setModel("op:1", { providerID: "p", id: "n" })
    assert.deepEqual(await chat.stats("op:1"), { cost: 2, context: null })
    assert.equal(chat.title("op:1"), "title of op:1")
    assert.deepEqual(h.calls, [
      ["page", "op:1", "cur", true],
      ["page", "op:1", undefined, false],
      ["pending", "op:1"],
      ["inbox", "op:1"],
      ["stop", "op:1"],
      ["reply", "op:1", "per_1", "once"],
      ["answer", "op:1", "frm_1", null],
      ["image", "op:1", "m1", 0],
      ["model.get", "op:1"],
      ["model.set", "op:1", { providerID: "p", id: "n" }],
      ["stats", "op:1"],
    ])
  })

  test("a session whose harness has no chat can't open as one", async () => {
    const { chat } = router({ harness: fakeHarnessChat() })
    for (const id of ["tx:1", "unknown"]) {
      assert.equal(chat.can(id), false)
      assert.deepEqual(chat.pending(id), [])
      assert.throws(() => chat.page(id), /can't open as a chat/)
      await assert.rejects(chat.send(id, "hi", []), /can't open as a chat/)
      await assert.rejects(chat.inbox(id), /can't open as a chat/)
      await assert.rejects(chat.stats(id), /can't open as a chat/)
    }
  })

  test("a harness chat that handles only some sessions: the others can't open as one", async () => {
    const h = fakeHarnessChat()
    h.chat.handles = (id) => id === "op:chatty"
    const { chat } = router({ harness: h })
    assert.equal(chat.can("op:chatty"), true)
    assert.equal(chat.can("op:1"), false)
    assert.deepEqual(chat.pending("op:1"), [])
    await assert.rejects(chat.send("op:1", "hi", []), /can't open as a chat/)
    await chat.send("op:chatty", "hi", [])
    assert.deepEqual(h.calls.at(-1), ["send", "op:chatty", "hi", []])
  })

  test("a harness chat without the optional parts gets empty answers", async () => {
    const { page, pending, send, stop, reply } = fakeHarnessChat().chat
    const { chat } = router({ harness: { chat: { page, pending, send, stop, reply } } })
    assert.deepEqual(await chat.inbox("op:1"), [])
    assert.equal(await chat.image("op:1", "m1", 0), null)
    assert.equal(await chat.model("op:1"), null)
    assert.equal(await chat.setModel("op:1", { providerID: "p", id: "m" }), undefined)
    assert.deepEqual(await chat.stats("op:1"), { cost: 0, context: null })
    assert.equal(await chat.answer("op:1", "frm_1", null), undefined)
  })

  test("a message sent mid-turn that still waits after the grace period moves what holds the turn to the background", async () => {
    const h = fakeHarnessChat({ inbox: [{ id: "msg_9", text: "hi", images: 0 }] })
    const { chat, backgrounded, scheduled } = router({ harness: h, status: "running" })
    assert.equal(await chat.send("op:1", "hi", [{ uri: "data:image/png;base64,A" }]), "msg_9")
    assert.deepEqual(h.calls[0], ["send", "op:1", "hi", [{ uri: "data:image/png;base64,A" }]])
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].ms, BACKGROUND_GRACE_MS)
    assert.equal(BACKGROUND_GRACE_MS, 3000)
    assert.deepEqual(backgrounded, [])
    await scheduled[0].run()
    assert.deepEqual(backgrounded, ["op:1"])
  })

  test("a message the agent already read leaves the turn alone", async () => {
    const h = fakeHarnessChat({ inbox: [{ id: "other", text: "x", images: 0 }] })
    const { chat, backgrounded, scheduled } = router({ harness: h, status: "running" })
    await chat.send("op:1", "hi", [])
    await scheduled[0].run()
    assert.deepEqual(h.calls.at(-1), ["inbox", "op:1"])
    assert.deepEqual(backgrounded, [])
  })

  test("no background check for a message that starts a turn, has no id, or a harness that can't move work", async () => {
    const idle = router({ harness: fakeHarnessChat(), status: "idle" })
    await idle.chat.send("op:1", "hi", [])
    assert.equal(idle.scheduled.length, 0)

    const noID = router({ harness: fakeHarnessChat({ sentID: null }), status: "running" })
    assert.equal(await noID.chat.send("op:1", "hi", []), undefined)
    assert.equal(noID.scheduled.length, 0)

    const noBackground = router({ harness: fakeHarnessChat(), status: "running", background: false })
    await noBackground.chat.send("op:1", "hi", [])
    assert.equal(noBackground.scheduled.length, 0)

    const { page, pending, send, stop, reply } = fakeHarnessChat().chat
    const noInbox = router({ harness: { chat: { page, pending, send, stop, reply } }, status: "running" })
    await noInbox.chat.send("op:1", "hi", [])
    assert.equal(noInbox.scheduled.length, 0)
  })

  test("a failed background check is logged, not thrown", async () => {
    const h = fakeHarnessChat()
    h.chat.inbox = async () => {
      throw new Error("gone")
    }
    const { chat, backgrounded, scheduled } = router({ harness: h, status: "running" })
    await chat.send("op:1", "hi", [])
    const errors = []
    const original = console.error
    console.error = (...args) => errors.push(args.join(" "))
    try {
      await scheduled[0].run()
    } finally {
      console.error = original
    }
    assert.deepEqual(backgrounded, [])
    assert.match(errors[0], /moving to the background failed/)
  })
})
