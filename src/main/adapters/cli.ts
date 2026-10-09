import { spawn } from "node:child_process"
import { AdapterError, type CliResult, type RunCli } from "../../shared/adapters/adapter"

/**
 * Runs a CLI without a terminal. A missing CLI becomes a "no-cli" error, and
 * output matching `loginPrompt` (a CLI starting an interactive login) kills it
 * and becomes "logged-out" instead of hanging.
 */
export const runCli: RunCli = (command, args, opts = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new AdapterError(`${command} timed out`, "network")))
    }, opts.timeout ?? 30_000)
    const watch = (chunk: Buffer, into: "stdout" | "stderr") => {
      const text = chunk.toString()
      if (into === "stdout") stdout += text
      else stderr += text
      if (opts.loginPrompt?.test(text)) {
        child.kill()
        finish(() => reject(new AdapterError(`${command} isn't logged in`, "logged-out")))
      }
    }
    child.stdout.on("data", (c: Buffer) => watch(c, "stdout"))
    child.stderr.on("data", (c: Buffer) => watch(c, "stderr"))
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? new AdapterError(`${command} isn't installed`, "no-cli")
            : new AdapterError(`${command} failed: ${err.message}`, "network"),
        ),
      ),
    )
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })))
  })
}
