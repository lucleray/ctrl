import type { ModelRef } from "../types"

/**
 * Settings the CLI can read and write, as flat dotted keys (docs/CLI.md → settings). Keys with a
 * `<placeholder>` expand to one key per item (sound event, shortcut command, resource adapter).
 */
export type SettingType =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "bool" }
  | { kind: "int"; min: number; max: number }
  | { kind: "string"; nullable: true }
  | { kind: "folder" }
  | { kind: "space" }
  | { kind: "model"; harness: "opencode" | "fx" }
  | { kind: "sound" }
  | { kind: "accelerators" }

export type SettingKey = { key: string; type: SettingType; description: string }

export const SETTING_KEYS: SettingKey[] = [
  { key: "appearance", type: { kind: "enum", values: ["system", "light", "dark"] }, description: "App light/dark mode" },
  {
    key: "tuiTheme",
    type: { kind: "string", nullable: true },
    description: "opencode TUI theme name; null follows opencode's cli.json (choices in `values`)",
  },
  { key: "fontSize", type: { kind: "int", min: 9, max: 24 }, description: "Terminal text size in px" },
  {
    key: "defaultHarness",
    type: { kind: "enum", values: ["opencode", "fx"] },
    description: "Harness new sessions start with; spaces can override",
  },
  {
    key: "defaultDirectory",
    type: { kind: "folder" },
    description: "Folder new sessions start in when their space doesn't set one; null = ~",
  },
  {
    key: "defaultSpace",
    type: { kind: "space" },
    description: "Space new chats land in (⌘N, New chat, `session new` with no --space and no parent); null = no space",
  },
  {
    key: "defaultModelEnabled",
    type: { kind: "bool" },
    description: "Off: ctrl passes no model and the harness picks its own",
  },
  {
    key: "defaultModel",
    type: { kind: "model", harness: "opencode" },
    description: "opencode model for new sessions, used when defaultModelEnabled",
  },
  {
    key: "defaultFxModel",
    type: { kind: "model", harness: "fx" },
    description: "fx model for new sessions, used when defaultModelEnabled",
  },
  {
    key: "ctrlInstructions",
    type: { kind: "bool" },
    description: "Invisible instruction on opencode sessions: tells the agent it runs in ctrl and how to look around with the ctrl CLI; spaces can override",
  },
  { key: "dockBadge", type: { kind: "bool" }, description: "Dock badge with the sessions waiting on you" },
  {
    key: "notifications",
    type: { kind: "bool" },
    description: "macOS notifications when a background session needs you, finishes or fails",
  },
  { key: "sounds", type: { kind: "bool" }, description: "Sounds when a session needs you, fails or finishes" },
  { key: "soundsWhenFocused", type: { kind: "bool" }, description: "Also play sounds while ctrl is focused" },
  {
    key: "soundChoices.<event>",
    type: { kind: "sound" },
    description: "Sound per event (needs-input, failed, finished): macOS sound name, absolute file path, or null",
  },
  {
    key: "shortcuts.<command>",
    type: { kind: "accelerators" },
    description: "Bindings for an app command, e.g. [\"Cmd+Shift+N\"]; [] disables it, null restores the default",
  },
  {
    key: "companion",
    type: { kind: "bool" },
    description: "ctrl Companion: always-on-top window listing the sessions that mentioned what's on screen (browser tab, Slack thread, Notion page), with a global shortcut for a new session about it",
  },
  {
    key: "adapterModes.<adapter>",
    type: { kind: "enum", values: ["off", "links", "live"] },
    description: "Resource adapter mode: off hides its links, links only, or live details",
  },
]

export function describeType(t: SettingType): string {
  switch (t.kind) {
    case "enum":
      return t.values.map((v) => JSON.stringify(v)).join(" | ")
    case "bool":
      return "boolean"
    case "int":
      return `integer ${t.min}-${t.max}`
    case "string":
      return "string | null"
    case "folder":
      return "folder path | null"
    case "space":
      return "space id | name:<name> | null"
    case "model":
      return t.harness === "fx"
        ? '"<model>[#<effort>]" | {providerID:"fx",id,variant?} | null'
        : '"<provider>/<model>[#<variant>]" | {providerID,id,variant?} | null'
    case "sound":
      return "system sound name | absolute path | null"
    case "accelerators":
      return "string[] | null"
  }
}

/** "vercel/anthropic/claude-x#high" → {providerID:"vercel", id:"anthropic/claude-x", variant:"high"}; fx has no provider part. */
export function parseModel(value: string, harness: "opencode" | "fx"): ModelRef | undefined {
  const [ref, variant] = value.split("#", 2)
  if (harness === "fx") return ref ? { providerID: "fx", id: ref, ...(variant ? { variant } : {}) } : undefined
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export function formatModel(model: ModelRef | null | undefined): string | null {
  if (!model) return null
  const base = model.providerID === "fx" ? model.id : `${model.providerID}/${model.id}`
  return model.variant ? `${base}#${model.variant}` : base
}
