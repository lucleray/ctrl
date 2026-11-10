import { spawn } from "node:child_process"
import * as esbuild from "esbuild"
import { createServer } from "vite"
import electron from "electron"
import { buildNative, configs } from "./build.mjs"

buildNative()

const server = await createServer({ configFile: "vite.config.ts" })
await server.listen()
const url = server.resolvedUrls.local[0]

// Started from an agent inside ctrl, the shell carries that ctrl's socket and TUI bridge: the dev app has its own.
const devEnv = { ...process.env }
for (const v of ["CTRL_SOCKET", "CTRL_BRIDGE_URL", "CTRL_TERM_ID", "OPENCODE_SESSION_ID"]) delete devEnv[v]

let app
const restart = () => {
  if (app) {
    app.removeAllListeners("exit")
    app.kill()
  }
  app = spawn(electron, ["."], { stdio: "inherit", env: { ...devEnv, VITE_DEV_URL: url } })
  app.on("exit", () => process.exit(0))
}

let timer
const restartPlugin = {
  name: "restart-electron",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return
      clearTimeout(timer)
      timer = setTimeout(restart, 100)
    })
  },
}

for (const config of configs) {
  // The CLI and the remote web app run on their own: rebuilding them doesn't need an app restart.
  const standalone = config.outfile?.startsWith("dist/cli/") || config.outdir === "dist/remote"
  const ctx = await esbuild.context({
    ...config,
    plugins: [...(config.plugins ?? []), ...(standalone ? [] : [restartPlugin])],
  })
  await ctx.watch()
}
