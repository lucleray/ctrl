import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Space, UiState } from "../shared/types"

const DEFAULT_UI: UiState = { recentsCollapsed: false, archivedCollapsed: true }

type Persisted = {
  spaces: Space[]
  assignments: Record<string, string>
  /** sessionID → archived-at timestamp */
  archived: Record<string, number>
  ui: UiState
}

export class Store {
  data: Persisted

  constructor(private file: string) {
    let loaded: Partial<Persisted> = {}
    try {
      loaded = JSON.parse(readFileSync(file, "utf8"))
    } catch {}
    this.data = { spaces: [], assignments: {}, archived: {}, ...loaded, ui: { ...DEFAULT_UI, ...loaded.ui } }
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
