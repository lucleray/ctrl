// Space instructions and the ctrl instruction for fx sessions, through fx agent profiles (fx ≥ 0.0.17).
//
// fx takes no extra instructions per session, but `fx --profile <name>` runs a session in a profile whose
// prompt.md is appended to fx's system prompt, and the session keeps that profile when resumed. So ctrl
// writes one profile per space with instructions (`ctrl-<space id>`) and one for the ctrl instruction alone
// (`ctrl`), and starts new fx sessions in the one that applies.
//
//   ~/.fx/agents/ctrl/                  profile.json + prompt.md: the ctrl instruction
//   ~/.fx/agents/ctrl-spc_abc123/       the space's instructions (+ the ctrl instruction when it's on)
//
// fx reads a profile each time it starts, so rewriting one reaches that space's sessions the next time fx
// opens them. A session moved to another space keeps its first space's profile (fx can't switch it).
// Profiles are never deleted: sessions that ran in one would start without it (fx warns, then goes on).
// fx reads profiles from ~/.fx/agents even when FX_HOME points elsewhere.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CTRL_INSTRUCTIONS } from "../shared/ctrl-instructions"

export const FX_AGENTS_DIR = process.env.CTRL_FX_AGENTS_DIR || join(homedir(), ".fx", "agents")

/** What a new fx session in this space should be told. */
export type FxInstructions = { spaceID: string | null; spaceName?: string; instructions?: string; ctrl: boolean }

const nameFor = (spaceID: string) => `ctrl-${spaceID.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`.slice(0, 64)

function content({ spaceName, instructions, ctrl }: FxInstructions) {
  const parts = [instructions?.trim() ? instructions.trim() : "", ctrl ? CTRL_INSTRUCTIONS : ""].filter(Boolean)
  const description = spaceName
    ? `ctrl's instructions for sessions in the space "${spaceName}". Not for subagents.`
    : "ctrl's instructions for its sessions. Not for subagents."
  return {
    profile: JSON.stringify({ description, prompt: "append" }, null, 2) + "\n",
    prompt: parts.join("\n\n") + (parts.length ? "\n" : ""),
  }
}

/** Writes a file only when it changed (atomic, 0600: fx refuses profile files others can write). */
function put(file: string, text: string) {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return
  const tmp = `${file}.ctrl-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

function write(name: string, files: { profile: string; prompt: string }) {
  const dir = join(FX_AGENTS_DIR, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  put(join(dir, "profile.json"), files.profile)
  put(join(dir, "prompt.md"), files.prompt)
}

/** The same text, for a chat session: `fx acp` takes it as the session's system prompt (src/main/fx-chat.ts). */
export function fxInstructionsText(opts: FxInstructions): string | undefined {
  const hasSpace = !!opts.spaceID && !!opts.instructions?.trim()
  if (!hasSpace && !opts.ctrl) return undefined
  return content(hasSpace ? opts : { spaceID: null, ctrl: true }).prompt.trim() || undefined
}

/**
 * The profile a new fx session should start in (written or refreshed now), or undefined when there's
 * nothing to tell it: no space instructions and the ctrl instruction off.
 */
export function fxProfile(opts: FxInstructions): string | undefined {
  const hasSpace = !!opts.spaceID && !!opts.instructions?.trim()
  if (!hasSpace && !opts.ctrl) return undefined
  const name = hasSpace ? nameFor(opts.spaceID!) : "ctrl"
  try {
    write(name, content(hasSpace ? opts : { spaceID: null, ctrl: true }))
    return name
  } catch (err) {
    console.error("[ctrl] couldn't write the fx profile", name, err)
    return undefined
  }
}

/**
 * Refreshes the space profiles ctrl already wrote, after a space's instructions or its ctrl instruction choice
 * changed, so its sessions get the new text the next time fx starts. Only touches profiles that exist. `ctrl`
 * always holds the ctrl instruction: turning it off only stops new sessions from starting in it.
 */
export function syncFxProfiles(spaces: FxInstructions[]) {
  try {
    for (const s of spaces) {
      if (!s.spaceID || !existsSync(join(FX_AGENTS_DIR, nameFor(s.spaceID)))) continue
      write(nameFor(s.spaceID), content(s))
    }
  } catch (err) {
    console.error("[ctrl] couldn't refresh the fx profiles", err)
  }
}
