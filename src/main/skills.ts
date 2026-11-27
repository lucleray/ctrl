import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AuditedSkill, Harness, SkillAudit, SkillCopy } from "../shared/types"

/** A harness and the global folders it loads skills from, in its order (HarnessSource.skillFolders). */
export type SkillReader = { harness: Harness; folders: string[] }

/** Descriptions can be long: the list shows two lines, the CLI a sentence or two. */
const DESCRIPTION_MAX = 400

/**
 * Other agents' skill folders, which no harness of ctrl's reads: Codex, Cursor and the Claude Code plugins you
 * installed (not every plugin of a marketplace). A scan lists their skills too, loaded by no harness.
 */
export const agentSkillFolders = (opts: { home?: string; codexHome?: string } = {}): string[] => {
  const home = opts.home ?? homedir()
  return [join(opts.codexHome ?? join(home, ".codex"), "skills"), join(home, ".cursor", "skills"), ...claudePlugins(home)]
}

const claudePlugins = (home: string): string[] => {
  let raw: { plugins?: Record<string, { installPath?: unknown }[]> }
  try {
    raw = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"))
  } catch {
    return []
  }
  const dirs = Object.values(raw.plugins ?? {}).flatMap((installs) =>
    (Array.isArray(installs) ? installs : []).flatMap((i) => (typeof i?.installPath === "string" ? [join(i.installPath, "skills")] : [])),
  )
  return [...new Set(dirs)]
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

const linkTarget = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined
  } catch {
    return undefined
  }
}

/**
 * Every skill on this Mac by folder name: each folder it's in, and which harness loads it. Other agents'
 * folders come last, loaded by none. Read only: folders and SKILL.md files, nothing else.
 */
export function auditSkills(readers: SkillReader[], others = agentSkillFolders(), now = Date.now(), home = homedir()): SkillAudit {
  const byName = new Map<string, { copies: SkillCopy[]; description?: string }>()
  const copyAt = (folder: string, path: string, description?: string) => {
    let entry = byName.get(folder)
    if (!entry) byName.set(folder, (entry = { copies: [], description }))
    let copy = entry.copies.find((c) => c.path === path)
    if (!copy) {
      const link = linkTarget(path)
      entry.copies.push((copy = { path, harnesses: [], ...(link ? { link } : {}) }))
    }
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
  for (const dir of others) for (const s of skillsIn(dir)) copyAt(s.folder, s.path, s.description)

  const items: AuditedSkill[] = [...byName].map(([name, { copies, description }]) => ({
    name,
    ...(description ? { description } : {}),
    harnesses: readers.map((r) => r.harness).filter((h) => copies.some((c) => c.harnesses.includes(h))),
    copies,
  }))
  items.sort((a, b) => a.name.localeCompare(b.name))
  return { scannedAt: now, home, harnesses: readers.map((r) => ({ harness: r.harness, folders: r.folders })), items }
}
