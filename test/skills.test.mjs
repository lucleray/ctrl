// The skills audit (src/main/skills.ts): reading SKILL.md, which harness loads each skill and from where,
// other agents' skills, and the `ctrl skill list / scan` handlers.
import assert from "node:assert/strict"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-skills-test-")
let lib, createHandlers

before(async () => {
  ;[lib, { createHandlers }] = await load(tmp, "src/main/skills.ts", "src/main/cli-handlers.ts")
})

let n = 0
/** A fake home with the folders opencode and fx read, and a skill-writing helper. */
const home = () => {
  const root = join(tmp, `home-${++n}`)
  const f = {
    opencode: join(root, ".config/opencode/skills"),
    claude: join(root, ".claude/skills"),
    agents: join(root, ".agents/skills"),
    fx: join(root, ".fx/skills"),
  }
  const readers = [
    { harness: "opencode", folders: [f.opencode, f.claude, f.agents] },
    { harness: "fx", folders: [f.fx, f.agents, f.claude, f.opencode] },
  ]
  const skill = (dir, folder, description = `${folder} things`) => {
    mkdirSync(join(dir, folder), { recursive: true })
    writeFileSync(join(dir, folder, "SKILL.md"), `---\nname: ${folder}\ndescription: ${description}\n---\n\nDo it.\n`)
    return join(dir, folder)
  }
  return { root, f, readers, skill, others: () => lib.agentSkillFolders({ home: root }) }
}

describe("readSkill", () => {
  test("plain, quoted and folded descriptions; folder name without a name key; null without SKILL.md", () => {
    const { root } = home()
    const write = (folder, fm) => {
      mkdirSync(join(root, folder), { recursive: true })
      writeFileSync(join(root, folder, "SKILL.md"), `---\n${fm}\n---\n`)
      return join(root, folder)
    }
    assert.deepEqual(lib.readSkill(write("a", 'name: a\ndescription: "Quoted: yes"')), { name: "a", description: "Quoted: yes" })
    assert.deepEqual(lib.readSkill(write("b", "description: >\n  Folded\n  over lines\nother: x")), { name: "b", description: "Folded over lines" })
    assert.equal(lib.readSkill(write("c", `description: ${"x".repeat(500)}`)).description.length, 400)
    mkdirSync(join(root, "empty"))
    assert.equal(lib.readSkill(join(root, "empty")), null)
  })
})

describe("auditSkills", () => {
  test("which harness loads each skill, from which folders; links are one copy; dot folders skipped", () => {
    const { f, readers, skill, others } = home()
    skill(f.opencode, "pdf")
    const slack = skill(f.agents, "slack")
    mkdirSync(f.claude, { recursive: true })
    symlinkSync(slack, join(f.claude, "slack"))
    skill(f.fx, "changelog")
    skill(join(f.agents, ".system"), "hidden")
    const audit = lib.auditSkills(readers, others(), 1000, "/Users/me")
    assert.equal(audit.scannedAt, 1000)
    assert.equal(audit.home, "/Users/me")
    assert.deepEqual(audit.harnesses.map((h) => h.harness), ["opencode", "fx"])
    assert.deepEqual(audit.items.map((s) => [s.name, s.harnesses.join("+")]), [
      ["changelog", "fx"],
      ["pdf", "opencode+fx"],
      ["slack", "opencode+fx"],
    ])
    const s = audit.items.find((i) => i.name === "slack")
    assert.equal(s.description, "slack things")
    assert.deepEqual(s.copies.map((c) => [c.path, c.harnesses.join("+"), c.link ?? null]), [
      [join(f.claude, "slack"), "opencode+fx", slack],
      [slack, "opencode+fx", null],
    ])
  })

  test("other agents' skills: Codex, Cursor and installed Claude Code plugins, loaded by no harness", () => {
    const { root, f, readers, skill, others } = home()
    skill(f.agents, "pdf")
    skill(join(root, ".codex/skills"), "pdf")
    skill(join(root, ".codex/skills"), "review")
    skill(join(root, ".cursor/skills"), "storybook")
    const plugin = join(root, ".claude/plugins/cache/acme/frontend/1.0.0")
    skill(join(plugin, "skills"), "a11y")
    skill(join(root, ".claude/plugins/marketplaces/acme/other/skills"), "not-installed")
    writeFileSync(
      join(root, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "frontend@acme": [{ scope: "user", installPath: plugin }] } }),
    )
    const audit = lib.auditSkills(readers, others())
    assert.deepEqual(audit.items.map((s) => [s.name, s.harnesses.join("+") || "-", s.copies.map((c) => c.harnesses.length).join(",")]), [
      ["a11y", "-", "0"],
      ["pdf", "opencode+fx", "2,0"],
      ["review", "-", "0"],
      ["storybook", "-", "0"],
    ])
    assert.deepEqual(audit.items[1].copies.map((c) => c.path), [join(f.agents, "pdf"), join(root, ".codex/skills/pdf")])
    assert.equal(audit.items[0].copies[0].path, join(plugin, "skills/a11y"))
  })
})

describe("skill handlers", () => {
  const call = (handlers, command, args) => handlers[command](args, { v: 1, command, args, caller: {} }, {})

  test("list answers from the last scan, scan rescans, --partial keeps what a harness doesn't load", () => {
    const { f, readers, skill } = home()
    skill(f.agents, "shared")
    skill(f.fx, "fx-only")
    let scans = 0
    let last
    const host = { store: { data: { settings: {} } }, skills: (rescan) => (rescan || !last ? ((scans++, (last = lib.auditSkills(readers, [])))) : last) }
    const h = createHandlers(host)
    assert.deepEqual(call(h, "skill list", {}).items.map((s) => s.name), ["fx-only", "shared"])
    call(h, "skill list", {})
    assert.equal(scans, 1)
    assert.deepEqual(call(h, "skill scan", { partial: true }).items.map((s) => s.name), ["fx-only"])
    assert.equal(scans, 2)
  })
})
