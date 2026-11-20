// Small pure helpers: keyboard shortcuts (src/shared/shortcuts.ts), model refs (src/shared/cli/settings.ts)
// and terminal mode replay (src/main/term-modes.ts). Run with `npm test`.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-shared-test-")
let shortcuts, settings, TermModes

before(async () => {
  ;[shortcuts, settings, { TermModes }] = await load(tmp, "src/shared/shortcuts.ts", "src/shared/cli/settings.ts", "src/main/term-modes.ts")
})

describe("shortcuts", () => {
  const key = (k) => ({ meta: false, control: false, alt: false, shift: false, ...k })

  test("accelFromInput: physical letters and digits, produced symbols, lone modifiers ignored", () => {
    const { accelFromInput } = shortcuts
    assert.equal(accelFromInput(key({ key: "p", code: "KeyP", meta: true, shift: true })), "Shift+Cmd+P")
    assert.equal(accelFromInput(key({ key: "π", code: "KeyP", alt: true, meta: true })), "Alt+Cmd+P")
    assert.equal(accelFromInput(key({ key: "+", code: "Equal", meta: true, shift: true })), "Cmd++")
    assert.equal(accelFromInput(key({ key: " ", code: "Space", control: true })), "Ctrl+Space")
    assert.equal(accelFromInput(key({ key: "1", code: "Digit1", meta: true })), "Cmd+1")
    assert.equal(accelFromInput(key({ key: "Meta", meta: true })), null)
  })

  test("formatAccel uses macOS symbols and order", () => {
    const { formatAccel } = shortcuts
    assert.equal(formatAccel("Shift+Cmd+R"), "⇧⌘R")
    assert.equal(formatAccel("Cmd++"), "⌘+")
    assert.equal(formatAccel("Cmd+-"), "⌘−")
    assert.equal(formatAccel("Ctrl+Alt+Cmd+Space"), "⌃⌥⌘Space")
  })

  test("isUsable needs a modifier or an F-key; reserved keys say why", () => {
    const { isUsable, reservedReason } = shortcuts
    assert.equal(isUsable("A"), false)
    assert.equal(isUsable("Shift+A"), false)
    assert.equal(isUsable("F5"), true)
    assert.equal(isUsable("Alt+A"), true)
    assert.match(reservedReason("Cmd+3"), /jump to sessions/)
    assert.match(reservedReason("Cmd+Q"), /quits/)
    assert.equal(reservedReason("Cmd+P"), undefined)
  })

  test("overrides replace defaults, and an empty list unbinds", () => {
    const { commandFor, shortcutLabel, COMMANDS } = shortcuts
    assert.equal(commandFor("Cmd+K"), "palette")
    assert.equal(commandFor("Cmd+K", { palette: ["Cmd+J"] }), undefined)
    assert.equal(commandFor("Cmd+J", { palette: ["Cmd+J"] }), "palette")
    assert.equal(shortcutLabel("settings", { settings: [] }), "")
    const defaults = COMMANDS.flatMap((c) => c.defaults)
    assert.equal(new Set(defaults).size, defaults.length, "no default bound twice")
    for (const accel of defaults) assert.equal(shortcuts.reservedReason(accel), undefined, accel)
  })
})

describe("model refs", () => {
  test("parse and format round-trip, with variants", () => {
    const { parseModel, formatModel } = settings
    for (const [value, harness] of [
      ["openrouter/anthropic/claude-x#high", "opencode"],
      ["openai/gpt-5", "opencode"],
      ["gpt-5#low", "fx"],
    ])
      assert.equal(formatModel(parseModel(value, harness)), value)
    assert.deepEqual(parseModel("openrouter/anthropic/claude-x#high", "opencode"), { providerID: "openrouter", id: "anthropic/claude-x", variant: "high" })
  })

  test("bad refs are undefined", () => {
    const { parseModel, formatModel } = settings
    for (const value of ["nope", "/x", "x/", ""]) assert.equal(parseModel(value, "opencode"), undefined, value)
    assert.equal(parseModel("", "fx"), undefined)
    assert.equal(formatModel(null), null)
  })
})

describe("TermModes", () => {
  test("replays the private modes still on, across chunks", () => {
    const modes = new TermModes()
    modes.feed("\x1b[?1049h\x1b[?1000;1006h hello")
    modes.feed("\x1b[?1000l text \x1b[?2004h")
    assert.equal(modes.replay(), "\x1b[?1049h\x1b[?1006h\x1b[?2004h")
    modes.reset()
    assert.equal(modes.replay(), "")
  })
})
