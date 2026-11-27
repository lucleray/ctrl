import { useState } from "react"
import type { AuditedSkill, Harness, SkillAudit, SkillCopy } from "../shared/types"
import { age, shortPath } from "./format"
import { Icon } from "./icons"

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const parent = (path: string) => path.replace(/\/[^/]+$/, "")
const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)

const AGENTS: Record<NonNullable<SkillCopy["agent"]>, string> = {
  codex: "Codex",
  cursor: "Cursor",
  "claude-plugin": "Claude Code plugin",
}

/** Where a copy lives: its folder, or the agent it belongs to, and where a link points. */
const copyText = (c: SkillCopy) => {
  const where = c.agent ? (c.plugin ? `${AGENTS[c.agent]} ${c.plugin}` : AGENTS[c.agent]) : shortPath(parent(c.path))
  return c.link ? `${where} (link to ${shortPath(c.link)})` : where
}

/** The folder every harness reads, to suggest for a skill only some of them load: ~/.agents/skills if it's one. */
const sharedFolder = (audit: SkillAudit) => {
  const [first, ...rest] = audit.harnesses
  const shared = (first?.folders ?? []).filter((f) => rest.every((h) => h.folders.includes(f)))
  return shared.find((f) => f.endsWith("/.agents/skills")) ?? shared[0]
}

/** What's off about a skill, in a sentence, or nothing. */
function skillHint(skill: AuditedSkill, audit: SkillAudit): string | undefined {
  const all = audit.harnesses.map((h) => h.harness)
  const missing = all.filter((h) => !skill.harnesses.includes(h))
  if (skill.harnesses.length && missing.length) {
    const shared = sharedFolder(audit)
    return `${list(missing)} ${missing.length === 1 ? "doesn't" : "don't"} read ${skill.copies.length === 1 ? "that folder" : "those folders"}.${
      shared ? ` In ${shortPath(shared)}, every harness would see it.` : ""
    }`
  }
  if (skill.differs) return "Its copies differ, so each harness may load a different version, depending on which folder it reads first."
}

function HarnessChips({ skill, harnesses }: { skill: AuditedSkill; harnesses: Harness[] }) {
  return (
    <div className="tool-harnesses">
      {harnesses.map((h) => {
        const on = skill.harnesses.includes(h)
        return (
          <span key={h} className="tool-harness">
            <span className={`mcp-dot ${on ? "connected" : "disabled"}`} />
            <span className={`adapter-status ${on ? "connected" : "disabled"}`}>
              {h} {on ? "loads it" : "doesn't see it"}
            </span>
          </span>
        )
      })}
    </div>
  )
}

function SkillRow({ skill, audit }: { skill: AuditedSkill; audit: SkillAudit }) {
  const harnesses = audit.harnesses.map((h) => h.harness)
  const hint = skillHint(skill, audit)
  const where = [...new Set(skill.copies.map(copyText))]
  return (
    <div className="setting skill-row">
      <div style={{ minWidth: 0 }}>
        <div className="setting-title">{skill.name}</div>
        {skill.description && (
          <div className="setting-desc skill-desc" title={skill.description}>
            {skill.description}
          </div>
        )}
        <div className="setting-desc skill-source" title={skill.copies.map((c) => shortPath(c.path)).join("\n")}>
          {where.join(" · ")}
        </div>
        {hint && <div className="setting-desc skill-hint">{hint}</div>}
        {skill.harnesses.length > 0 && <HarnessChips skill={skill} harnesses={harnesses} />}
      </div>
      <div className="mcp-actions">
        <button
          className="icon-btn"
          title={`Show in Finder (${shortPath(skill.copies[0].path)})`}
          onClick={() => void window.ctrl.revealPath(skill.copies[0].path)}
        >
          <Icon name="folder" />
        </button>
      </div>
    </div>
  )
}

/**
 * Settings → Skills: an audit of what agents see. Every skill on this Mac by name, which harness loads it and
 * from where, what's off (only some harnesses see it, copies that differ), other agents' skills no session
 * sees, and the folders each harness reads. Read only: ctrl scans on its own, Scan does it now.
 */
export function SkillsSection({ audit }: { audit: SkillAudit | null }) {
  const [scanning, setScanning] = useState(false)
  const scan = () => {
    setScanning(true)
    void window.ctrl.scanSkills().finally(() => setScanning(false))
  }

  const header = (text: string) => (
    <div className="tools-header">
      <div className="setting-desc">{text}</div>
      <button className="btn" disabled={scanning} onClick={scan}>
        {scanning ? "Scanning…" : "Scan"}
      </button>
    </div>
  )
  if (!audit) return header("Shows every skill on this Mac and which harness loads it. Scanning…")

  const all = audit.harnesses.length
  const off = audit.items.filter((s) => s.harnesses.length && (s.harnesses.length < all || s.differs))
  const everywhere = audit.items.filter((s) => s.harnesses.length === all && !s.differs)
  const elsewhere = audit.items.filter((s) => !s.harnesses.length)
  const names = list(audit.harnesses.map((h) => h.harness))
  const when = age(audit.scannedAt) === "now" ? "just now" : `${age(audit.scannedAt)} ago`
  const summary = [
    `${count(everywhere.length, "skill", "skills")} in ${all > 1 ? "every harness" : names}`,
    off.length ? `${off.length} to look at` : "",
    elsewhere.length ? `${elsewhere.length} only in other agents` : "",
  ]
    .filter(Boolean)
    .join(", ")

  const card = (items: AuditedSkill[], empty: string) => (
    <div className="settings-card">
      {items.length ? (
        items.map((skill) => <SkillRow key={skill.name} skill={skill} audit={audit} />)
      ) : (
        <div className="setting">
          <div className="setting-desc">{empty}</div>
        </div>
      )}
    </div>
  )

  return (
    <>
      {header(`${summary}. Scanned ${when}: ctrl looks again when Settings opens and every few hours.`)}
      {off.length > 0 && (
        <>
          <h3 className="settings-subhead">Needs a look</h3>
          {card(off, "")}
        </>
      )}
      <h3 className="settings-subhead">In {names}</h3>
      {card(everywhere, off.length ? "None that every harness loads the same way." : "No global skills yet.")}
      {elsewhere.length > 0 && (
        <>
          <h3 className="settings-subhead">Only in other agents</h3>
          <div className="setting-desc settings-subdesc">
            In folders of Codex, Cursor or Claude Code plugins, which {names} don't read: your sessions don't see them.
          </div>
          {card(elsewhere, "")}
        </>
      )}
      <h3 className="settings-subhead">Where each harness looks</h3>
      <div className="settings-card">
        {audit.harnesses.map(({ harness, folders }) => (
          <div key={harness} className="setting">
            <div style={{ minWidth: 0 }}>
              <div className="setting-title">{harness}</div>
              <div className="setting-desc skill-folders">
                {folders.map((f) => {
                  const n = audit.items.filter((s) => s.copies.some((c) => parent(c.path) === f)).length
                  return (
                    <div key={f}>
                      {shortPath(f)} <span className="skill-count">{n ? count(n, "skill", "skills") : "empty"}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
