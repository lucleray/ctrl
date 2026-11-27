import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AuditedSkill, Harness, SkillAgent, SkillAudit, SkillCopy } from "../shared/types"

/** A harness and the global folders it loads skills from, in its order (HarnessSource.skillFolders). */
export type SkillReader = { harness: Harness; folders: string[] }

/** Descriptions can be long: the list shows two lines, the CLI a sentence or two. */
const DESCRIPTION_MAX = 400

/**
 * Other agents' skill folders, which no harness of ctrl's reads: Codex, Cursor and the Claude Code plugins you
 * installed (not every plugin of a marketplace). A scan shows their skills so you can tell why a session
 * doesn't see one.
 */
export const agentSkillFolders = (
  opts: { home?: string; codexHome?: string } = {},
): { dir: string; agent: SkillAgent; plugin?: string }[] => {
  const home = opts.home ?? homedir()
  return [
    { dir: join(opts.codexHome ?? join(home, ".codex"), "skills"), agent: "codex" },
    { dir: join(home, ".cursor", "skills"), agent: "cursor" },
    ...claudePlugins(home),
  ]
}

const claudePlugins = (home: string): { dir: string; agent: SkillAgent; plugin: string }[] => {
  let raw: { plugins?: Record<string, { installPath?: unknown }[]> }
  try {
    raw = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"))
  } catch {
    return []
  }
  const out = new Map<string, { dir: string; agent: SkillAgent; plugin: string }>()
  for (const [id, installs] of Object.entries(raw.plugins ?? {})) {
    for (const i of Array.isArray(installs) ? installs : []) {
      if (typeof i?.installPath !== "string") continue
      const dir = join(i.installPath, "skills")
      out.set(dir, { dir, agent: "claude-plugin", plugin: id.split("@")[0] })
    }
  }
  return [...out.values()]
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
  const description = frontmatterValue(lines, "description")
  return {
    name: frontmatterValue(lines, "name") ?? dir.split("/").pop()!,
    ...(description ? { description: description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 1)}…` : description } : {}),
  }
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

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const linkTarget = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined
  } catch {
    return undefined
  }
}

/** Of a skill folder's files, dotfiles at its top left out. */
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

/**
 * Every skill on this Mac by folder name: each copy, which harness loads it, and other agents' copies that
 * none does. Read only: it never changes a skill. Reads folders and SKILL.md files; hashes files only for a
 * name a harness loads from more than one place.
 */
export function auditSkills(readers: SkillReader[], others = agentSkillFolders(), now = Date.now()): SkillAudit {
  const byName = new Map<string, { copies: SkillCopy[]; description?: string }>()
  const copyAt = (folder: string, path: string, description?: string) => {
    let entry = byName.get(folder)
    if (!entry) byName.set(folder, (entry = { copies: [], description }))
    const seen = entry.copies.find((c) => c.path === path)
    if (seen) return seen
    const copy: SkillCopy = { path, harnesses: [] }
    const link = linkTarget(path)
    if (link) copy.link = link
    entry.copies.push(copy)
    return copy
  }

  for (const { harness, folders } of readers) {
    for (const dir of folders) {
      for (const s of skillsIn(dir)) {
        const copy = copyAt(s.folder, s.path, s.description)
        if (!copy.harnesses.includes(harness)) copy.harnesses.push(harness)
      }
    }
  }
  for (const { dir, agent, plugin } of others) {
    for (const s of skillsIn(dir)) {
      const copy = copyAt(s.folder, s.path, s.description)
      if (!copy.harnesses.length) Object.assign(copy, { agent }, plugin ? { plugin } : {})
    }
  }

  const items: AuditedSkill[] = [...byName].map(([name, { copies, description }]) => {
    const harnesses = readers.map((r) => r.harness).filter((h) => copies.some((c) => c.harnesses.includes(h)))
    // Links to the same folder are one copy; different folders a harness loads may hold different files.
    const loaded = [...new Set(copies.filter((c) => c.harnesses.length).map((c) => real(c.path)))]
    const differs = loaded.length > 1 && new Set(loaded.map(hashSkill)).size > 1
    return {
      name,
      ...(description ? { description } : {}),
      harnesses,
      copies,
      ...(differs ? { differs: true } : {}),
    }
  })
  items.sort((a, b) => a.name.localeCompare(b.name))
  return { scannedAt: now, harnesses: readers.map((r) => ({ harness: r.harness, folders: r.folders })), items }
}
