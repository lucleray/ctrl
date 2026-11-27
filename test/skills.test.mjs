// Global skills (src/main/skills.ts): reading SKILL.md, listing what the harnesses load, scanning other agents'
// folders, importing, updating and removing, and the `ctrl skill` handlers built on them.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { load, tmpDir } from "./helpers.mjs"

const tmp = tmpDir("ctrl-skills-test-")
let lib, createHandlers

before(async () => {
  ;[lib, { createHandlers }] = await load(tmp, "src/main/skills.ts", "src/main/cli-handlers.ts")
})

let n = 0
/** A fresh fake home with a skill-writing helper. */
const home = () => {
  const root = join(tmp, `home-${++n}`)
  const dirs = lib.skillDirs({ home: root })
  const skill = (dir, folder, frontmatter = `name: ${folder}\ndescription: ${folder} things`, body = "Do it.") => {
    mkdirSync(join(dir, folder), { recursive: true })
    writeFileSync(join(dir, folder, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`)
    return join(dir, folder)
  }
  return { root, dirs, skill }
}

describe("readSkill", () => {
  test("plain, quoted and folded descriptions; folder name without a name key; null without SKILL.md", () => {
    const { root, skill } = home()
    assert.deepEqual(lib.readSkill(skill(root, "a", 'name: a\ndescription: "Quoted: yes"')), { name: "a", description: "Quoted: yes" })
    assert.deepEqual(lib.readSkill(skill(root, "b", "description: >\n  Folded\n  over lines\nother: x")), {
      name: "b",
      description: "Folded over lines",
    })
    mkdirSync(join(root, "empty"))
    assert.equal(lib.readSkill(join(root, "empty")), null)
  })
})

describe("skills", () => {
  test("list: one item per name, first folder wins, fx-only marked, links followed, dot folders skipped", () => {
    const { root, dirs, skill } = home()
    const [opencode, agents, claude] = dirs.shared.map((d) => d.dir)
    skill(opencode, "pdf")
    const shared = skill(agents, "slack")
    mkdirSync(claude, { recursive: true })
    symlinkSync(shared, join(claude, "slack"))
    skill(claude, "pdf")
    skill(dirs.fx, "fx-thing")
    skill(join(root, ".agents/skills/.hidden"), "x")
    mkdirSync(join(agents, ".system"), { recursive: true })
    writeFileSync(join(agents, ".system", "SKILL.md"), "---\nname: sys\n---\n")

    const items = lib.listSkills(dirs)
    assert.deepEqual(items.map((s) => [s.name, s.source, s.harnesses.join("+")]), [
      ["fx-thing", "fx", "fx"],
      ["pdf", "opencode", "opencode+fx"],
      ["slack", "agents", "opencode+fx"],
    ])
    assert.deepEqual(items.find((s) => s.name === "pdf").also, [join(claude, "pdf")])
    assert.equal(items.find((s) => s.name === "slack").description, "slack things")
  })

  test("scan, import, list as imported, update when the source changes, gone when it's removed", async () => {
    const { root, dirs, skill } = home()
    skill(dirs.shared[1].dir, "pdf")
    const codex = skill(join(root, ".codex/skills"), "pdf")
    const review = skill(join(root, ".codex/skills"), "review")
    mkdirSync(join(review, "scripts"))
    writeFileSync(join(review, "scripts/run.sh"), "echo 1\n")
    const fxOnly = skill(dirs.fx, "fx-thing")
    const plugin = join(root, ".claude/plugins/cache/acme/tools/1.0.0")
    skill(join(plugin, "skills"), "deploy")
    mkdirSync(join(root, ".claude/plugins"), { recursive: true })
    writeFileSync(
      join(root, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "tools@acme": [{ scope: "user", installPath: plugin }] } }),
    )
    const found = lib.scanSkills(lib.skillDirs({ home: root }))
    assert.deepEqual(found.map((s) => [s.name, s.source, s.available]), [
      ["fx-thing", "fx", false],
      ["pdf", "codex", true],
      ["review", "codex", false],
      ["deploy", "claude-plugin", false],
    ])

    const d = lib.skillDirs({ home: root })
    assert.deepEqual(lib.importSkills(d, [codex, review, fxOnly, "/not/offered"]), ["review", "fx-thing"])
    assert.equal(readFileSync(join(d.target, "review/scripts/run.sh"), "utf8"), "echo 1\n")
    let items = lib.listSkills(d)
    assert.deepEqual(items.find((s) => s.name === "review").imported, { from: review, state: "current" })
    assert.deepEqual(items.find((s) => s.name === "fx-thing").harnesses, ["opencode", "fx"])
    assert.equal(lib.scanSkills(d).find((s) => s.name === "review").available, true)

    writeFileSync(join(review, "SKILL.md"), "---\nname: review\ndescription: better\n---\n")
    assert.equal(lib.listSkills(d).find((s) => s.name === "review").imported.state, "changed")
    assert.equal(lib.updateSkill(d, "review").description, "better")
    assert.equal(lib.listSkills(d).find((s) => s.name === "review").imported.state, "current")
    assert.throws(() => lib.updateSkill(d, "pdf"), /wasn't imported/)

    rmSync(fxOnly, { recursive: true })
    items = lib.listSkills(d)
    assert.equal(items.find((s) => s.name === "fx-thing").imported.state, "gone")
    assert.throws(() => lib.updateSkill(d, "fx-thing"), /is gone/)

    // Removing an import leaves its source alone, even when the source is one of the folders the harnesses read.
    const fxShared = skill(dirs.fx, "shared")
    lib.importSkills(d, [fxShared])
    assert.deepEqual(lib.listSkills(d).find((s) => s.name === "shared").also, [fxShared])
    const trashed = []
    await lib.removeSkill(d, "shared", async (p) => trashed.push(p))
    assert.deepEqual(trashed, [join(d.target, "shared")])
  })

  test("remove: trashes folders, unlinks symlinks, refuses ctrl's own skills", async () => {
    const { dirs, skill } = home()
    const [opencode, agents, claude] = dirs.shared.map((d) => d.dir)
    const shared = skill(agents, "slack")
    mkdirSync(claude, { recursive: true })
    symlinkSync(shared, join(claude, "slack"))
    skill(opencode, "ctrl")
    writeFileSync(join(opencode, "ctrl", ".ctrl-skill"), "hash\n")
    const trashed = []
    await lib.removeSkill(dirs, "slack", async (p) => trashed.push(p))
    assert.deepEqual(trashed, [shared])
    assert.equal(existsSync(join(claude, "slack")), false)
    await assert.rejects(lib.removeSkill(dirs, "ctrl", async () => {}), /ctrl's skills/)
    await assert.rejects(lib.removeSkill(dirs, "nope", async () => {}), /No skill/)
  })
})

describe("skill handlers", () => {
  const call = (handlers, command, args) => handlers[command](args, { v: 1, command, args, caller: {} }, {})

  test("list, scan --apply --skip, update and remove (imported only)", async () => {
    const { root, dirs, skill } = home()
    skill(dirs.shared[1].dir, "mine")
    skill(join(root, ".codex/skills"), "review")
    skill(join(root, ".codex/skills"), "pdf")
    const trashed = []
    const host = {
      store: { data: { settings: {} } },
      skills: {
        list: () => lib.listSkills(dirs),
        scan: () => lib.scanSkills(dirs),
        import: (keys) => lib.importSkills(dirs, keys),
        update: (name) => lib.updateSkill(dirs, name),
        removeImported: async (name) => (await lib.removeSkill(dirs, name, async (p) => trashed.push(p)), true),
      },
    }
    const h = createHandlers(host)
    assert.deepEqual(call(h, "skill scan", {}).imported, [])
    assert.deepEqual(call(h, "skill scan", { apply: true, skip: ["pdf"] }).imported, ["review"])
    assert.deepEqual(call(h, "skill list", {}).items.map((s) => s.name), ["mine", "review"])
    assert.equal(call(h, "skill update", { name: "review" }).item.imported.state, "current")
    assert.throws(() => call(h, "skill update", { name: "nope" }), { code: "NOT_FOUND" })
    await assert.rejects(call(h, "skill remove", { name: "mine" }), { code: "CONFLICT" })
    assert.deepEqual(await call(h, "skill remove", { name: "review" }), { name: "review", changed: true })
    assert.deepEqual(trashed, [join(dirs.target, "review")])
    assert.deepEqual(await call(h, "skill remove", { name: "gone" }), { name: "gone", changed: false })
  })
})
