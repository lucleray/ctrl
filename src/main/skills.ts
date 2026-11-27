import { createHash } from "node:crypto"
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { DetectedSkill, Harness, SkillItem, SkillSource } from "../shared/types"

/** In a copy ctrl imported: where it came from and the hash of what it copied. */
const IMPORT_MARKER = ".ctrl-import"
/** In ctrl's own skills (src/main/skill.ts): managed from Settings → Agents. */
const CTRL_MARKER = ".ctrl-skill"

export type SkillDirs = {
  /** Where imports go: opencode's global skills folder, which fx reads too */
  target: string
  /** Global folders opencode and fx both read, in the order they win */
  shared: { source: SkillSource; dir: string }[]
  /** fx's own folder ($FX_HOME/skills), opencode doesn't read it */
  fx?: string
  /** Folders of other agents, only read by a scan */
  others: { source: SkillSource; dir: string }[]
}

/**
 * Where skills live on this Mac. opencode and fx both read ~/.config/opencode/skills, ~/.agents/skills and
 * ~/.claude/skills; fx also reads $FX_HOME/skills. Codex, Cursor and Claude Code plugins keep theirs where
 * neither harness looks: those are what a scan offers to import.
 */
export const skillDirs = (opts: { home?: string; configHome?: string; fxHome?: string; codexHome?: string } = {}): SkillDirs => {
  const home = opts.home ?? homedir()
  const config = opts.configHome ?? join(home, ".config")
  const target = join(config, "opencode", "skills")
  return {
    target,
    shared: [
      { source: "opencode", dir: target },
      { source: "agents", dir: join(home, ".agents", "skills") },
      { source: "claude", dir: join(home, ".claude", "skills") },
    ],
    fx: join(opts.fxHome ?? join(home, ".fx"), "skills"),
    others: [
      { source: "codex", dir: join(opts.codexHome ?? join(home, ".codex"), "skills") },
      { source: "cursor", dir: join(home, ".cursor", "skills") },
      ...claudePluginDirs(home),
    ],
  }
}

/** Skills folders of the Claude Code plugins you installed (not every plugin of a marketplace). */
const claudePluginDirs = (home: string): { source: SkillSource; dir: string }[] => {
  let raw: { plugins?: Record<string, { installPath?: unknown }[]> }
  try {
    raw = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"))
  } catch {
    return []
  }
  const dirs = Object.values(raw.plugins ?? {}).flatMap((installs) =>
    (Array.isArray(installs) ? installs : []).flatMap((i) => (typeof i?.installPath === "string" ? [join(i.installPath, "skills")] : [])),
  )
  return [...new Set(dirs)].map((dir) => ({ source: "claude-plugin", dir }))
}

/** The value of one frontmatter key: plain, quoted, or a `>` / `|` block on the lines below. */
const frontmatterValue = (lines: string[], key: string) => {
  const at = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (at === -1) return undefined
  const first = lines[at].slice(key.length + 1).trim()
  if (/^[>|][-+]?$/.test(first)) {
    const block: string[] = []
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && !/^\s/.test(l)) break
      block.push(l.trim())
    }
    return block.join(first.startsWith(">") ? " " : "\n").trim() || undefined
  }
  const quoted = /^(["'])(.*)\1$/.exec(first)
  return (quoted ? quoted[2] : first) || undefined
}

/** A skill's name and description from its SKILL.md, or null when the folder has none. */
export const readSkill = (dir: string): { name: string; description?: string } | null => {
  let text: string
  try {
    text = readFileSync(join(dir, "SKILL.md"), "utf8")
  } catch {
    return null
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const lines = fm ? fm[1].split(/\r?\n/) : []
  const folder = dir.split("/").pop()!
  return { name: frontmatterValue(lines, "name") ?? folder, description: frontmatterValue(lines, "description") }
}

/** The skill folders right under `dir` (symlinks followed), skipping dot folders like Codex's `.system`. */
const skillsIn = (dir: string) => {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => !n.startsWith("."))
    .sort()
    .flatMap((folder) => {
      const path = join(dir, folder)
      try {
        if (!statSync(path).isDirectory()) return []
      } catch {
        return []
      }
      const meta = readSkill(path)
      return meta ? [{ folder, path, ...meta }] : []
    })
}

const linkTarget = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : undefined
  } catch {
    return undefined
  }
}

/** Of a skill folder's files, dotfiles at its top (our markers) left out. */
export const hashSkill = (dir: string) => {
  const h = createHash("sha256")
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (!rel && name.startsWith(".")) continue
      const path = join(dir, rel, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(join(rel, name))
      else if (st.isFile()) h.update(join(rel, name)).update(readFileSync(path))
    }
  }
  walk("")
  return h.digest("hex")
}

const readImport = (path: string): { from: string; hash: string } | null => {
  try {
    const raw = JSON.parse(readFileSync(join(path, IMPORT_MARKER), "utf8"))
    return typeof raw?.from === "string" && typeof raw?.hash === "string" ? raw : null
  } catch {
    return null
  }
}

/** Every global skill opencode or fx loads, once per folder name (the first folder in reading order wins). */
export function listSkills(dirs: SkillDirs): SkillItem[] {
  const out = new Map<string, SkillItem>()
  const folders: { source: SkillSource; dir: string; harnesses: Harness[] }[] = [
    ...dirs.shared.map((d) => ({ ...d, harnesses: ["opencode", "fx"] as Harness[] })),
    ...(dirs.fx ? [{ source: "fx" as const, dir: dirs.fx, harnesses: ["fx"] as Harness[] }] : []),
  ]
  for (const { source, dir, harnesses } of folders) {
    for (const s of skillsIn(dir)) {
      const seen = out.get(s.folder)
      if (seen) {
        seen.also = [...(seen.also ?? []), s.path]
        for (const h of harnesses) if (!seen.harnesses.includes(h)) seen.harnesses.push(h)
        continue
      }
      const link = linkTarget(s.path)
      const imported = link ? null : readImport(s.path)
      out.set(s.folder, {
        name: s.folder,
        ...(s.description ? { description: s.description } : {}),
        path: s.path,
        source,
        harnesses: [...harnesses],
        ...(link ? { link } : {}),
        ...(!link && existsSync(join(s.path, CTRL_MARKER)) ? { ctrl: true } : {}),
        ...(imported
          ? {
              imported: {
                from: imported.from,
                state: !readSkill(imported.from) ? "gone" : hashSkill(imported.from) === imported.hash ? "current" : "changed",
              },
            }
          : {}),
      })
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Skills neither harness loads yet, from other agents' folders and fx's own (so opencode gets them too).
 * `available`: a skill by that folder name is loaded by both harnesses already, so importing it would clash.
 */
export function scanSkills(dirs: SkillDirs): DetectedSkill[] {
  const loaded = new Set(dirs.shared.flatMap((d) => skillsIn(d.dir).map((s) => s.folder)))
  const sources = [...(dirs.fx ? [{ source: "fx" as const, dir: dirs.fx }] : []), ...dirs.others]
  const out: DetectedSkill[] = []
  const keys = new Set<string>()
  for (const { source, dir } of sources) {
    for (const s of skillsIn(dir)) {
      if (keys.has(s.path)) continue
      keys.add(s.path)
      out.push({
        key: s.path,
        name: s.folder,
        ...(s.description ? { description: s.description } : {}),
        source,
        available: loaded.has(s.folder),
      })
    }
  }
  return out
}

/** Copies a skill folder into the target folder (links followed), marked with where it came from. */
const copyIn = (from: string, to: string) => {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, dereference: true, filter: (src) => !src.endsWith(`/${IMPORT_MARKER}`) })
  writeFileSync(join(to, IMPORT_MARKER), `${JSON.stringify({ from, hash: hashSkill(from) })}\n`)
}

/**
 * Imports the picked skills of a scan: a copy in opencode's global skills folder, which fx reads too.
 * Skips keys the scan doesn't offer and names both harnesses load already. Returns the names imported.
 */
export function importSkills(dirs: SkillDirs, keys: string[]): string[] {
  const offered = scanSkills(dirs)
  const done: string[] = []
  for (const key of keys) {
    const s = offered.find((o) => o.key === key)
    if (!s || s.available || done.includes(s.name)) continue
    copyIn(s.key, join(dirs.target, s.name))
    done.push(s.name)
  }
  return done
}

/** Copies an imported skill again from where it came from. */
export function updateSkill(dirs: SkillDirs, name: string): SkillItem {
  const skill = listSkills(dirs).find((s) => s.name === name)
  if (!skill) throw new Error(`No skill ${name}`)
  if (!skill.imported) throw new Error(`${name} wasn't imported by ctrl: nothing to update it from`)
  if (skill.imported.state === "gone") throw new Error(`${skill.imported.from} is gone: nothing to update ${name} from`)
  copyIn(skill.imported.from, skill.path)
  return listSkills(dirs).find((s) => s.name === name)!
}

/**
 * Removes a skill from the folders the harnesses read: a symlink is unlinked (what it points to stays), a
 * folder goes through `trash` (the Trash in the app, so it can be put back). Only folders right under one of
 * the skill folders, never anything else. ctrl's own skills are uninstalled from Settings → Agents instead.
 */
export async function removeSkill(dirs: SkillDirs, name: string, trash: (path: string) => Promise<void>): Promise<SkillItem> {
  const skill = listSkills(dirs).find((s) => s.name === name)
  if (!skill) throw new Error(`No skill ${name}`)
  if (skill.ctrl) throw new Error(`${name} is one of ctrl's skills: uninstall it from Settings → Agents`)
  const roots = [...dirs.shared.map((d) => d.dir), ...(dirs.fx ? [dirs.fx] : [])].map((d) => resolve(d))
  // An imported copy goes alone: what it shadows can be where it came from (fx's own folder).
  for (const path of [skill.path, ...(skill.imported ? [] : (skill.also ?? []))]) {
    if (!roots.includes(resolve(dirname(path)))) throw new Error(`${path} isn't in a skills folder`)
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
    else await trash(path)
  }
  return skill
}
