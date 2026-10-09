import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** A private HOME + XDG dirs: opencode keeps its data, config and service registration there. */
export function demoEnv(dir) {
  const home = join(dir, "home")
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  }
}

/** Resolved with the real HOME, before the demo env replaces it. */
export function opencodeBin() {
  const candidates = [join(homedir(), ".opencode/bin/opencode"), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"]
  return process.env.CTRL_OPENCODE || candidates.find((p) => existsSync(p)) || "opencode"
}

/** Resolved with the real HOME, before the demo env replaces it. */
export function fxBin() {
  const candidates = [join(homedir(), ".local/bin/fx"), "/opt/homebrew/bin/fx", "/usr/local/bin/fx"]
  return process.env.CTRL_FX || candidates.find((p) => existsSync(p)) || "fx"
}
