import { useState } from "react"
import type { AuditedSkill, Harness, SkillAudit } from "../shared/types"
import { age } from "./format"
import { Icon } from "./icons"

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const parent = (path: string) => path.replace(/\/[^/]+$/, "")

/** One skill: its name, the folders it's in, and a dot per harness (green: loads it, orange: doesn't). */
function SkillRow({ skill, harnesses, short }: { skill: AuditedSkill; harnesses: Harness[]; short(path: string): string }) {
  return (
    <div className="setting skill-row">
      <div style={{ minWidth: 0 }}>
        <div className="setting-title" title={skill.description}>
          {skill.name}
        </div>
        {skill.copies.map((c) => (
          <div key={c.path} className="setting-desc skill-source" title={c.path}>
            {short(parent(c.path))}
            {c.link && ` → ${short(c.link)}`}
          </div>
        ))}
        <div className="tool-harnesses">
          {harnesses.map((h) => {
            const dot = skill.harnesses.includes(h) ? "connected" : "pending"
            return (
              <span key={h} className="tool-harness">
                <span className={`mcp-dot ${dot}`} />
                <span className={`adapter-status ${dot}`}>{dot === "connected" ? h : `${h} does not load it`}</span>
              </span>
            )
          })}
        </div>
      </div>
      <div className="mcp-actions">
        <button className="icon-btn" title="Show in Finder" onClick={() => void window.ctrl.revealPath(skill.copies[0].path)}>
          <Icon name="folder" />
        </button>
      </div>
    </div>
  )
}

/**
 * Settings → Skills: every skill on this Mac, the folders it's in, and whether each harness loads it.
 * Read only. ctrl scans on its own (launch, Settings opening, every few hours); Scan does it now.
 */
export function SkillsSection({ audit }: { audit: SkillAudit | null }) {
  const [scanning, setScanning] = useState(false)
  const scan = () => {
    setScanning(true)
    void window.ctrl.scanSkills().finally(() => setScanning(false))
  }
  const harnesses = audit?.harnesses.map((h) => h.harness) ?? []
  const partial = audit?.items.filter((s) => s.harnesses.length < harnesses.length).length ?? 0
  const when = audit && (age(audit.scannedAt) === "now" ? "just now" : `${age(audit.scannedAt)} ago`)
  const short = (path: string) => (audit && (path === audit.home || path.startsWith(`${audit.home}/`)) ? `~${path.slice(audit.home.length)}` : path)

  return (
    <>
      <div className="tools-header">
        <div className="setting-desc">
          {audit
            ? `${count(audit.items.length, "skill", "skills")} on this Mac${partial ? `, ${partial} not loaded by every harness` : ""}. Scanned ${when}.`
            : "Looking for skills…"}
        </div>
        <button className="btn" disabled={scanning} onClick={scan}>
          {scanning ? "Scanning…" : "Scan"}
        </button>
      </div>
      {audit && (
        <div className="settings-card skills-list">
          {audit.items.length ? (
            audit.items.map((skill) => <SkillRow key={skill.name} skill={skill} harnesses={harnesses} short={short} />)
          ) : (
            <div className="setting">
              <div className="setting-desc">No skills found.</div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
