// Watched tools (src/main/tools): the shared alert logic, CLI checks, and the `ctrl tools` handlers.
import * as esbuild from "esbuild"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"

const tmp = mkdtempSync(join(tmpdir(), "ctrl-tools-test-"))
let ToolAlerts, CliTools, createHandlers

const load = async (entry) => {
  const outfile = join(tmp, entry.replace(/\W/g, "_") + ".cjs")
  await esbuild.build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "cjs", logLevel: "warning" })
  return createRequire(import.meta.url)(outfile)
}

before(async () => {
  ;({ ToolAlerts } = await load("src/main/tools/alerts.ts"))
  ;({ CliTools } = await load("src/main/tools/cli.ts"))
  ;({ createHandlers } = await load("src/main/cli-handlers.ts"))
})

after(() => rmSync(tmp, { recursive: true, force: true }))

const tool = (state, detail, id = "cli:aws") => ({ id, kind: "cli", name: "AWS", state, detail, fix: "command", label: "Log in" })

describe("ToolAlerts", () => {
  const setup = () => {
    const events = []
    let n = 0
    const fixed = []
    const alerts = new ToolAlerts(
      {
        toast: (message, action) => (events.push(["toast", message, action.label]), `t${++n}`),
        dismiss: (id) => events.push(["dismiss", id]),
      },
      (id) => fixed.push(id),
    )
    return { alerts, events, fixed }
  }

  test("toasts once per failure, replaces it when the error changes, clears it on recovery", () => {
    const { alerts, events } = setup()
    alerts.sync([tool("ok")])
    alerts.sync([tool("broken", "expired")])
    alerts.sync([tool("broken", "expired")])
    alerts.sync([tool("checking")])
    alerts.sync([tool("broken", "other")])
    alerts.sync([tool("ok")])
    assert.deepEqual(events, [
      ["toast", "“AWS” stopped working: expired", "Log in"],
      ["dismiss", "t1"],
      ["toast", "“AWS” stopped working: other", "Log in"],
      ["dismiss", "t2"],
    ])
  })

  test("MCP wording, tools that go away, and forget() re-toasting the same error", () => {
    const { alerts, events } = setup()
    const mcp = { id: "mcp:linear", kind: "mcp", name: "linear", state: "needs-auth", detail: "401", fix: "session", label: "Fix" }
    alerts.sync([mcp, tool("missing", "aws isn't installed")])
    alerts.forget("cli:aws")
    alerts.sync([mcp, tool("missing", "aws isn't installed")])
    alerts.sync([])
    assert.deepEqual(events, [
      ["toast", "MCP “linear” needs sign-in: 401", "Fix"],
      ["toast", "“AWS” isn't installed: aws isn't installed", "Log in"],
      ["dismiss", "t2"],
      ["toast", "“AWS” isn't installed: aws isn't installed", "Log in"],
      ["dismiss", "t1"],
      ["dismiss", "t3"],
    ])
  })
})

describe("CliTools", () => {
  test("exit 0 is ok, other codes broken with the last line, 127 missing; fix commands recheck", async () => {
    const tools = new CliTools(() => {})
    const flag = join(tmp, "logged-in")
    tools.configure([
      { id: "ok", name: "OK", check: "echo fine", fix: { kind: "session" } },
      { id: "bad", name: "Bad", check: "echo noise; echo 'token expired' >&2; exit 3", fix: { kind: "url", url: "https://x" } },
      { id: "gone", name: "Gone", check: "definitely-not-a-cli-xyz --version", fix: { kind: "session" } },
      { id: "login", name: "Login", check: `test -f ${flag}`, fix: { kind: "command", command: `touch ${flag}` }, label: "Log in" },
    ])
    assert.deepEqual(tools.items().map((t) => t.state), ["checking", "checking", "checking", "checking"])
    await tools.check()
    const byID = Object.fromEntries(tools.items().map((t) => [t.id, t]))
    assert.equal(byID["cli:ok"].state, "ok")
    assert.equal(byID["cli:bad"].state, "broken")
    assert.equal(byID["cli:bad"].detail, "token expired")
    assert.equal(byID["cli:bad"].label, "Open")
    assert.equal(byID["cli:gone"].state, "missing")
    assert.equal(byID["cli:login"].state, "broken")
    assert.deepEqual(await tools.runFix("login"), { ok: true, detail: undefined })
    assert.equal(tools.items().find((t) => t.id === "cli:login").state, "ok")
    tools.configure([])
    assert.deepEqual(tools.items(), [])
  })
})

describe("tools handlers", () => {
  const fakeHost = () => {
    const data = { settings: { cliTools: [] } }
    const checked = []
    const host = {
      store: { data },
      mcp: () => [{ name: "linear", status: "connected" }],
      reconnectMcp: async (name) => checked.push(`mcp:${name}`),
      tools: () => [
        { id: "mcp:linear", kind: "mcp", name: "linear", state: "ok", fix: "session", label: "Fix" },
        ...data.settings.cliTools.map((c) => ({ id: `cli:${c.id}`, kind: "cli", name: c.name, state: "ok", check: c.check, fix: c.fix.kind, label: "Run" })),
      ],
      checkTools: async (ids) => checked.push(ids ?? "all"),
      setCliTools: (configs) => (data.settings.cliTools = configs),
    }
    return { host, data, checked }
  }
  const call = (handlers, command, args) => handlers[command](args, { v: 1, command, args, caller: {} }, {})

  test("add, list, check and remove", async () => {
    const { host, data, checked } = fakeHost()
    const h = createHandlers(host)
    const added = await call(h, "tools add", {
      name: "AWS (vercel)",
      check: "aws sts get-caller-identity --profile vercel",
      "fix-command": "aws sso login --profile vercel",
      label: "Log in",
    })
    assert.equal(added.id, "cli:aws-vercel")
    assert.deepEqual(data.settings.cliTools[0].fix, { kind: "command", command: "aws sso login --profile vercel" })
    assert.deepEqual(checked, [["aws-vercel"]])
    await assert.rejects(call(h, "tools add", { name: "AWS (vercel)", check: "x", "fix-session": true, id: "aws-vercel" }), { code: "CONFLICT" })
    await assert.rejects(call(h, "tools add", { name: "x", check: "x" }), { code: "USAGE" })
    await assert.rejects(call(h, "tools add", { name: "x", check: "x", "fix-url": "https://a", "fix-session": true }), { code: "USAGE" })
    assert.deepEqual(call(h, "tools list", {}).items.map((t) => t.id), ["mcp:linear", "cli:aws-vercel"])
    await call(h, "tools check", { id: ["aws-vercel", "linear"] })
    assert.deepEqual(checked.slice(1), ["mcp:linear", ["aws-vercel"]])
    await call(h, "tools check", {})
    assert.equal(checked.at(-1), "all")
    assert.throws(() => call(h, "tools remove", { id: "linear" }), { code: "USAGE" })
    assert.deepEqual(call(h, "tools remove", { id: "aws-vercel" }), { id: "cli:aws-vercel", changed: true })
    assert.deepEqual(data.settings.cliTools, [])
  })
})
