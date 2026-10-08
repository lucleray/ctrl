export type Space = {
  id: string
  name: string
  directory?: string
  collapsed?: boolean
}

export type SessionItem = {
  id: string
  title: string
  directory: string
  updated: number
  running: boolean
}

export type AppState = {
  spaces: Space[]
  assignments: Record<string, string>
  sessions: SessionItem[]
  currentSessionID: string | null
  bridgeConnected: boolean
  error?: string
}

export type CtrlApi = {
  getState(): Promise<AppState>
  onState(cb: (state: AppState) => void): () => void
  onRenameSpace(cb: (spaceID: string) => void): () => void
  onRenameSession(cb: (sessionID: string) => void): () => void
  onShortcut(cb: (name: "palette" | "new-chat") => void): () => void
  createSpace(name: string): Promise<string>
  renameSpace(id: string, name: string): Promise<void>
  moveSpace(id: string, index: number): Promise<void>
  renameSession(sessionID: string, title: string): Promise<void>
  toggleSpace(id: string): Promise<void>
  showSpaceMenu(id: string): Promise<void>
  showSessionMenu(sessionID: string): Promise<void>
  moveSession(sessionID: string, spaceID: string | null): Promise<void>
  newSession(spaceID: string | null): Promise<void>
  openSession(sessionID: string): Promise<void>
  ptyStart(cols: number, rows: number): void
  ptyWrite(data: string): void
  ptyResize(cols: number, rows: number): void
  onPtyData(cb: (data: string) => void): () => void
  onPtyReset(cb: () => void): () => void
}
