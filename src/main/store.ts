import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  FONT_SIZE,
  type PinnedSession,
  type Settings,
  type Space,
  type SpacePatch,
  type UiState,
} from "../shared/types"

const DEFAULT_UI: UiState = { recentsCollapsed: false, archivedCollapsed: true, sidebarWidth: 280 }
const DEFAULT_SETTINGS: Settings = {
  appearance: "system",
  tuiTheme: null,
  dockBadge: true,
  notifications: true,
  fontSize: FONT_SIZE.default,
  defaultModel: null,
  defaultModelEnabled: false,
}

type Persisted = {
  spaces: Space[]
  assignments: Record<string, string>
  /** sessionID → archived-at timestamp */
  archived: Record<string, number>
  ui: UiState
  settings: Settings
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
      ...loaded,
      ui: { ...DEFAULT_UI, ...loaded.ui },
      settings: {
        ...DEFAULT_SETTINGS,
        // State from before the toggle: a saved default model meant "on".
        defaultModelEnabled: !!loaded.settings?.defaultModel,
        ...loaded.settings,
      },
    }
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

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  space(id: string) {
    return this.data.spaces.find((s) => s.id === id)
  }

  createSpace(name: string) {
    const id = `spc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    this.data.spaces.push({ id, name })
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

  setPinned(spaceID: string, session: PinnedSession, pinned: boolean) {
    const space = this.space(spaceID)
    if (!space) return
    const rest = (space.pinned ?? []).filter((p) => p.id !== session.id)
    space.pinned = pinned ? [...rest, session] : rest
    if (!space.pinned.length) delete space.pinned
    this.save()
  }

  /** Drops a session from every space's pins, e.g. after it was deleted. */
  unpinEverywhere(sessionID: string) {
    for (const space of this.data.spaces) {
      if (space.pinned?.some((p) => p.id === sessionID)) this.setPinned(space.id, { id: sessionID, title: "" }, false)
    }
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

  assign(sessionID: string, spaceID: string | null) {
    if (spaceID && this.space(spaceID)) this.data.assignments[sessionID] = spaceID
    else delete this.data.assignments[sessionID]
    this.save()
  }
}
