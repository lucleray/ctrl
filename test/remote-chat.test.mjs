// opencode messages as a chat (src/main/remote-chat.ts), for the phone and the desktop chat view, against
// a fake opencode client. Run with `npm test`.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-chat-test-")
let chatPage, chatInbox, chatImage

before(async () => {
  ;[{ chatPage, chatInbox, chatImage }] = await load(tmp, "src/main/remote-chat.ts")
})

const t = (created, completed) => ({ created, ...(completed ? { completed } : {}) })
const png = { mime: "image/png", data: Buffer.from("img").toString("base64") }

/** A client whose message.list returns these messages (newest first, like order: "desc") and records its calls. */
function fakeClient(messages, { next = null, inbox = [] } = {}) {
  const calls = []
  return {
    calls,
    message: { list: async (q) => (calls.push(q), { data: messages, cursor: { next } }) },
    session: {
      inbox: { list: async () => ({ data: inbox }) },
      message: { get: async ({ messageID }) => ({ data: messages.find((m) => m.id === messageID) }) },
    },
  }
}

const tool = (name, input, status, extra = {}) => ({ type: "tool", name, state: { status, input, ...extra } })

const MESSAGES = [
  {
    id: "m4",
    type: "assistant",
    time: t(4),
    content: [
      { type: "reasoning", text: "first" },
      { type: "reasoning", text: "second" },
      { type: "text", text: "Here goes" },
      tool("bash", { description: "Run the tests", command: "npm test\n  --watch" }, "completed"),
      tool("bash", JSON.stringify({ command: "sleep 100" }), "completed", { metadata: { status: "running" } }),
      tool("read", { filePath: "/a/b.ts" }, "error"),
      tool("task", { prompt: "x".repeat(200) }, "running"),
    ],
  },
  { id: "m3", type: "synthetic", time: t(3), metadata: { source: "shell", state: "completed", exit: 1 }, description: "npm run build" },
  { id: "m3b", type: "synthetic", time: t(3), metadata: { source: "instructions" } },
  { id: "m2", type: "assistant", time: t(2, 2), content: [{ type: "text", text: "  " }] },
  { id: "m1", type: "user", time: t(1), text: "look", files: [png, { mime: "text/plain", data: "x" }] },
  { id: "m0", type: "user", time: t(0), text: " " },
]

describe("chatPage", () => {
  test("oldest first; empty and internal messages left out", async () => {
    const page = await chatPage(fakeClient(MESSAGES), "ses_a")
    assert.deepEqual(
      page.items.map((i) => [i.id, i.kind]),
      [
        ["m1", "user"],
        ["m3", "note"],
        ["m4", "assistant"],
      ],
    )
    assert.equal(page.items[0].images, 1)
    assert.deepEqual(page.items[1], { id: "m3", kind: "note", time: 3, source: "shell", outcome: "failed", text: "npm run build" })
  })

  test("parts: one thinking marker, tool statuses and summaries", async () => {
    const { items } = await chatPage(fakeClient(MESSAGES), "ses_a")
    const m4 = items.at(-1)
    assert.equal(m4.live, true)
    assert.deepEqual(
      m4.parts.map((p) => [p.type, p.status ?? "", p.summary ?? p.text ?? ""]),
      [
        ["reasoning", "", ""],
        ["text", "", "Here goes"],
        ["tool", "done", "Run the tests"],
        ["tool", "background", "sleep 100"],
        ["tool", "error", "/a/b.ts"],
        ["tool", "running", "x".repeat(139) + "…"],
      ],
    )
    assert.equal(m4.parts[2].command, undefined, "the phone gets no detail")
  })

  test("detail adds thinking text and full commands, for the desktop", async () => {
    const { items } = await chatPage(fakeClient(MESSAGES), "ses_a", undefined, true)
    const parts = items.at(-1).parts
    assert.equal(parts[0].text, "first\n\nsecond")
    assert.equal(parts[2].command, "npm test\n  --watch")
    assert.equal(parts[5].detail, "x".repeat(200))
  })

  test("a short first page has no cursor; a cursor asks for the page before it", async () => {
    const client = fakeClient(MESSAGES, { next: "c1" })
    assert.equal((await chatPage(client, "ses_a")).cursor, null)
    assert.deepEqual(client.calls[0], { sessionID: "ses_a", limit: 40, order: "desc" })
    const full = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, type: "user", time: t(i), text: "hi" }))
    assert.equal((await chatPage(fakeClient(full, { next: "c1" }), "ses_a")).cursor, "c1")
    await chatPage(client, "ses_a", "c0")
    assert.deepEqual(client.calls[1], { sessionID: "ses_a", cursor: "c0" })
  })

  test("stopped background work and failed turns", async () => {
    const { items } = await chatPage(
      fakeClient([
        { id: "a", type: "assistant", time: t(2, 3), error: { message: "Rate limited" }, content: [] },
        { id: "n", type: "synthetic", time: t(1), metadata: { source: "subagent", state: "cancelled" }, description: "review" },
      ]),
      "ses_a",
    )
    assert.equal(items[0].outcome, "stopped")
    assert.equal(items[1].error, "Rate limited")
  })
})

describe("inbox and images", () => {
  test("queued messages oldest first, with their image count", async () => {
    const inbox = [
      { id: 2, type: "user", time: { created: 2 }, payload: { text: "b", files: [png, png] } },
      { id: 1, type: "user", time: { created: 1 }, payload: { text: "a" } },
      { id: 3, type: "other", time: { created: 0 } },
    ]
    assert.deepEqual(await chatInbox(fakeClient([], { inbox }), "ses_a"), [
      { id: "1", text: "a", images: 0 },
      { id: "2", text: "b", images: 2 },
    ])
  })

  test("the index-th image of a message you sent, or null", async () => {
    const client = fakeClient(MESSAGES)
    const img = await chatImage(client, "ses_a", "m1", 0)
    assert.equal(img.mime, "image/png")
    assert.equal(img.body.toString(), "img")
    assert.equal(await chatImage(client, "ses_a", "m1", 1), null)
    assert.equal(await chatImage(client, "ses_a", "m4", 0), null)
  })
})
