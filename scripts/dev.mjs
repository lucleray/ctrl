import { spawn } from "node:child_process"
import * as esbuild from "esbuild"
import { createServer } from "vite"
import electron from "electron"
import { configs } from "./build.mjs"

const server = await createServer({ configFile: "vite.config.ts" })
await server.listen()
const url = server.resolvedUrls.local[0]

let app
const restart = () => {
  if (app) {
    app.removeAllListeners("exit")
    app.kill()
  }
  app = spawn(electron, ["."], { stdio: "inherit", env: { ...process.env, VITE_DEV_URL: url } })
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
  const ctx = await esbuild.context({ ...config, plugins: [restartPlugin] })
  await ctx.watch()
}
