import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_SOUND_CHOICES, FONT_SIZE, type Settings, type Space, type SpacePatch, type UiState } from "../shared/types"

const DEFAULT_UI: UiState = {
  recentsCollapsed: false,
  archivedCollapsed: true,
  sidebarWidth: 280,
  resourcesOpen: true,
  resourcesWidth: 300,
  resourcesScope: "session",
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
  defaultModel: null,
  defaultFxModel: null,
  defaultModelEnabled: false,
  adapterModes: {},
  shortcuts: {},
}

type Persisted = {
  spaces: Space[]
  assignments: Record<string, string>
  /** sessionID → archived-at timestamp */
  archived: Record<string, number>
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
  /** Terminal area size, so restored and new fx processes start at the right size */
  termSize?: { cols: number; rows: number }
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
      viewed: {},
      viewedSince: Date.now(),
      titles: {},
      open: { sessions: [], current: null },
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

  setArchived(sessionIDs: string[], archived: boolean) {
    for (const id of sessionIDs) {
      if (archived) this.data.archived[id] ??= Date.now()
      else delete this.data.archived[id]
    }
    this.save()
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

  setViewed(sessionID: string, at: number) {
    this.data.viewed[sessionID] = at
    this.saveSoon()
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
    delete this.data.viewed[sessionID]
    delete this.data.titles[sessionID]
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
}
