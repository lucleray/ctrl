// Renderer components in a fake DOM (happy-dom), with a fake `window.ctrl`: what they show and what clicks
// and keys do. No Electron, no browser. Run with `npm test`.
import assert from "node:assert/strict"
import { after, before, beforeEach, describe, test } from "node:test"
import { key, loadUi, tmpDir, type } from "./helpers.mjs"

const tmp = tmpDir("ctrl-ui-test-")
let ui, Palette, Toasts, ChatView, useTypeToFocus

const ctrl = {
  hits: [],
  calls: [],
  search: async (q) => (ctrl.calls.push(["search", q]), { hits: ctrl.hits, status: { indexing: false, done: 1, total: 1 } }),
  createSpace: async (name) => void ctrl.calls.push(["createSpace", name]),
  onToast: (cb) => ((ctrl.toast = cb), () => {}),
  onToastDismiss: (cb) => ((ctrl.dismiss = cb), () => {}),
  undo: async (id) => void ctrl.calls.push(["undo", id]),
  toastAction: async (id) => void ctrl.calls.push(["toastAction", id]),
  // The chat view (ChatView.tsx): an empty session, and its draft saves.
  chatOpen: async () => ({ items: [], cursor: null, pending: [], inbox: [] }),
  chatClose: async () => {},
  chatStats: async () => ({ cost: 0, context: null }),
  chatModel: async () => null,
  listModels: async () => ({ models: [], default: null }),
  onChatUpdate: () => () => {},
  onChatPending: () => () => {},
  onChatInbox: () => () => {},
  onChatModelChanged: () => () => {},
  setDraft: (id, text) => void ctrl.calls.push(["setDraft", id, text]),
}

before(async () => {
  ui = await loadUi(tmp, ["src/renderer/Palette.tsx", "src/renderer/Toast.tsx", "src/renderer/ChatView.tsx", "src/renderer/type-to-focus.ts"], ctrl)
  ;[{ Palette }, { Toasts }, { ChatView }, { useTypeToFocus }] = ui.modules
})

after(() => ui.close())

beforeEach(() => {
  ctrl.calls = []
  ctrl.hits = []
})

const session = (id, title, extra = {}) => ({ id, harness: "opencode", title, directory: "/Users/me/w/app", status: "idle", updated: 1, ...extra })
const state = {
  spaces: [{ id: "spc_1", name: "Work" }],
  assignments: { ses_a: "spc_1" },
  archived: { ses_old: 1 },
  sessions: [session("ses_a", "Fix the build", { status: "running" }), session("ses_b", "Write docs"), session("ses_old", "Old build fix")],
  settings: { shortcuts: {} },
}

/** A palette with its callbacks recorded. */
function palette(props = {}) {
  const calls = []
  const rec = (name) => (...args) => calls.push([name, ...args])
  const r = ui.render(
    ui.h(Palette, { state, onClose: rec("close"), onOpen: rec("open"), onNew: rec("new"), onRevealSpace: rec("reveal"), ...props }),
  )
  const $ = (sel) => r.root.querySelector(sel)
  const rows = () => [...r.root.querySelectorAll(".palette-item")].map((el) => el.querySelector(".palette-label").textContent)
  return { ...r, calls, $, rows, input: $(".palette-input") }
}

describe("Palette", () => {
  test("lists recent chats without archived ones, then quick actions", () => {
    const p = palette()
    assert.deepEqual(p.rows(), ["Fix the build", "Write docs", "New chat"])
    assert.equal(p.$(".palette-hint").textContent, "Work")
    p.unmount()
  })

  test("typing filters chats (archived last), spaces, and offers to create a space", async () => {
    const p = palette()
    type(ui.act, p.input, "build")
    await ui.act(async () => {})
    assert.deepEqual(p.rows(), ["Fix the build", "Old build fix", "Create space “build”"])
    assert.deepEqual(ctrl.calls, [["search", "build"]])
    type(ui.act, p.input, "work")
    await ui.act(async () => {})
    assert.ok(p.rows().includes("Work"))
    assert.ok(!p.rows().some((r) => r.startsWith("Create space")), "no offer when the space exists")
    p.unmount()
  })

  test("message hits show their snippet, after chats, skipping chats already listed", async () => {
    ctrl.hits = [
      { sessionID: "ses_b", title: "Write docs", role: "assistant", created: 1, snippet: "x" },
      { sessionID: "ses_a", title: "Fix the build", role: "user", created: 1, snippet: "the \uE000flaky\uE001 test" },
    ]
    const p = palette({ initialQuery: "docs" })
    await ui.act(async () => {})
    assert.deepEqual(p.rows(), ["Write docs", "Fix the build", "Create space “docs”"])
    assert.equal(p.$(".palette-detail").textContent, "You: the flaky test")
    assert.equal(p.$("mark").textContent, "flaky")
    p.unmount()
  })

  test("arrows and Enter open the selected chat; ^2 opens the second; Escape closes", () => {
    const p = palette()
    key(ui.act, p.input, "ArrowDown")
    assert.equal(p.$(".palette-item.selected .palette-label").textContent, "Write docs")
    key(ui.act, p.input, "Enter")
    assert.deepEqual(p.calls, [["close"], ["open", "ses_b"]])
    p.calls.length = 0
    key(ui.act, p.input, "2", { ctrlKey: true })
    assert.deepEqual(p.calls, [["close"], ["open", "ses_b"]])
    p.calls.length = 0
    key(ui.act, p.input, "Escape")
    assert.deepEqual(p.calls, [["close"]])
    p.unmount()
  })

  test("clicking “New chat” and “Create space” run them", async () => {
    const p = palette()
    ui.act(() => [...p.root.querySelectorAll(".palette-item")].at(-1).click())
    assert.deepEqual(p.calls, [["close"], ["new", null]])
    type(ui.act, p.input, "Ideas")
    await ui.act(async () => {})
    ui.act(() => [...p.root.querySelectorAll(".palette-item")].at(-1).click())
    assert.deepEqual(ctrl.calls.at(-1), ["createSpace", "Ideas"])
    p.unmount()
  })
})

describe("Toasts", () => {
  test("shows the newest toast, its undo, and goes away when dismissed", () => {
    const r = ui.render(ui.h(Toasts, { onView: () => {}, onAction: () => {}, undoLabel: "⌘Z" }))
    assert.equal(r.root.textContent, "")
    ui.act(() => ctrl.toast({ id: "t1", message: "Archived “A”", icon: "archive", duration: null, undo: true }))
    ui.act(() => ctrl.toast({ id: "t2", message: "Archived “B”", icon: "archive", duration: null, undo: true }))
    assert.match(r.root.textContent, /Archived “B”/)
    assert.doesNotMatch(r.root.textContent, /“A”/)
    const undo = [...r.root.querySelectorAll("button")].find((b) => /Undo/.test(b.textContent))
    ui.act(() => undo.click())
    assert.deepEqual(ctrl.calls, [["undo", "t2"]])
    ui.act(() => ctrl.toast({ id: "t3", message: "Hi", icon: "check", duration: null, undo: false }))
    ui.act(() => ctrl.dismiss("t3"))
    assert.equal(r.root.querySelector(".toast"), null)
    r.unmount()
  })
})

describe("ChatView drafts", () => {
  // What the chat view uses that happy-dom doesn't put on globalThis.
  before(() => {
    globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0)
    globalThis.ResizeObserver ??= window.ResizeObserver ?? class { observe() {} disconnect() {} }
  })
  test("each session keeps its own unsent message: nothing carries over when switching", async () => {
    const view = (id, draft) => ui.h(ChatView, { sessionID: id, session: session(id, id), archived: false, draft })
    const r = ui.render(view("ses_a"))
    const input = () => r.root.querySelector("textarea")
    type(ui.act, input(), "half a thought")
    await ui.act(async () => {})
    // Switching (the same chat view, another session): its composer is empty, and the first one's draft is saved right away.
    r.rerender(view("ses_b"))
    assert.equal(input().value, "")
    assert.deepEqual(ctrl.calls.at(-1), ["setDraft", "ses_a", "half a thought"])
    // Back: it's there.
    r.rerender(view("ses_a"))
    assert.equal(input().value, "half a thought")
    r.unmount()
    // A draft main kept (from before a restart) comes back too.
    const c = ui.render(view("ses_c", "from last time"))
    assert.equal(c.root.querySelector("textarea").value, "from last time")
    c.unmount()
  })
})

describe("type to focus", () => {
  // Compared by class: assert would print the whole happy-dom element graph on a mismatch.
  const focusedClass = () => document.activeElement?.className

  /** A composer, a field and a terminal, with the hook focusing the composer while `enabled`. */
  function screen(enabled = true) {
    const focused = []
    function Screen({ enabled }) {
      useTypeToFocus(enabled, () => (focused.push(true), document.querySelector(".composer").focus()))
      return ui.h(
        "div",
        null,
        ui.h("textarea", { className: "composer" }),
        ui.h("input", { className: "field" }),
        ui.h("div", { className: "xterm" }, ui.h("textarea", { className: "term" })),
      )
    }
    const r = ui.render(ui.h(Screen, { enabled }))
    const $ = (sel) => r.root.querySelector(sel)
    return { r, $, focused, rerender: (enabled) => r.rerender(ui.h(Screen, { enabled })) }
  }

  test("a letter typed with focus nowhere moves focus to the composer", () => {
    const s = screen()
    document.activeElement?.blur()
    key(ui.act, document.body, "h")
    assert.equal(focusedClass(), "composer")
    s.r.unmount()
  })

  test("⌘V pastes into the composer, other shortcuts and non-printing keys are left alone", () => {
    const s = screen()
    for (const [k, init] of [["k", { metaKey: true }], ["ArrowDown", {}], ["Escape", {}], ["Enter", {}], ["Meta", { metaKey: true }]]) {
      document.activeElement?.blur()
      key(ui.act, document.body, k, init)
      assert.equal(s.focused.length, 0, k)
    }
    key(ui.act, document.body, "v", { metaKey: true })
    assert.equal(focusedClass(), "composer")
    s.r.unmount()
  })

  test("fields and the terminal keep their keys, and nothing happens while disabled", () => {
    const s = screen()
    for (const sel of [".field", ".term"]) {
      s.$(sel).focus()
      key(ui.act, s.$(sel), "a")
      assert.equal(focusedClass(), sel.slice(1))
    }
    s.rerender(false)
    document.activeElement?.blur()
    key(ui.act, document.body, "a")
    window.dispatchEvent(new window.Event("focus"))
    assert.equal(s.focused.length, 0)
    s.r.unmount()
  })

  test("coming back to the window puts the caret in the composer, unless a field has it", () => {
    const s = screen()
    document.activeElement?.blur()
    ui.act(() => window.dispatchEvent(new window.Event("focus")))
    assert.equal(focusedClass(), "composer")
    s.$(".field").focus()
    ui.act(() => window.dispatchEvent(new window.Event("focus")))
    assert.equal(focusedClass(), "field")
    s.r.unmount()
  })
})
