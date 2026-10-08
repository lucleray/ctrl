import * as esbuild from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron", "node-pty"],
  logLevel: "info",
}

export const configs = [
  {
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.js",
    format: "esm",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  },
  { ...common, entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload.cjs", format: "cjs" },
]

// The packaged app can't point opencode at bridge/tui.ts (no node_modules next to
// it, and opencode can't read inside app.asar), so ship a self-contained copy.
// Only Plugin.define is used at runtime, so skip the solid-js half of the module.
const pluginDir = dirname(fileURLToPath(import.meta.resolve("@opencode/plugin/tui")))
const bridgeConfig = {
  ...common,
  sourcemap: false,
  entryPoints: ["bridge/tui.ts"],
  outfile: "dist/bridge/tui.js",
  format: "esm",
  plugins: [
    {
      name: "plugin-define-only",
      setup(build) {
        build.onResolve({ filter: /^@opencode\/plugin\/tui$/ }, () => ({ path: "tui", namespace: "plugin-shim" }))
        build.onLoad({ filter: /.*/, namespace: "plugin-shim" }, () => ({
          contents: `export * as Plugin from ${JSON.stringify(join(pluginDir, "plugin.js"))}`,
          resolveDir: pluginDir,
        }))
      },
    },
  ],
}

if (process.argv[1].endsWith("build.mjs")) {
  await Promise.all([...configs, bridgeConfig].map((c) => esbuild.build(c)))
  mkdirSync("dist/bridge", { recursive: true })
  writeFileSync(
    "dist/bridge/package.json",
    JSON.stringify({ name: "ctrl-bridge", private: true, type: "module", exports: { "./tui": "./tui.js" } }, null, 2),
  )
}
