// Shared by the test files: bundles TypeScript sources with esbuild (no Electron, no network) and gives
// each file a throwaway folder.
import * as esbuild from "esbuild"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after } from "node:test"

const require = createRequire(import.meta.url)

/** A temp folder removed once the file's tests are done. */
export function tmpDir(prefix = "ctrl-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Bundles these entries in one esbuild run and requires them, in order. */
export async function load(dir, ...entries) {
  const outdir = mkdtempSync(join(dir, "build-"))
  await esbuild.build({
    entryPoints: Object.fromEntries(entries.map((e) => [e.replace(/\W/g, "_"), e])),
    outdir,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "warning",
  })
  return entries.map((e) => require(join(outdir, e.replace(/\W/g, "_") + ".cjs")))
}

/**
 * Renderer code in a fake DOM (happy-dom), for UI tests: one bundle holding React and these modules, so
 * they share one React. Returns their exports plus `render(element)` → { root, unmount }, and `act`.
 * `window.ctrl` is the preload API: pass the parts the component uses. Call `close()` in an `after`.
 */
export async function loadUi(dir, entries, ctrl = {}) {
  const { Window } = await import("happy-dom")
  const window = new Window({ url: "http://localhost/" })
  // Only what React needs: replacing Node's own globals (Event, navigator…) can break node:test itself.
  for (const key of ["window", "document", "localStorage"])
    Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.ctrl = ctrl

  // React stays external (one copy, and its act() needs the real `require("timers")`), so the bundle goes
  // under node_modules where Node finds it.
  const cache = join(process.cwd(), "node_modules", ".cache")
  mkdirSync(cache, { recursive: true })
  const outdir = mkdtempSync(join(cache, "ctrl-ui-test-"))
  after(() => rmSync(outdir, { recursive: true, force: true }))
  const outfile = join(outdir, "ui.cjs")
  const contents = [
    `export { act, createElement } from "react"`,
    `export { createRoot } from "react-dom/client"`,
    ...entries.map((e, i) => `export * as m${i} from ${JSON.stringify("./" + e)}`),
  ].join("\n")
  await esbuild.build({
    stdin: { contents, resolveDir: process.cwd(), loader: "tsx" },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react-dom"],
    loader: { ".png": "dataurl", ".css": "empty" },
    logLevel: "warning",
  })
  const ui = require(outfile)
  const render = (element) => {
    const root = document.createElement("div")
    document.body.appendChild(root)
    const r = ui.createRoot(root)
    ui.act(() => r.render(element))
    return { root, unmount: () => (ui.act(() => r.unmount()), root.remove()) }
  }
  return { modules: entries.map((_, i) => ui[`m${i}`]), h: ui.createElement, act: ui.act, render, ctrl, close: () => window.happyDOM.close() }
}

/** Types into a React-controlled input (React tracks the value, so set it the way a browser would). */
export function type(act, input, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set.call(input, value)
    input.dispatchEvent(new window.Event("input", { bubbles: true }))
  })
}

export function key(act, el, key, init = {}) {
  act(() => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })))
}
