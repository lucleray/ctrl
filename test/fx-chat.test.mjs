// fx sessions as a chat over `fx acp` (src/main/fx-chat.ts), against a fake fx process that speaks ACP.
// Run with `npm test`.
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-fx-chat-test-")
let FxChat

before(async () => {
  ;[{ FxChat }] = await load(tmp, "src/main/fx-chat.ts")
})

const tick = () => new Promise((r) => setImmediate(r))
const until = async (pred, what = "condition") => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * A fake `fx acp`: answers initialize, session/new, session/load (replaying `history`), session/prompt (running
 * `turn(prompt, agent)`), session/set_config_option; records every message in `received`.
 */
function fakeFx({ history = [], turn, busy = false, sessionId = "abc123", config } = {}) {
  const procs = []
  const spawn = (bin, args, opts) => {
    const proc = new EventEmitter()
    proc.stdin = new PassThrough()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.pid = 4000 + procs.length
    proc.args = args
    proc.cwd = opts.cwd
    proc.env = opts.env
    proc.received = []
    proc.killed = false
    proc.kill = () => {
      proc.killed = true
      setImmediate(() => proc.emit("close", null))
    }
    const send = (msg) => proc.stdout.write(JSON.stringify(msg) + "\n")
    proc.update = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
    proc.ask = (id, params) => send({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId, ...params } })
    proc.notify = (method, params) => send({ jsonrpc: "2.0", method, params })
    proc.replies = new Map()
    let buf = ""
    proc.stdin.on("data", (d) => {
      buf += d
      let at
      while ((at = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, at))
        buf = buf.slice(at + 1)
        proc.received.push(msg)
        if (msg.id !== undefined && msg.method === undefined) {
          proc.replies.set(msg.id, msg)
          proc.emit("reply", msg)
          continue
        }
        void handle(msg)
      }
    })
    const configOptions = config ?? [
      { id: "model", currentValue: "anthropic/claude-opus-5.5", options: [] },
      { id: "effort", currentValue: "high", options: [] },
    ]
    async function handle(msg) {
      const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result })
      const fail = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } })
      switch (msg.method) {
        case "initialize":
          return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, _meta: { fx: { steering: true } } } })
        case "session/new":
          return reply({ sessionId, configOptions })
        case "session/load":
          if (busy) return fail(-32603, "Session is busy")
          for (const u of history) proc.update(u)
          return reply({ configOptions })
        case "session/prompt": {
          const result = await turn(msg.params, proc, msg)
          if (result instanceof Error) return fail(result.code ?? -32603, result.message)
          return reply(result ?? { stopReason: "end_turn" })
        }
        case "session/set_config_option":
          for (const c of configOptions) if (c.id === msg.params.configId) c.currentValue = msg.params.value
          return reply({ configOptions })
        case "session/cancel":
          proc.emit("cancel")
          return
        default:
          return fail(-32601, "Method not found")
      }
    }
    procs.push(proc)
    return proc
  }
  return { spawn, procs }
}

const text = (sessionUpdate, t, extra = {}) => ({ sessionUpdate, content: { type: "text", text: t }, ...extra })

function chatWith(fx, { chat = new Set(["fx:abc123"]), directory = tmp, now } = {}) {
  const events = { opened: [], status: [], exited: [], changes: [] }
  let clock = 1000
  const c = new FxChat(
    {
      bin: () => "/bin/fx",
      env: () => ({ FX_HOME: "/tmp/fxhome" }),
      isChat: (id) => chat.has(id),
      directory: (id) => (id === "fx:missing" ? undefined : directory),
      onOpen: (id, proc, cwd, background) => events.opened.push([id, proc.pid, cwd, background]),
      onStatus: (id, status) => events.status.push([id, status?.state ?? null]),
      onExit: (id, code) => events.exited.push([id, code]),
      spawn: fx.spawn,
      now: now ?? (() => clock++),
    },
    "0.37.0",
  )
  c.onChange = (id, modelChanged) => events.changes.push([id, modelChanged])
  return { chat: c, events }
}

describe("FxChat processes", () => {
  test("opening a session starts `fx acp`, initializes as ctrl, loads the session and replays it", async () => {
    const fx = fakeFx({ history: [text("user_message_chunk", "hi", { messageId: "m1" }), text("agent_message_chunk", "hello", { messageId: "m2" })] })
    const { chat, events } = chatWith(fx)
    const page = await chat.page("fx:abc123")
    const proc = fx.procs[0]
    assert.deepEqual(proc.args, ["acp"])
    assert.deepEqual([proc.cwd, proc.env], [tmp, { FX_HOME: "/tmp/fxhome" }])
    assert.deepEqual(
      proc.received.map((m) => m.method),
      ["initialize", "session/load"],
    )
    assert.deepEqual(proc.received[0].params.clientInfo, { name: "ctrl", version: "0.37.0" })
    assert.deepEqual(proc.received[0].params.clientCapabilities.session, { notices: true })
    assert.deepEqual(proc.received[1].params, { sessionId: "abc123", cwd: tmp, mcpServers: [] })
    assert.deepEqual(
      page.items.map((i) => [i.kind, i.kind === "user" ? i.text : [i.live, i.parts[0].text]]),
      [
        ["user", "hi"],
        ["assistant", [false, "hello"]],
      ],
    )
    assert.deepEqual(events.opened, [["fx:abc123", 4000, tmp, false]])
    assert.deepEqual(chat.sessions(), ["fx:abc123"])
    assert.deepEqual(chat.pids(), [4000])
    // A second read reuses the process.
    await chat.page("fx:abc123")
    assert.equal(fx.procs.length, 1)
  })

  test("handles says which fx sessions are chat ones", () => {
    const { chat } = chatWith(fakeFx(), { chat: new Set(["fx:a"]) })
    assert.equal(chat.handles("fx:a"), true)
    assert.equal(chat.handles("fx:b"), false)
  })

  test("a session fx holds elsewhere fails to open and its process is stopped; an unknown one fails at once", async () => {
    const fx = fakeFx({ busy: true })
    const { chat, events } = chatWith(fx)
    await assert.rejects(chat.page("fx:abc123"), /open in fx elsewhere/)
    await until(() => events.exited.length === 1, "exit")
    assert.equal(fx.procs[0].killed, true)
    assert.deepEqual(chat.sessions(), [])
    await assert.rejects(chat.page("fx:missing"), /doesn't exist anymore/)
    assert.equal(fx.procs.length, 1)
  })

  test("create: a new session with the model as process flags and the instructions as the system prompt", async () => {
    const fx = fakeFx({ sessionId: "new1" })
    const { chat, events } = chatWith(fx)
    const id = await chat.create({ cwd: tmp, model: { providerID: "fx", id: "anthropic/claude-opus-5.5", variant: "high" }, instructions: "  Be brief. " })
    assert.equal(id, "fx:new1")
    const proc = fx.procs[0]
    assert.deepEqual(proc.args, ["acp", "--model", "anthropic/claude-opus-5.5", "--effort", "high"])
    assert.deepEqual(proc.received[1], {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: tmp, mcpServers: [], systemPrompt: [{ type: "text", text: "Be brief." }] },
    })
    assert.deepEqual(events.opened, [["fx:new1", 4000, tmp, false]])
    assert.deepEqual(chat.sessions(), ["fx:new1"])
    assert.deepEqual(await chat.model.get("fx:new1"), { providerID: "fx", id: "anthropic/claude-opus-5.5", variant: "high" })

    const plain = await chatWith(fakeFx({ sessionId: "new2" })).chat.create({ cwd: tmp })
    assert.equal(plain, "fx:new2")
  })

  test("close stops the process; the process going away clears the session", async () => {
    const fx = fakeFx()
    const { chat, events } = chatWith(fx)
    await chat.page("fx:abc123")
    chat.close("fx:abc123")
    await until(() => events.exited.length === 1, "exit")
    assert.deepEqual(events.exited, [["fx:abc123", null]])
    assert.deepEqual(chat.sessions(), [])
    assert.equal(chat.status("fx:abc123"), undefined)
    // Opening again starts a new one.
    await chat.page("fx:abc123")
    assert.equal(fx.procs.length, 2)
  })

  test("without fx there's no process", async () => {
    const { chat } = chatWith(fakeFx())
    chat["deps"].bin = () => undefined
    await assert.rejects(chat.page("fx:abc123"), /fx isn't installed/)
  })
})

describe("FxChat turns", () => {
  test("send: the prompt shows at once, the reply streams, the turn ends with the response", async () => {
    let release
    const fx = fakeFx({
      turn: async (params, proc) => {
        proc.update(text("agent_thought_chunk", "thinking"))
        proc.update(text("agent_message_chunk", "Sure, ", { messageId: "r1" }))
        await new Promise((r) => (release = r))
        proc.update(text("agent_message_chunk", "done.", { messageId: "r1" }))
        return { stopReason: "end_turn" }
      },
    })
    const { chat, events } = chatWith(fx)
    const id = await chat.send("fx:abc123", "Do it", [])
    assert.equal(id, "u1")
    await until(() => fx.procs[0].received.some((m) => m.method === "session/prompt"), "prompt")
    assert.deepEqual(fx.procs[0].received.at(-1).params, { sessionId: "abc123", prompt: [{ type: "text", text: "Do it" }] })
    await until(() => events.changes.length >= 3, "updates")
    let page = await chat.page("fx:abc123", undefined, true)
    assert.deepEqual(page.items[0], { id: "u1", kind: "user", time: 1000, text: "Do it" })
    assert.deepEqual(page.items[1].live, true)
    assert.deepEqual(page.items[1].parts, [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "Sure, " },
    ])
    assert.deepEqual(events.status.at(-1), ["fx:abc123", "working"])
    release()
    await until(() => events.status.at(-1)?.[1] === "done", "turn end")
    page = await chat.page("fx:abc123")
    assert.equal(page.items[1].live, false)
    assert.equal(page.items[1].parts[1].text, "Sure, done.")
    assert.deepEqual(await chat.inbox("fx:abc123"), [])
  })

  test("images go inline with the prompt and are kept for the chat", async () => {
    const fx = fakeFx({ turn: async () => ({ stopReason: "end_turn" }) })
    const { chat } = chatWith(fx)
    const png = Buffer.from("img").toString("base64")
    await chat.send("fx:abc123", "see [Image 1]", [{ uri: `data:image/png;base64,${png}`, label: "[Image 1]" }, { uri: "data:application/pdf;base64,UERG" }])
    const prompt = fx.procs[0].received.find((m) => m.method === "session/prompt")
    assert.deepEqual(prompt.params.prompt, [
      { type: "text", text: "see [Image 1]" },
      { type: "image", data: png, mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///document-2.pdf", mimeType: "application/pdf", blob: "UERG" } },
    ])
    const page = await chat.page("fx:abc123")
    assert.equal(page.items[0].images, 1)
    const image = await chat.image("fx:abc123", "u1", 0)
    assert.deepEqual([image.mime, image.body.toString()], ["image/png", "img"])
    assert.equal(await chat.image("fx:abc123", "u1", 1), null)
  })

  test("a message sent mid-turn steers: it waits in the inbox until fx takes it, then shows as a message", async () => {
    let endTurn
    const fx = fakeFx({
      turn: async (params, proc, msg) => {
        if (params._meta?.fx?.steer) {
          // fx takes the steer at its next step: it echoes it, and the steer request completes with the turn.
          await new Promise((r) => proc.once("take", r))
          proc.update(text("user_message_chunk", params.prompt[0].text, { messageId: "s1", _meta: { fx: { steering: { requestId: msg.id } } } }))
          proc.update(text("agent_message_chunk", "BANANA", { messageId: "r2" }))
          return { stopReason: "end_turn", _meta: { fx: { steering: "absorbed" } } }
        }
        proc.update(text("agent_message_chunk", "working…", { messageId: "r1" }))
        await new Promise((r) => (endTurn = r))
        return { stopReason: "end_turn" }
      },
    })
    const { chat, events } = chatWith(fx)
    await chat.send("fx:abc123", "go", [])
    await until(() => endTurn, "turn started")
    const steerID = await chat.send("fx:abc123", "end with BANANA", [])
    assert.match(steerID, /^steer_/)
    assert.deepEqual(await chat.inbox("fx:abc123"), [{ id: steerID, text: "end with BANANA", images: 0 }])
    await until(() => fx.procs[0].received.filter((m) => m.method === "session/prompt").length === 2, "steer sent")
    const steer = fx.procs[0].received.filter((m) => m.method === "session/prompt")[1]
    assert.deepEqual(steer.params._meta, { fx: { steer: true } })
    fx.procs[0].emit("take")
    await until(() => events.changes.length >= 5, "steer echoed")
    assert.deepEqual(await chat.inbox("fx:abc123"), [])
    const page = await chat.page("fx:abc123")
    assert.deepEqual(
      page.items.map((i) => (i.kind === "user" ? i.text : i.parts[0].text)),
      ["go", "working…", "end with BANANA", "BANANA"],
    )
    endTurn()
    await until(() => events.status.at(-1)?.[1] === "done", "turn end")
  })

  test("a steer the turn didn't take goes as the next prompt; a message with an image waits for the turn", async () => {
    let endTurn
    const prompts = []
    const fx = fakeFx({
      turn: async (params) => {
        prompts.push(params)
        if (params._meta?.fx?.steer) return Object.assign(new Error("Prompt is not in progress"), { code: -32600 })
        if (prompts.length === 1) await new Promise((r) => (endTurn = r))
        return { stopReason: "end_turn" }
      },
    })
    const { chat } = chatWith(fx)
    await chat.send("fx:abc123", "first", [])
    await until(() => endTurn, "turn started")
    const queued = chat.send("fx:abc123", "with image", [{ uri: "data:image/png;base64,AA" }])
    await chat.send("fx:abc123", "late steer", [])
    await until(() => prompts.length === 2, "steer refused")
    endTurn()
    await queued
    await until(() => prompts.length === 4, "both sent as prompts")
    assert.deepEqual(
      prompts.map((p) => [p.prompt[0].text, !!p._meta?.fx?.steer]),
      [
        ["first", false],
        ["late steer", true],
        // Both waited for the turn; the message with the image was first in line.
        ["with image", false],
        ["late steer", false],
      ],
    )
  })

  test("stop cancels the turn; a failed turn keeps fx's error on the reply", async () => {
    const fx = fakeFx({
      turn: (params, proc) =>
        new Promise((resolve) => {
          if (params.prompt[0].text === "fail") return resolve(Object.assign(new Error("HTTP error 400"), { code: -32603 }))
          proc.update(text("agent_message_chunk", "partial", { messageId: "r1" }))
          proc.once("cancel", () => resolve({ stopReason: "cancelled" }))
        }),
    })
    const { chat, events } = chatWith(fx)
    await chat.send("fx:abc123", "long", [])
    await until(() => events.changes.length >= 2, "streaming")
    await chat.stop("fx:abc123")
    assert.deepEqual(fx.procs[0].received.at(-1), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "abc123" } })
    await until(() => events.status.at(-1)?.[1] === "done", "cancelled")
    let page = await chat.page("fx:abc123")
    assert.deepEqual([page.items[1].live, page.items[1].parts[0].text, page.items[1].error], [false, "partial", undefined])
    await chat.send("fx:abc123", "fail", [])
    await until(() => events.status.at(-1)?.[1] === "error", "failed")
    page = await chat.page("fx:abc123")
    assert.deepEqual([page.items[3].live, page.items[3].error], [false, "HTTP error 400"])
    // Stop with no turn running does nothing.
    await chat.stop("fx:abc123")
  })

  test("permission requests wait on the chat: pending, blocked status, answered with the matching option", async () => {
    const fx = fakeFx({
      turn: (params, proc) =>
        new Promise((resolve) => {
          proc.ask("p1", {
            toolCall: { toolCallId: "tc1", name: "shell", title: "shell.run rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
            options: [
              { optionId: "allow_once", kind: "allow_once" },
              { optionId: "allow_always", kind: "allow_always" },
              { optionId: "reject_once", kind: "reject_once" },
            ],
          })
          proc.once("reply", (msg) => {
            proc.update(text("agent_message_chunk", `got ${msg.result.outcome.optionId}`, { messageId: "r1" }))
            resolve({ stopReason: "end_turn" })
          })
        }),
    })
    const { chat, events } = chatWith(fx)
    await chat.send("fx:abc123", "clean", [])
    await until(() => chat.pending("fx:abc123").length === 1, "permission")
    const [pending] = chat.pending("fx:abc123")
    assert.deepEqual(pending, { id: pending.id, kind: "permission", detail: "Waiting for permission: shell.run rm -rf build" })
    assert.deepEqual(events.status.at(-1), ["fx:abc123", "blocked"])
    assert.equal(chat.status("fx:abc123").msg, "Waiting for permission: shell.run rm -rf build")
    await chat.reply("fx:abc123", pending.id, "always")
    assert.deepEqual(chat.pending("fx:abc123"), [])
    await until(() => fx.procs[0].replies.has("p1"), "reply")
    assert.deepEqual(fx.procs[0].replies.get("p1"), { jsonrpc: "2.0", id: "p1", result: { outcome: { outcome: "selected", optionId: "allow_always" } } })
    await until(() => events.status.at(-1)?.[1] === "done", "turn end")
    assert.equal((await chat.page("fx:abc123")).items[1].parts[0].text, "got allow_always")
    // An unknown request id is ignored.
    await chat.reply("fx:abc123", "nope", "once")
  })

  test("a permission fx withdraws, or one left when the turn ends, is cancelled; reject picks the reject option", async () => {
    const fx = fakeFx({
      turn: (params, proc) =>
        new Promise((resolve) => {
          const id = `p_${params.prompt[0].text}`
          proc.ask(id, { toolCall: { title: "a" }, options: [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] })
          if (params.prompt[0].text === "withdraw") {
            setImmediate(() => {
              proc.notify("$/cancel_request", { requestId: id })
              proc.once("reply", () => resolve({ stopReason: "cancelled" }))
            })
          } else proc.once("reply", () => resolve({ stopReason: "end_turn" }))
        }),
    })
    const { chat, events } = chatWith(fx)
    await chat.send("fx:abc123", "withdraw", [])
    await until(() => fx.procs[0].replies.has("p_withdraw"), "cancelled reply")
    assert.deepEqual(fx.procs[0].replies.get("p_withdraw").result, { outcome: { outcome: "cancelled" } })
    assert.deepEqual(chat.pending("fx:abc123"), [])
    await until(() => events.status.at(-1)?.[1] === "done", "turn end")

    await chat.send("fx:abc123", "ask", [])
    await until(() => chat.pending("fx:abc123").length === 1, "permission")
    await chat.reply("fx:abc123", chat.pending("fx:abc123")[0].id, "reject")
    await until(() => fx.procs[0].replies.has("p_ask"), "reply")
    assert.deepEqual(fx.procs[0].replies.get("p_ask").result, { outcome: { outcome: "selected", optionId: "no" } })
  })

  test("the process dying mid-turn ends the reply with the error and clears the session", async () => {
    const fx = fakeFx({ turn: () => new Promise(() => {}) })
    const { chat, events } = chatWith(fx)
    await chat.send("fx:abc123", "go", [])
    fx.procs[0].emit("close", 137)
    await until(() => events.exited.length === 1, "exit")
    assert.deepEqual(events.exited, [["fx:abc123", 137]])
    assert.deepEqual(chat.sessions(), [])
    assert.equal(chat.status("fx:abc123"), undefined)
  })

  test("model: read from fx's config options, set through set_config_option; stats from usage updates", async () => {
    const fx = fakeFx({ turn: async (p, proc) => (proc.update({ sessionUpdate: "usage_update", used: 1200, size: 200000 }), { stopReason: "end_turn" }) })
    const { chat, events } = chatWith(fx)
    assert.equal(await chat.model.get("fx:abc123"), null)
    assert.deepEqual(await chat.stats("fx:abc123"), { cost: 0, context: null })
    await chat.page("fx:abc123")
    assert.deepEqual(await chat.model.get("fx:abc123"), { providerID: "fx", id: "anthropic/claude-opus-5.5", variant: "high" })
    await chat.model.set("fx:abc123", { providerID: "fx", id: "anthropic/claude-sonnet-5.5", variant: "low" })
    assert.deepEqual(
      fx.procs[0].received.filter((m) => m.method === "session/set_config_option").map((m) => m.params),
      [
        { sessionId: "abc123", configId: "model", value: "anthropic/claude-sonnet-5.5" },
        { sessionId: "abc123", configId: "effort", value: "low" },
      ],
    )
    assert.deepEqual(await chat.model.get("fx:abc123"), { providerID: "fx", id: "anthropic/claude-sonnet-5.5", variant: "low" })
    assert.deepEqual(events.changes.at(-1), ["fx:abc123", true])
    await chat.send("fx:abc123", "x", [])
    await until(() => events.status.at(-1)?.[1] === "done", "turn end")
    assert.deepEqual(await chat.stats("fx:abc123"), { cost: 0, context: { used: 1200, limit: 200000 } })
  })
})
