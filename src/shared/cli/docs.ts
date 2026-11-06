import { ALIASES, COMMANDS, GLOBAL_FLAGS, OBJECTS, type ArgSpec, type CommandSpec } from "./commands"
import { ERROR_DESCRIPTIONS, EXIT_CODES, type ErrorCode } from "./protocol"
import { describeType, SETTING_KEYS } from "./settings"

const flagValue = (a: ArgSpec) =>
  a.type === "bool" ? "" : a.type === "enum" && a.values ? ` ${a.values.join("|")}` : ` <${a.type === "int" ? "n" : a.name}>`

/** `ctrl session new [--space <space>] …` */
export function usage(c: CommandSpec) {
  const parts = [`ctrl ${c.name}`]
  for (const a of c.args.filter((a) => a.positional)) {
    const p = a.placeholder ?? `<${a.name}>`
    parts.push(a.required ? p : p.startsWith("[") ? p : `[${p}]`)
  }
  for (const a of c.args.filter((a) => !a.positional)) {
    const f = `--${a.name}${flagValue(a)}${a.list ? "..." : ""}`
    parts.push(a.required ? f : `[${f}]`)
  }
  return parts.join(" ")
}

const argLine = (a: ArgSpec) => {
  const name = a.positional ? (a.placeholder ?? `<${a.name}>`) : `--${a.name}${a.type === "bool" ? ` / --no-${a.name}` : flagValue(a)}`
  const bits = [a.description]
  if (a.list && !a.positional) bits.push("repeatable")
  if (a.required) bits.push("required")
  if (a.default !== undefined) bits.push(`default: ${JSON.stringify(a.default)}`)
  return { name, text: bits.filter(Boolean).join(" · ") }
}

export function commandHelp(c: CommandSpec) {
  const lines = [usage(c), "", `  ${c.summary}`]
  for (const d of c.details ?? []) lines.push(`  ${d}`)
  if (c.args.length) {
    lines.push("", "Arguments:")
    for (const a of c.args) {
      const { name, text } = argLine(a)
      lines.push(`  ${name.padEnd(34)} ${text}`)
    }
  }
  lines.push("", `Returns (data): ${c.returns}`)
  for (const h of c.harness ?? []) lines.push(`Harness: ${h}`)
  if (c.examples?.length) lines.push("", "Examples:", ...c.examples.map((e) => `  ${e}`))
  return lines.join("\n")
}

const nounOf = (c: CommandSpec) => c.name.split(" ")[0]

export function overviewHelp(version: string) {
  const lines = [
    `ctrl ${version}: drive the ctrl app from the command line. Built for agents.`,
    "",
    "Every reply is one JSON object on stdout: {\"ok\":true,\"data\":…} or {\"ok\":false,\"error\":{code,message,hint?,candidates?}}.",
    "Machine-readable reference: ctrl help --json · full docs: ctrl docs · one command: ctrl help <noun> <verb>",
    "Sessions: an id (ses_… / fx:…), `self` (the session you run in), `current` (on screen) or `name:<title>`.",
    "Spaces: an id (spc_…), `self` (the space of the session you run in), `current` (the space on screen) or `name:<name>`.",
    "Long or multi-line text goes on stdin: a value of `-` reads it, e.g. --prompt - < prompt.md.",
    "",
  ]
  let noun = ""
  for (const c of COMMANDS) {
    if (nounOf(c) !== noun) {
      noun = nounOf(c)
      lines.push("")
    }
    lines.push(`  ${c.name.padEnd(22)} ${c.summary}`)
  }
  lines.push("", "Aliases: " + ALIASES.map((a) => `${a.name} = ${a.target}`).join(" · "))
  lines.push("Global flags: " + GLOBAL_FLAGS.map((f) => `--${f.name}`).join(" "))
  return lines.join("\n")
}

export function nounHelp(noun: string) {
  const cmds = COMMANDS.filter((c) => nounOf(c) === noun)
  return cmds.map(commandHelp).join("\n\n" + "─".repeat(60) + "\n\n")
}

const md = (s: string) => s.replace(/\|/g, "\\|")

/** docs/CLI-REFERENCE.md, also printed by `ctrl docs`. */
export function referenceMarkdown() {
  const out: string[] = [
    "# ctrl CLI reference",
    "",
    "> Generated from `src/shared/cli/commands.ts` by `npm run cli-docs`. Don't edit by hand.",
    "> Principles and conventions: [CLI.md](CLI.md).",
    "",
    "## Commands",
    "",
  ]
  let noun = ""
  for (const c of COMMANDS) {
    if (nounOf(c) !== noun) {
      noun = nounOf(c)
      out.push(`- **${noun}**: ` + COMMANDS.filter((x) => nounOf(x) === noun).map((x) => `[\`${x.name}\`](#${x.name.replace(/ /g, "-")})`).join(" · "))
    }
  }
  out.push("", `Aliases: ${ALIASES.map((a) => `\`${a.name}\` = \`${a.target}\``).join(" · ")}`, "")
  out.push("Global flags:", "", "| Flag | Meaning |", "|---|---|")
  for (const f of GLOBAL_FLAGS) out.push(`| \`${argLine(f).name}\` | ${md(argLine(f).text)} |`)
  out.push("")
  for (const c of COMMANDS) {
    out.push(`### ${c.name}`, "", c.summary + (c.mutates ? " *(changes state)*" : "") + (c.stream ? " *(streams)*" : ""), "")
    out.push("```text", usage(c), "```", "")
    for (const d of c.details ?? []) out.push(`- ${d}`)
    if (c.details?.length) out.push("")
    if (c.args.length) {
      out.push("| Argument | Meaning |", "|---|---|")
      for (const a of c.args) {
        const { name, text } = argLine(a)
        out.push(`| \`${md(name)}\` | ${md(text)} |`)
      }
      out.push("")
    }
    out.push(`**Returns:** \`${c.returns}\``, "")
    for (const h of c.harness ?? []) out.push(`- **Harness:** ${h}`)
    if (c.harness?.length) out.push("")
    if (c.examples?.length) out.push("```bash", ...c.examples, "```", "")
  }
  out.push("## Objects", "")
  for (const [name, shape] of Object.entries(OBJECTS)) out.push(`### ${name}`, "", "```ts", shape, "```", "")
  out.push("## Settings keys", "", "| Key | Type | Meaning |", "|---|---|---|")
  for (const k of SETTING_KEYS) out.push(`| \`${k.key}\` | ${md(describeType(k.type))} | ${md(k.description)} |`)
  out.push("", "## Errors", "", "| Exit | `code` | When |", "|---|---|---|")
  for (const [code, desc] of Object.entries(ERROR_DESCRIPTIONS)) out.push(`| ${EXIT_CODES[code as ErrorCode]} | \`${code}\` | ${md(desc)} |`)
  out.push("")
  return out.join("\n")
}

export function helpJson(version: string) {
  return {
    version,
    commands: COMMANDS.map((c) => ({ ...c, usage: usage(c) })),
    aliases: ALIASES,
    globalFlags: GLOBAL_FLAGS,
    objects: OBJECTS,
    settings: SETTING_KEYS.map((k) => ({ ...k, type: describeType(k.type) })),
    errors: Object.entries(ERROR_DESCRIPTIONS).map(([code, description]) => ({
      code,
      exit: EXIT_CODES[code as ErrorCode],
      description,
    })),
  }
}
