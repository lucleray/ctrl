import * as esbuild from "esbuild"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
  { ...common, entryPoints: ["src/indexer/indexer.ts"], outfile: "dist/indexer.cjs", format: "cjs" },
  // The `ctrl` CLI (docs/CLI.md): shipped outside app.asar (Contents/Resources/cli) so plain node can run it.
  {
    ...common,
    entryPoints: ["src/cli/cli.ts"],
    outfile: "dist/cli/cli.cjs",
    format: "cjs",
    target: "node18",
    sourcemap: false,
    define: { __CTRL_VERSION__: JSON.stringify(JSON.parse(readFileSync("package.json", "utf8")).version) },
    plugins: [
      {
        name: "cli-launcher",
        setup(build) {
          build.onEnd(() => {
            copyFileSync("bin/ctrl", "dist/cli/ctrl")
            chmodSync("dist/cli/ctrl", 0o755)
          })
        },
      },
    ],
  },
]

// Remote control's web app (src/main/remote.ts serves dist/remote to the phone).
configs.push({
  ...common,
  platform: "browser",
  target: "safari16",
  entryPoints: ["src/remote/client.ts"],
  outdir: "dist/remote",
  entryNames: "client",
  format: "esm",
  sourcemap: false,
  minify: true,
  plugins: [
    {
      name: "remote-html",
      setup(build) {
        build.onEnd(() => {
          mkdirSync("dist/remote", { recursive: true })
          copyFileSync("src/remote/index.html", "dist/remote/index.html")
          copyFileSync("build/icon.png", "dist/remote/icon.png")
        })
      },
    },
  ],
})

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
