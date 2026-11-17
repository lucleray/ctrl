// Shared by the test files: bundles TypeScript sources with esbuild (no Electron, no network) and gives
// each file a throwaway folder.
import * as esbuild from "esbuild"
import { mkdtempSync, rmSync } from "node:fs"
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
