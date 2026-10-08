import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// From https://opencode.ai/v2/docs/themes/ (built-ins).
const BUILTIN = [
  "opencode", "aura", "ayu", "carbonfox", "catppuccin", "catppuccin-frappe", "catppuccin-macchiato",
  "cobalt2", "cursor", "dracula", "everforest", "flexoki", "github", "gruvbox", "kanagawa",
  "lucent-orng", "material", "matrix", "mercury", "monokai", "nightowl", "nord", "one-dark", "orng",
  "osaka-jade", "palenight", "rosepine", "solarized", "synthwave84", "system", "tokyonight", "vercel",
  "vesper", "zenburn",
]

function configDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

export function listThemes(): { builtin: string[]; custom: string[] } {
  let custom: string[] = []
  try {
    custom = readdirSync(join(configDir(), "themes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort()
  } catch {}
  return { builtin: BUILTIN.filter((t) => !custom.includes(t)), custom }
}

/** The theme name from the user's global cli.json, used as the "Default" option. */
export function cliThemeName(): string | undefined {
  try {
    const cli = JSON.parse(readFileSync(join(configDir(), "cli.json"), "utf8"))
    return typeof cli?.theme?.name === "string" ? cli.theme.name : undefined
  } catch {
    return undefined
  }
}
