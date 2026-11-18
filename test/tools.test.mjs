// Watched tools (src/main/tools): alerts, CLI checks, detection, the tools.json file, the service that
// ties them to the harnesses, and the `ctrl tools` handlers.
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-tools-test-")
let ToolAlerts, CliTools, createHandlers, detect, awsChecks, fxMcpConfigs, parseTools, ToolsService

before(async () => {
  ;[{ ToolAlerts }, { CliTools }, { detect, awsChecks, fxMcpConfigs }, { parseTools }, { ToolsService }, { createHandlers }] = await load(
    tmp,
    "src/main/tools/alerts.ts",
    "src/main/tools/cli.ts",
    "src/main/tools/detect.ts",
    "src/main/tools/config.ts",
    "src/main/tools/service.ts",
    "src/main/cli-handlers.ts",
  )
})

const fakeUi = () => {
  const events = []
  let n = 0
  return {
    events,
    ui: {
      toast: (message, action) => (events.push(["toast", message, action.label]), `t${++n}`),
      dismiss: (id) => events.push(["dismiss", id]),
    },
  }
}

describe("ToolAlerts", () => {
  test("one toast per problem: raised once, replaced when its key changes, held while settling, cleared when gone", () => {
    const { ui, events } = fakeUi()
    const alerts = new ToolAlerts(ui, () => {})
    const a = (key, extra = {}) => ({ id: "cli:aws", key, message: `aws ${key}`, label: "Log in", ...extra })
    alerts.sync([])
    alerts.sync([a("expired")])
    alerts.sync([a("expired")])
    alerts.sync([a("", { hold: true })])
    alerts.sync([a("other")])
    alerts.forget("cli:aws")
    alerts.sync([a("other")])
    alerts.sync([])
    assert.deepEqual(events, [
      ["toast", "aws expired", "Log in"],
      ["dismiss", "t1"],
      ["toast", "aws other", "Log in"],
      ["dismiss", "t2"],
      ["toast", "aws other", "Log in"],
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
    await tools.check()
    const byID = Object.fromEntries(tools.items().map((t) => [t.id, t]))
    assert.equal(byID["cli:ok"].state, "ok")
    assert.equal(byID["cli:bad"].state, "broken")
    assert.equal(byID["cli:bad"].detail, "token expired")
    assert.equal(byID["cli:bad"].label, "Open")
    assert.equal(byID["cli:gone"].state, "missing")
    assert.deepEqual(await tools.runFix("login"), { ok: true, detail: undefined })
    assert.equal(tools.items().find((t) => t.id === "cli:login").state, "ok")
  })
})

describe("detection", () => {
  test("AWS: one check per SSO session (profile named like it, else its first), plus old-style SSO profiles", () => {
    const checks = awsChecks(`
[profile vc-read]
sso_session = vercel
[profile vercel]
sso_session = vercel
[profile dev admin]
sso_session = iso
[profile static]
region = us-east-1
[profile legacy]
sso_start_url = https://x.awsapps.com/start
[sso-session vercel]
sso_start_url = https://a
[sso-session iso]
sso_start_url = https://b
[sso-session unused]
sso_start_url = https://c
`)
    assert.deepEqual(
      checks.map((c) => [c.key, c.check, c.fix.command]),
      [
        ["aws:sso:vercel", "aws sts get-caller-identity --profile vercel", "aws sso login --sso-session vercel"],
        ["aws:sso:iso", "aws sts get-caller-identity --profile 'dev admin'", "aws sso login --sso-session iso"],
        ["aws:profile:legacy", "aws sts get-caller-identity --profile legacy", "aws sso login --profile legacy"],
      ],
    )
  })

  test("reads fx's mcp.json in opencode's mcp shape too (what kit setup writes)", () => {
    const fxHome = join(tmp, "fx-home-mcp")
    mkdirSync(fxHome, { recursive: true })
    writeFileSync(
      join(fxHome, "mcp.json"),
      JSON.stringify({
        mcp: {
          kit: { type: "local", command: ["kit", "mcp"], enabled: true, environment: { V: "1" } },
          off: { type: "remote", url: "https://off", enabled: false },
          r: { type: "remote", url: "https://r", headers: { H: "x" } },
        },
        mcpServers: { kit: { url: "https://dup" }, other: { url: "https://o" } },
      }),
    )
    assert.deepEqual(fxMcpConfigs(fxHome), [
      { name: "kit", type: "local", command: ["kit", "mcp"], env: { V: "1" } },
      { name: "r", type: "remote", url: "https://r", headers: { H: "x" } },
      { name: "other", type: "remote", url: "https://o" },
    ])
  })

  test("merges MCP servers across harnesses by name, finds CLIs on PATH only", async () => {
    const fxHome = join(tmp, "fx-home")
    mkdirSync(fxHome, { recursive: true })
    writeFileSync(
      join(fxHome, "mcp.json"),
      JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, local: { command: "node", args: ["s.js"], env: { A: "1" } } } }),
    )
    assert.deepEqual(fxMcpConfigs(fxHome)[1], { name: "local", type: "local", command: ["node", "s.js"], env: { A: "1" } })
    const bin = join(tmp, "bin")
    mkdirSync(bin, { recursive: true })
    for (const b of ["gh", "pup"]) (writeFileSync(join(bin, b), "#!/bin/sh\n"), chmodSync(join(bin, b), 0o755))
    const d = await detect({
      opencode: async () => [{ name: "linear", type: "remote", url: "https://mcp.linear.app/mcp" }, { name: "notion", type: "remote", url: "https://n" }],
      fxHome,
      home: tmp,
      path: bin,
    })
    assert.deepEqual(d.mcp.map((m) => [m.config.name, m.from]), [["linear", ["opencode", "fx"]], ["notion", ["opencode"]], ["local", ["fx"]]])
    assert.deepEqual(d.cli.map((c) => c.key), ["gh", "pup"])
  })
})

describe("tools.json", () => {
  test("keeps the entries it can read, drops broken ones", () => {
    const config = parseTools(
      JSON.stringify({
        mcp: [{ name: "a", type: "remote", url: "https://a" }, { name: "b", type: "local" }, "junk"],
        cli: [{ id: "x", name: "X", check: "true", fix: { kind: "session" } }, { id: "y", name: "Y", check: "true", fix: { kind: "url", url: "ftp://" } }],
      }),
    )
    assert.deepEqual(config.mcp.map((s) => s.name), ["a"])
    assert.deepEqual(config.cli.map((c) => c.id), ["x"])
  })
})

/** A ToolsService on a temp tools.json, with fake harnesses. */
const service = ({ opencodeServers = [], fxActive = false, fxInstalled = false } = {}) => {
  const file = join(mkdtempSync(join(tmp, "svc-")), "tools.json")
  const { ui, events } = fakeUi()
  const calls = []
  const host = {
    opencode: {
      active: () => true,
      servers: () => opencodeServers,
      configs: async () => opencodeServers.map((s) => ({ name: s.name, type: "remote", url: `https://${s.name}` })),
      add: async (s) => (calls.push(["opencode.add", s.name]), opencodeServers.push({ name: s.name, status: "connected" })),
      reconnect: async (name) => calls.push(["opencode.reconnect", name]),
    },
    fx: { installed: () => fxInstalled, active: () => fxActive, bin: () => undefined, home: join(tmp, "no-fx") },
    toast: (t, opts) => (opts?.sticky ? ui.toast(t.message, opts.action) : (events.push(["note", t.message]), "n")),
    dismissToast: ui.dismiss,
    prefill: (p) => calls.push(["prefill", p.slice(0, 40)]),
    openExternal: () => {},
    changed: () => {},
  }
  return { svc: new ToolsService(file, host), file, events, calls, opencodeServers }
}

describe("ToolsService", () => {
  test("before a scan: opencode's MCP servers as they are, toasts like before", () => {
    const { svc, events } = service({ opencodeServers: [{ name: "linear", status: "needs_auth", error: "401" }] })
    assert.equal(svc.setUp, false)
    svc.changed()
    assert.deepEqual(svc.items().map((t) => [t.id, t.state]), [["mcp:linear", "needs-auth"]])
    assert.deepEqual(events, [["toast", "MCP “linear” needs sign-in: 401", "Fix"]])
  })

  test("scan → apply writes tools.json; unchecked stops watching, rescans keep edits and hand-added CLIs", async () => {
    const { svc, file } = service({ opencodeServers: [{ name: "linear", status: "connected" }, { name: "notion", status: "connected" }] })
    const found = await svc.scan()
    assert.deepEqual(found.filter((f) => f.kind === "mcp").map((f) => [f.key, f.watched]), [["mcp:linear", false], ["mcp:notion", false]])
    svc.applyScan(["mcp:linear"])
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcp.map((s) => s.name), ["linear"])
    svc.saveCli({ id: "mine", name: "Mine", check: "true", fix: { kind: "session" } })
    await svc.scan()
    svc.applyScan(["mcp:linear", "mcp:notion"])
    const config = JSON.parse(readFileSync(file, "utf8"))
    assert.deepEqual(config.mcp.map((s) => s.name), ["linear", "notion"])
    assert.deepEqual(config.cli.map((c) => c.id).filter((id) => id === "mine"), ["mine"])
    assert.equal(svc.remove("mcp:notion"), true)
    assert.equal(svc.remove("mcp:notion"), false)
    svc.stop()
  })

  test("a server missing from a harness: one 'Set up' toast for the harness, which adds it", async () => {
    const servers = [{ name: "linear", status: "connected" }]
    const { svc, events, calls, opencodeServers } = service({ opencodeServers: servers })
    await svc.scan()
    svc.applyScan(["mcp:linear"])
    opencodeServers.length = 0
    svc.changed()
    const item = svc.items().find((t) => t.id === "mcp:linear")
    assert.equal(item.state, "missing")
    assert.deepEqual(item.harnesses, [{ harness: "opencode", state: "not-set-up", label: "Add" }])
    assert.deepEqual(events.at(-1), ["toast", "opencode doesn't have your MCP server “linear”", "Set up"])
    assert.equal(await svc.fix("setup@opencode"), false)
    assert.deepEqual(calls, [["opencode.add", "linear"]])
    assert.equal(svc.items().find((t) => t.id === "mcp:linear").state, "ok")
    svc.stop()
  })

  test("fx is lazy: unused until you open an fx session", async () => {
    const { svc } = service({ opencodeServers: [{ name: "linear", status: "connected" }], fxInstalled: true })
    await svc.scan()
    svc.applyScan(["mcp:linear"])
    assert.deepEqual(
      svc.items().find((t) => t.id === "mcp:linear").harnesses.map((h) => [h.harness, h.state]),
      [["opencode", "ok"], ["fx", "unused"]],
    )
    svc.stop()
  })

  test("fixes that open a session say so", async () => {
    const { svc, calls } = service({ opencodeServers: [{ name: "linear", status: "failed", error: "boom" }] })
    assert.equal(await svc.fix("mcp:linear"), true)
    assert.deepEqual(calls, [["prefill", 'The "linear" MCP server is broken in ope']])
  })
})

describe("tools handlers", () => {
  const fakeHost = () => {
    const data = { mcp: [], cli: [] }
    const checked = []
    const host = {
      store: { data: { settings: {} } },
      mcp: () => [{ name: "linear", status: "connected" }],
      toolsSetUp: () => true,
      tools: () => [
        { id: "mcp:linear", kind: "mcp", name: "linear", state: "ok", fix: "session", label: "Fix" },
        ...data.cli.map((c) => ({ id: `cli:${c.id}`, kind: "cli", name: c.name, state: "ok", check: c.check, fix: c.fix.kind, label: "Run" })),
      ],
      cliTools: () => data.cli,
      checkTools: async (ids) => checked.push(ids ?? "all"),
      checkTool: async (id) => checked.push(id),
      saveCliTool: (config) => data.cli.push(config),
      removeTool: (id) => {
        const before = data.cli.length
        data.cli = data.cli.filter((c) => `cli:${c.id}` !== id)
        return data.cli.length !== before
      },
      scanTools: async () => [
        { key: "mcp:linear", kind: "mcp", name: "linear", description: "in opencode", watched: true },
        { key: "gh", kind: "cli", name: "GitHub CLI", description: "gh auth status", watched: false },
      ],
      applyToolScan: (keys) => checked.push(["apply", keys]),
    }
    return { host, data, checked }
  }
  const call = (handlers, command, args) => handlers[command](args, { v: 1, command, args, caller: {} }, {})

  test("add, list, check, scan and remove", async () => {
    const { host, data, checked } = fakeHost()
    const h = createHandlers(host)
    const added = await call(h, "tools add", {
      name: "AWS (vercel)",
      check: "aws sts get-caller-identity --profile vercel",
      "fix-command": "aws sso login --profile vercel",
      label: "Log in",
    })
    assert.equal(added.id, "cli:aws-vercel")
    assert.deepEqual(data.cli[0].fix, { kind: "command", command: "aws sso login --profile vercel" })
    await assert.rejects(call(h, "tools add", { name: "x", check: "x", id: "aws-vercel", "fix-session": true }), { code: "CONFLICT" })
    await assert.rejects(call(h, "tools add", { name: "x", check: "x" }), { code: "USAGE" })
    assert.deepEqual(call(h, "tools list", {}).items.map((t) => t.id), ["mcp:linear", "cli:aws-vercel"])
    await call(h, "tools check", { id: ["aws-vercel", "linear"] })
    assert.deepEqual(checked.slice(-2), ["mcp:linear", ["aws-vercel"]])
    const scan = await call(h, "tools scan", { apply: true, skip: ["gh"] })
    assert.deepEqual(checked.at(-1), ["apply", ["mcp:linear"]])
    assert.deepEqual(scan.items.map((i) => i.watched), [true, false])
    assert.deepEqual(call(h, "tools remove", { id: "aws-vercel" }), { id: "cli:aws-vercel", changed: true })
  })
})
