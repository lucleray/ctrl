import { Plugin } from "@opencode/plugin/tui"

// Loaded only into the TUI that ctrl embeds (via OPENCODE_CLI_CONFIG_CONTENT).
// It connects back to ctrl over a local WebSocket so ctrl can drive navigation
// without restarting the TUI, and reports route changes back to ctrl.

type Inbound = { type: "navigate"; sessionID: string } | { type: "home" }

export default Plugin.define({
  id: "ctrl.bridge",
  setup(ctx) {
    const url = process.env.CTRL_BRIDGE_URL
    if (!url) return

    let ws: WebSocket | undefined
    let closed = false
    let lastRoute = ""
    let retry: ReturnType<typeof setTimeout> | undefined

    const currentSession = () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : null
    }

    const send = (msg: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }

    const connect = () => {
      if (closed) return
      ws = new WebSocket(url)
      ws.onopen = () => {
        lastRoute = ""
        send({ type: "hello" })
      }
      ws.onmessage = (event) => {
        let msg: Inbound
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (msg.type === "navigate") {
          if (!ctx.ui.tabs.enabled() || !ctx.ui.tabs.focus(msg.sessionID)) {
            ctx.ui.router.navigate({ type: "session", sessionID: msg.sessionID })
          }
        } else if (msg.type === "home") {
          ctx.ui.router.navigate({ type: "home" })
        }
      }
      ws.onclose = () => {
        ws = undefined
        if (!closed) retry = setTimeout(connect, 500)
      }
      ws.onerror = () => ws?.close()
    }

    // Polling keeps this independent of whether setup runs in a reactive root.
    const poll = setInterval(() => {
      const id = currentSession()
      const key = id ?? "home"
      if (key === lastRoute) return
      lastRoute = key
      send({ type: "route", sessionID: id })
    }, 150)

    connect()

    return () => {
      closed = true
      clearInterval(poll)
      clearTimeout(retry)
      ws?.close()
    }
  },
})
