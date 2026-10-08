import { execFileSync } from "node:child_process"

/**
 * Apps launched from Finder/Dock get launchd's bare environment (PATH is just
 * /usr/bin:/bin:...), so opencode, and the tools its agent runs (gh, node via nvm,
 * ...), wouldn't be found. Copy the user's login-shell environment instead, like
 * a terminal would have.
 */
export function loadShellEnv() {
  const shell = process.env.SHELL || "/bin/zsh"
  const marker = "__CTRL_ENV__"
  try {
    const out = execFileSync(shell, ["-ilc", `printf '${marker}'; /usr/bin/env -0; printf '${marker}'`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
    })
    const body = out.split(marker)[1]
    if (!body) return
    for (const entry of body.split("\0")) {
      const i = entry.indexOf("=")
      if (i <= 0) continue
      const key = entry.slice(0, i)
      if (key === "PWD" || key === "SHLVL" || key === "_") continue
      process.env[key] = entry.slice(i + 1)
    }
  } catch (err) {
    console.error("[ctrl] couldn't load the login shell environment:", err)
  }
}
