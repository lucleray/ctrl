import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_SOUND_CHOICES, type AgentOrigin, FONT_SIZE, type Settings, type Space, type SpacePatch, type UiState } from "../shared/types"
import type { Unstarted } from "./unstarted"

/** A draft is a message, not a document: anything longer is cut, so state.json stays small. */
export const DRAFT_MAX = 64 * 1024

const DEFAULT_UI: UiState = {
  recentsCollapsed: false,
  archivedCollapsed: true,
  sidebarWidth: 280,
  resourcesOpen: true,
  resourcesWidth: 300,
}
const DEFAULT_SETTINGS: Settings = {
  appearance: "system",
  tuiTheme: null,
  dockBadge: true,
  notifications: true,
  sounds: true,
  soundsWhenFocused: false,
  soundChoices: DEFAULT_SOUND_CHOICES,
  fontSize: FONT_SIZE.default,
  defaultHarness: "opencode",
  defaultDirectory: null,
  defaultSpace: null,
  defaultModel: null,
  defaultFxModel: null,
  defaultModelEnabled: false,
  ctrlInstructions: true,
  adapterModes: {},
  shortcuts: {},
  companion: false,
  remoteControl: false,
  sessionView: "terminal",
  worktreeRoot: null,
  worktreePoolAuto: true,
  worktreeCleanup: true,
  worktreeUpdateRepos: false,
}

type Persisted = {
  spaces: Space[]
  assignments: Record<string, string>
  /** sessionID → archived-at timestamp */
  archived: Record<string, number>
  /** resource id → archived-at timestamp (a mention after it brings the resource back, see isResourceArchived) */
  archivedResources: Record<string, number>
  /** sessionID → the agent that created it through the CLI */
  createdByAgent: Record<string, AgentOrigin>
  /** sessionID → parent sessionID (child sessions, any depth; the parent can be in another space) */
  parents: Record<string, string>
  ui: UiState
  settings: Settings
  /** fx sessions: end of the last turn you've seen (fx has no read state; opencode keeps its own) */
  viewed: Record<string, number>
  /** When fx read state started: turns that ended before count as seen, so old history isn't all unread */
  viewedSince: number
  /** fx renames waiting for fx to let go of the session (it rewrites session.json while it runs) */
  titles: Record<string, string>
  /** fx sessions open at quit, most recently used first, and the one on screen: reopened at launch */
  open: { sessions: string[]; current: string | null }
  /** fx sessions created as a chat (src/main/fx-chat.ts): they open as one, never in a terminal */
  fxChat: Record<string, true>
  /** sessionID → the message typed in its chat composer and not sent (dropped on send, archive, delete) */
  drafts: Record<string, string>
  /** New sessions their harness hasn't written yet (src/main/unstarted.ts), listed until it does */
  unstarted: Record<string, Unstarted>
  /** Terminal area size, so restored and new fx processes start at the right size */
  termSize?: { cols: number; rows: number }
  /** Secret in the remote control URL (src/main/remote.ts), kept so the link saved on the phone keeps working */
  remoteToken?: string
}

export class Store {
  data: Persisted

  constructor(private file: string) {
    let loaded: Partial<Persisted> = {}
    try {
      loaded = JSON.parse(readFileSync(file, "utf8"))
    } catch {}
    this.data = {
      spaces: [],
      assignments: {},
      archived: {},
      archivedResources: {},
      createdByAgent: {},
      parents: {},
      viewed: {},
      viewedSince: Date.now(),
      titles: {},
      open: { sessions: [], current: null },
      fxChat: {},
      drafts: {},
      unstarted: {},
      ...loaded,
      ui: { ...DEFAULT_UI, ...loaded.ui },
      settings: {
        ...DEFAULT_SETTINGS,
        // State from before the toggle: a saved default model meant "on".
        defaultModelEnabled: !!loaded.settings?.defaultModel,
        ...loaded.settings,
        soundChoices: { ...DEFAULT_SOUND_CHOICES, ...loaded.settings?.soundChoices },
        // State from before modes: a disabled adapter still showed its links.
        adapterModes: {
          ...Object.fromEntries(
            ((loaded.settings as { disabledAdapters?: string[] } | undefined)?.disabledAdapters ?? []).map((id) => [id, "links" as const]),
          ),
          ...loaded.settings?.adapterModes,
        },
      },
    }
    delete (this.data.settings as { disabledAdapters?: unknown }).disabledAdapters
    // CLI checks live in tools.json now (src/main/tools/config.ts).
    delete (this.data.settings as { cliTools?: unknown }).cliTools
    // The resources scope was one for every session before it became per session (spaceScopedSessions).
    delete (this.data.ui as { resourcesScope?: unknown }).resourcesScope
    if (!loaded.viewedSince) this.save()
  }

  setSettings(patch: Partial<Settings>) {
    Object.assign(this.data.settings, patch)
    this.save()
  }

  setUi(patch: Partial<UiState>) {
    Object.assign(this.data.ui, patch)
    this.save()
  }

  /** Archiving drops the sessions' drafts. */
  setArchived(sessionIDs: string[], archived: boolean) {
    for (const id of sessionIDs) {
      if (archived) {
        this.data.archived[id] ??= Date.now()
        delete this.data.drafts[id]
      } else delete this.data.archived[id]
    }
    this.save()
  }

  /** Returns whether the session went from no draft to one, or back (what the sidebar shows). Blank: no draft. */
  setDraft(sessionID: string, text: string) {
    const had = sessionID in this.data.drafts
    const next = text.trim() ? text.slice(0, DRAFT_MAX) : null
    if ((this.data.drafts[sessionID] ?? null) === next) return false
    if (next === null) delete this.data.drafts[sessionID]
    else this.data.drafts[sessionID] = next
    // Typing changes it every few hundred ms; losing the last second to a crash is fine.
    this.saveSoon()
    return had !== (next !== null)
  }

  addUnstarted(sessionID: string, unstarted: Unstarted) {
    this.data.unstarted[sessionID] = unstarted
    this.save()
  }

  dropUnstarted(sessionIDs: string[]) {
    let changed = false
    for (const id of sessionIDs) changed = delete this.data.unstarted[id] || changed
    if (changed) this.save()
  }

  /**
   * A session got its harness's id (an unstarted session, src/main/unstarted.ts): everything ctrl keeps about
   * it follows, children included.
   */
  rekey(from: string, to: string) {
    if (from === to) return
    const maps = [
      this.data.assignments,
      this.data.archived,
      this.data.createdByAgent,
      this.data.parents,
      this.data.viewed,
      this.data.titles,
      this.data.fxChat,
      this.data.drafts,
      this.data.unstarted,
    ] as Record<string, unknown>[]
    for (const map of maps) {
      if (!(from in map)) continue
      map[to] = map[from]
      delete map[from]
    }
    for (const [id, parent] of Object.entries(this.data.parents)) if (parent === from) this.data.parents[id] = to
    const { sessions, current } = this.data.open
    this.data.open = { sessions: sessions.map((id) => (id === from ? to : id)), current: current === from ? to : current }
    this.save()
  }

  /** Archiving again restarts the clock, so a resource that came back can be archived anew. */
  setResourcesArchived(ids: string[], archived: boolean) {
    for (const id of ids) {
      if (archived) this.data.archivedResources[id] = Date.now()
      else delete this.data.archivedResources[id]
    }
    this.save()
  }

  setCreatedByAgent(sessionID: string, agent: string, by: string | null) {
    this.data.createdByAgent[sessionID] = { agent, by, at: Date.now() }
    this.save()
  }

  /** Whether `ancestorID` is `sessionID` or one of its ancestors. */
  isAncestor(ancestorID: string, sessionID: string) {
    const seen = new Set<string>()
    for (let id: string | undefined = sessionID; id && !seen.has(id); id = this.data.parents[id]) {
      if (id === ancestorID) return true
      seen.add(id)
    }
    return false
  }

  /** The given sessions plus all their children, grandchildren, etc. */
  withDescendants(sessionIDs: string[]) {
    const out = new Set(sessionIDs)
    const children = new Map<string, string[]>()
    for (const [id, p] of Object.entries(this.data.parents)) children.set(p, [...(children.get(p) ?? []), id])
    const queue = [...out]
    while (queue.length) {
      for (const child of children.get(queue.pop()!) ?? []) {
        if (out.has(child)) continue
        out.add(child)
        queue.push(child)
      }
    }
    return [...out]
  }

  /** null detaches. Refuses cycles (a session under itself or one of its children). */
  setParent(sessionID: string, parentID: string | null) {
    if (parentID && this.isAncestor(sessionID, parentID)) return false
    if ((this.data.parents[sessionID] ?? null) === parentID) return true
    if (parentID) this.data.parents[sessionID] = parentID
    else delete this.data.parents[sessionID]
    this.save()
    return true
  }

  private saveTimer?: ReturnType<typeof setTimeout>

  /** For values that change often (every switch, finished turn or resize): one write per second at most. */
  private saveSoon() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), 1000)
  }

  setOpen(sessions: string[], current: string | null) {
    const next = { sessions, current }
    if (JSON.stringify(next) === JSON.stringify(this.data.open)) return
    this.data.open = next
    this.saveSoon()
  }

  setTermSize(cols: number, rows: number) {
    if (this.data.termSize?.cols === cols && this.data.termSize.rows === rows) return
    this.data.termSize = { cols, rows }
    this.saveSoon()
  }

  remoteToken() {
    if (!this.data.remoteToken) {
      this.data.remoteToken = randomBytes(24).toString("base64url")
      this.save()
    }
    return this.data.remoteToken
  }

  setViewed(sessionID: string, at: number) {
    this.data.viewed[sessionID] = at
    this.saveSoon()
  }

  /** An fx session created as a chat stays one. */
  setFxChat(sessionID: string) {
    if (this.data.fxChat[sessionID]) return
    this.data.fxChat[sessionID] = true
    this.save()
  }

  isFxChat(sessionID: string) {
    return !!this.data.fxChat[sessionID]
  }

  setTitle(sessionID: string, title: string | null) {
    if (title) this.data.titles[sessionID] = title
    else delete this.data.titles[sessionID]
    this.save()
  }

  /** Drops everything ctrl keeps about a deleted session. */
  forgetSession(sessionID: string) {
    delete this.data.assignments[sessionID]
    delete this.data.archived[sessionID]
    delete this.data.createdByAgent[sessionID]
    // Its children move up to its own parent, so the tree stays connected.
    const parent = this.data.parents[sessionID]
    delete this.data.parents[sessionID]
    for (const [id, p] of Object.entries(this.data.parents)) {
      if (p !== sessionID) continue
      if (parent) this.data.parents[id] = parent
      else delete this.data.parents[id]
    }
    delete this.data.viewed[sessionID]
    delete this.data.titles[sessionID]
    delete this.data.fxChat[sessionID]
    delete this.data.drafts[sessionID]
    delete this.data.unstarted[sessionID]
    this.save()
  }

  save() {
    clearTimeout(this.saveTimer)
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  space(id: string) {
    return this.data.spaces.find((s) => s.id === id)
  }

  createSpace(name: string) {
    const id = `spc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    this.data.spaces.unshift({ id, name })
    this.save()
    return id
  }

  updateSpace(id: string, patch: Partial<Space>) {
    const space = this.space(id)
    if (!space) return
    Object.assign(space, patch)
    this.save()
  }

  /** Like updateSpace, but null or blank values remove the field. */
  patchSpace(id: string, patch: SpacePatch) {
    const space = this.space(id)
    if (!space) return
    for (const [key, value] of Object.entries(patch) as [keyof SpacePatch, SpacePatch[keyof SpacePatch]][]) {
      if (value === undefined) continue
      if (value === null || (typeof value === "string" && !value.trim())) {
        if (key !== "name") delete space[key]
      } else Object.assign(space, { [key]: key === "name" ? String(value).trim() : value })
    }
    this.save()
  }

  /** Moves a space so it sits at `index` in the final list. */
  moveSpace(id: string, index: number) {
    const from = this.data.spaces.findIndex((s) => s.id === id)
    if (from === -1) return
    const [space] = this.data.spaces.splice(from, 1)
    this.data.spaces.splice(Math.max(0, Math.min(index, this.data.spaces.length)), 0, space)
    this.save()
  }

  deleteSpace(id: string) {
    this.data.spaces = this.data.spaces.filter((s) => s.id !== id)
    for (const [sessionID, spaceID] of Object.entries(this.data.assignments)) {
      if (spaceID === id) delete this.data.assignments[sessionID]
    }
    this.save()
  }

  /** Puts a deleted space back where it was, with its sessions. */
  restoreSpace(space: Space, index: number, sessionIDs: string[]) {
    if (this.space(space.id)) return
    this.data.spaces.splice(Math.min(index, this.data.spaces.length), 0, space)
    for (const id of sessionIDs) this.data.assignments[id] = space.id
    this.save()
  }

  assign(sessionID: string, spaceID: string | null) {
    if (spaceID && this.space(spaceID)) this.data.assignments[sessionID] = spaceID
    else delete this.data.assignments[sessionID]
    this.save()
  }

  /**
   * Moves a session with its descendants that were in the same space, so the tree stays together.
   * A child filed elsewhere stays put, with its own subtree. Returns the descendants that moved.
   */
  assignTree(sessionID: string, spaceID: string | null): string[] {
    const from = this.data.assignments[sessionID] ?? null
    const moved: string[] = []
    const seen = new Set([sessionID])
    const queue = [sessionID]
    while (queue.length) {
      const id = queue.shift()!
      for (const [kid, parent] of Object.entries(this.data.parents)) {
        if (parent !== id || seen.has(kid) || (this.data.assignments[kid] ?? null) !== from) continue
        seen.add(kid)
        moved.push(kid)
        queue.push(kid)
      }
    }
    for (const id of [sessionID, ...moved]) {
      if (spaceID && this.space(spaceID)) this.data.assignments[id] = spaceID
      else delete this.data.assignments[id]
    }
    this.save()
    return moved
  }
}
