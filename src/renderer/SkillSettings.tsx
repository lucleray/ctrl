import { useCallback, useEffect, useState } from "react"
import type { DetectedSkill, SkillItem, SkillSource } from "../shared/types"
import { shortPath } from "./format"
import { Icon } from "./icons"

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Scan groups, in order: fx's own skills first (importing shares them with opencode), then other agents'. */
const SCAN_GROUPS: { source: SkillSource; label: string }[] = [
  { source: "fx", label: "fx only" },
  { source: "claude-plugin", label: "Claude Code plugins" },
  { source: "codex", label: "Codex" },
  { source: "cursor", label: "Cursor" },
]

/** Where an imported copy came from, named by the agent: "Codex", or the folder when it's none we know. */
const fromText = (from: string) => {
  if (/\/\.codex\//.test(from)) return "Codex"
  if (/\/\.cursor\//.test(from)) return "Cursor"
  if (/\/\.claude\/plugins\//.test(from)) return "a Claude Code plugin"
  if (/\/\.fx\//.test(from)) return "fx"
  return shortPath(from)
}

/**
 * Lists the skills in other agents' folders (Claude Code plugins, Codex, Cursor) and fx's own, all checked,
 * to import. Ones both harnesses load already show as such, without a checkbox: a scan only adds.
 */
export function SkillScan({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const [found, setFound] = useState<DetectedSkill[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.ctrl.scanSkills().then(
      (items) => {
        if (!live) return
        setFound(items)
        setChecked(new Set(items.filter((s) => !s.available).map((s) => s.key)))
      },
      (err) => live && setError(errorText(err)),
    )
    return () => {
      live = false
    }
  }, [])

  const apply = () => {
    setBusy(true)
    void window.ctrl
      .importSkills([...checked])
      .then(onDone, (err) => setError(errorText(err)))
      .finally(() => setBusy(false))
  }

  if (error) return <div className="tool-scan setting-desc mcp-error">Couldn't scan: {error}</div>
  if (!found) return <div className="tool-scan setting-desc">Looking for skills…</div>

  const fresh = found.filter((s) => !s.available)
  const picked = fresh.filter((s) => checked.has(s.key))
  const setAll = (keys: string[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      for (const key of keys) on ? next.add(key) : next.delete(key)
      return next
    })
  const groups = SCAN_GROUPS.map((g) => ({ ...g, items: found.filter((s) => s.source === g.source) })).filter((g) => g.items.length)
  const title =
    found.length === 0
      ? "Found no skills to import"
      : fresh.length === 0
        ? "Nothing new: opencode and fx load every skill it found"
        : `Found ${count(fresh.length, "skill", "skills")} to import`

  return (
    <div className="tool-scan">
      <div className="tool-scan-summary">
        <Icon name="check" />
        <div>
          <div className="setting-title">{title}</div>
          <div className="setting-desc">
            {found.length === 0
              ? "ctrl looks in fx's skills folder, Claude Code plugins, Codex and Cursor."
              : "Imported skills are copied into opencode's global skills folder, which fx reads too."}
          </div>
        </div>
      </div>
      {groups.length > 0 && (
        <div className="tool-scan-list">
          {groups.map(({ label, items }) => {
            const add = items.filter((s) => !s.available)
            const available = items.filter((s) => s.available)
            const allOn = add.every((s) => checked.has(s.key))
            return (
              <div key={label}>
                <div className="tool-scan-group">
                  <span>{label}</span>
                  {add.length > 1 && (
                    <button className="text-btn" onClick={() => setAll(add.map((s) => s.key), !allOn)}>
                      {allOn ? "Select none" : "Select all"}
                    </button>
                  )}
                </div>
                {add.map((s) => (
                  <label key={s.key} className="tool-scan-item" title={shortPath(s.key)}>
                    <input type="checkbox" checked={checked.has(s.key)} onChange={() => setAll([s.key], !checked.has(s.key))} />
                    <span className="setting-title">{s.name}</span>
                    <span className="setting-desc" title={s.description}>
                      {s.description}
                    </span>
                  </label>
                ))}
                {available.map((s) => (
                  <div key={s.key} className="tool-scan-item watched" title={shortPath(s.key)}>
                    <Icon name="check" />
                    <span className="setting-title">{s.name}</span>
                    <span className="setting-desc">Already available</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
      <div className="setting-actions tool-scan-actions">
        {fresh.length > 0 && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={busy || (picked.length === 0 && fresh.length > 0)} onClick={fresh.length ? apply : onDone}>
          {fresh.length === 0
            ? "Done"
            : picked.length === fresh.length && fresh.length > 1
              ? `Import all ${fresh.length}`
              : `Import ${picked.length}`}
        </button>
      </div>
    </div>
  )
}

/** Where a skill comes from and which harness loads it, under its description. */
function skillStatus(skill: SkillItem) {
  const parts: string[] = []
  if (skill.ctrl) parts.push("ctrl's skill, managed in Agents")
  else if (skill.imported) {
    const from = fromText(skill.imported.from)
    parts.push(
      skill.imported.state === "changed"
        ? `Changed in ${from} since you imported it`
        : skill.imported.state === "gone"
          ? `Imported from ${from}, no longer there`
          : `Imported from ${from}`,
    )
  } else parts.push(shortPath(skill.path.replace(/\/[^/]+$/, "")))
  if (!skill.harnesses.includes("opencode")) parts.push("fx only")
  return parts.join(" · ")
}

function SkillRow({ skill, onChange }: { skill: SkillItem; onChange(): void }) {
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<void>) => {
    setBusy(true)
    void action().finally(() => {
      setBusy(false)
      onChange()
    })
  }
  const changed = skill.imported?.state === "changed"
  const where = [skill.path, ...(skill.link ? [`→ ${skill.link}`] : []), ...(skill.also ?? []).map((p) => `also ${p}`)]
    .map(shortPath)
    .join("\n")
  return (
    <div className="setting skill-row">
      <div style={{ minWidth: 0 }}>
        <div className="setting-title">{skill.name}</div>
        {skill.description && (
          <div className="setting-desc skill-desc" title={skill.description}>
            {skill.description}
          </div>
        )}
        <div className={`setting-desc skill-source${changed ? " pending" : ""}`} title={where}>
          {skillStatus(skill)}
        </div>
      </div>
      <div className="mcp-actions">
        {changed && (
          <button className="btn" disabled={busy} onClick={() => run(() => window.ctrl.updateSkill(skill.name))}>
            Update
          </button>
        )}
        <button className="icon-btn" title={`Show in Finder (${shortPath(skill.path)})`} onClick={() => void window.ctrl.revealPath(skill.path)}>
          <Icon name="folder" />
        </button>
        {!skill.ctrl && (
          <button
            className="icon-btn"
            disabled={busy}
            title={skill.link && !skill.also?.length ? "Remove the link" : "Move to the Trash"}
            onClick={() => run(() => window.ctrl.removeSkill(skill.name))}
          >
            <Icon name="trash" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Settings → Skills: the global skills opencode and fx load, one row each (where it comes from, Update for an
 * import whose source changed, Show in Finder, Remove), and a Scan that imports skills from other agents.
 */
export function SkillsSection() {
  const [skills, setSkills] = useState<SkillItem[] | null>(null)
  const [error, setError] = useState<string>()
  const [scanning, setScanning] = useState(false)

  const load = useCallback(() => {
    window.ctrl.listSkills().then(
      (items) => (setSkills(items), setError(undefined)),
      (err) => setError(errorText(err)),
    )
  }, [])
  useEffect(load, [load])

  const done = () => {
    setScanning(false)
    load()
  }
  const shared = skills?.filter((s) => s.harnesses.includes("opencode")).length ?? 0
  const fxOnly = (skills?.length ?? 0) - shared

  return (
    <>
      {scanning ? (
        <div className="settings-card">
          <div className="setting setting-stack">
            <SkillScan onDone={done} onCancel={() => setScanning(false)} />
          </div>
        </div>
      ) : (
        <div className="tools-header">
          <div className="setting-desc">
            {skills
              ? `${count(shared, "skill", "skills")} loaded by opencode and fx${fxOnly ? `, ${fxOnly} by fx only` : ""}. Scan to import skills from Claude Code plugins, Codex, Cursor and fx.`
              : "Scan to import skills from Claude Code plugins, Codex, Cursor and fx."}
          </div>
          <button className="btn" onClick={() => setScanning(true)}>
            Scan
          </button>
        </div>
      )}
      <h3 className="settings-subhead">Your skills</h3>
      <div className="settings-card">
        {error ? (
          <div className="setting">
            <div className="setting-desc mcp-error">Couldn't read your skills: {error}</div>
          </div>
        ) : !skills ? (
          <div className="setting">
            <div className="setting-desc">Reading your skills…</div>
          </div>
        ) : skills.length ? (
          skills.map((skill) => <SkillRow key={skill.name} skill={skill} onChange={load} />)
        ) : (
          <div className="setting">
            <div className="setting-desc">No global skills yet. Scan to import the ones other agents have.</div>
          </div>
        )}
      </div>
    </>
  )
}
