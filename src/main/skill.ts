import { createHash } from "node:crypto"
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SkillStatus } from "../shared/types"

const NAME = "read-session"
/** In ctrl's copy only: hash of the source it was copied from. No marker = not ours, never touched. */
const MARKER = ".ctrl-skill"
/** Path of ctrl's executable, so digest.sh can run as node when node isn't installed. */
const EXEC_FILE = ".ctrl-exec"

/**
 * Installs the read-session skill into opencode's global skills folder, as a copy ctrl
 * manages (refreshed when ctrl's version of it changes). Copies ctrl didn't make, like a
 * dev symlink or one in ~/.agents/skills, are reported as "external" and left alone.
 */
export class Skill {
  private target: string
  /** Other folders opencode reads skills from; a copy there means it's installed already. */
  private elsewhere: string[]

  constructor(private source: string) {
    // CTRL_SKILLS_DIR is a test hook (README): it also stops looking at the real folders.
    const override = process.env.CTRL_SKILLS_DIR
    const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    this.target = join(override || join(config, "opencode", "skills"), NAME)
    this.elsewhere = override
      ? []
      : [join(homedir(), ".agents/skills", NAME), join(homedir(), ".claude/skills", NAME)]
    this.refresh()
  }

  private sourceHash?: string
  /** Cached: it's part of every state push. refresh() after anything that may change it. */
  current: SkillStatus = { state: "missing" }

  refresh() {
    this.current = this.read()
    return this.current
  }

  /** Of ctrl's bundled copy, which only changes with ctrl itself. */
  private hash() {
    if (this.sourceHash) return this.sourceHash
    const h = createHash("sha256")
    for (const file of readdirSync(this.source).filter((f) => !f.startsWith(".")).sort()) {
      h.update(file).update(readFileSync(join(this.source, file)))
    }
    return (this.sourceHash = h.digest("hex"))
  }

  /** ctrl's copy: a real folder with our marker in it. */
  private managed() {
    try {
      return !lstatSync(this.target).isSymbolicLink() && existsSync(join(this.target, MARKER))
    } catch {
      return false
    }
  }

  private read(): SkillStatus {
    if (existsSync(this.target) || this.isLink(this.target)) {
      if (!this.managed()) return { state: "external", path: this.target }
      const current = readFileSync(join(this.target, MARKER), "utf8").trim() === this.hash()
      return { state: current ? "installed" : "outdated", path: this.target }
    }
    const other = this.elsewhere.find((p) => existsSync(p))
    return other ? { state: "external", path: other } : { state: "missing" }
  }

  private isLink(path: string) {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  }

  install() {
    if (this.refresh().state === "external") throw new Error(`${this.target} isn't managed by ctrl, not overwriting it`)
    rmSync(this.target, { recursive: true, force: true })
    cpSync(this.source, this.target, { recursive: true })
    writeFileSync(join(this.target, MARKER), `${this.hash()}\n`)
    writeFileSync(join(this.target, EXEC_FILE), `${process.execPath}\n`)
    this.refresh()
  }

  uninstall() {
    if (this.managed()) rmSync(this.target, { recursive: true, force: true })
    this.refresh()
  }
}
