import { TOOL_BROKEN, type ToolItem } from "../../shared/types"

type Ui = {
  /** Raises a sticky toast with one action button; returns its id */
  toast(message: string, action: { label: string; run(): void }): string
  dismiss(toastID: string): void
}

const message = (tool: ToolItem) => {
  const what = tool.kind === "mcp" ? `MCP “${tool.name}”` : `“${tool.name}”`
  if (tool.state === "missing") return `${what} isn't installed${tool.detail ? `: ${tool.detail}` : ""}`
  const verb = tool.state === "needs-auth" ? "needs sign-in" : tool.kind === "mcp" ? "is failing" : "stopped working"
  return `${what} ${verb}${tool.detail ? `: ${tool.detail}` : ""}`
}

/**
 * One sticky toast per broken tool (MCP server or CLI), the same for every kind: raised once per new
 * failure (including at launch), replaced when the error changes, cleared when the tool recovers or goes
 * away. pending and checking keep the toast until the tool settles.
 */
export class ToolAlerts {
  private open = new Map<string, { detail: string; toastID: string }>()

  constructor(
    private ui: Ui,
    private fix: (id: string) => void,
  ) {}

  sync(tools: ToolItem[]) {
    for (const tool of tools) {
      const alert = this.open.get(tool.id)
      if (!TOOL_BROKEN.includes(tool.state)) {
        if (alert && tool.state !== "pending" && tool.state !== "checking") {
          this.ui.dismiss(alert.toastID)
          this.open.delete(tool.id)
        }
        continue
      }
      const detail = `${tool.state}:${tool.detail ?? ""}`
      if (alert?.detail === detail) continue
      if (alert) this.ui.dismiss(alert.toastID)
      const toastID = this.ui.toast(message(tool), { label: tool.label, run: () => this.fix(tool.id) })
      this.open.set(tool.id, { detail, toastID })
    }
    for (const [id, alert] of this.open) {
      if (tools.some((t) => t.id === id)) continue
      this.ui.dismiss(alert.toastID)
      this.open.delete(id)
    }
  }

  /** A fix attempt ended and the tool is still broken: toast it again even though the error is the same. */
  forget(id: string) {
    const alert = this.open.get(id)
    if (!alert) return
    this.ui.dismiss(alert.toastID)
    this.open.delete(id)
  }
}
