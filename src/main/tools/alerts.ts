type Ui = {
  /** Raises a sticky toast with one action button; returns its id */
  toast(message: string, action: { label: string; run(): void }): string
  dismiss(toastID: string): void
}

/**
 * Something that needs you: a broken CLI, an MCP server failing in one harness, a harness missing
 * servers. `key` changes when the problem does (a new error). `hold`: settling (checking, reconnecting),
 * so an open toast stays but no new one is raised.
 */
export type Alert = { id: string; key: string; message: string; label: string; hold?: boolean }

/**
 * One sticky toast per alert, the same for every kind of tool: raised once per new problem (including
 * at launch), replaced when its key changes, cleared once the alert goes away.
 */
export class ToolAlerts {
  private open = new Map<string, { key: string; toastID: string }>()

  constructor(
    private ui: Ui,
    private fix: (id: string) => void,
  ) {}

  sync(alerts: Alert[]) {
    for (const alert of alerts) {
      if (alert.hold) continue
      const open = this.open.get(alert.id)
      if (open?.key === alert.key) continue
      if (open) this.ui.dismiss(open.toastID)
      const toastID = this.ui.toast(alert.message, { label: alert.label, run: () => this.fix(alert.id) })
      this.open.set(alert.id, { key: alert.key, toastID })
    }
    const ids = new Set(alerts.map((a) => a.id))
    for (const [id, open] of this.open) {
      if (ids.has(id)) continue
      this.ui.dismiss(open.toastID)
      this.open.delete(id)
    }
  }

  /** A fix attempt ended and it's still broken: toast it again even though the problem is the same. */
  forget(id: string) {
    const open = this.open.get(id)
    if (!open) return
    this.ui.dismiss(open.toastID)
    this.open.delete(id)
  }
}
