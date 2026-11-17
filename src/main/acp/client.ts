import type { ChildProcessWithoutNullStreams } from "node:child_process"

/**
 * A client for the Agent Client Protocol (https://agentclientprotocol.com): newline-delimited JSON-RPC 2.0
 * over an agent process's stdin and stdout. Knows nothing about fx: src/main/fx-chat.ts puts fx's own
 * conventions on top. Three kinds of traffic:
 *
 * - requests we send (`request`), answered by id;
 * - notifications the agent sends (`session/update`), passed to `onNotification`;
 * - requests the agent sends (`session/request_permission`), answered through `onRequest`.
 */

export type JsonRpcError = { code: number; message: string; data?: unknown }

export class AcpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message)
  }
}

/** What the client reads and writes: a child process's streams, or a fake in tests. */
export type AcpTransport = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout"> & {
  /** Fires once when the process is gone (`close` on a child process). */
  once(event: "close", cb: (code: number | null) => void): unknown
}

type Pending = { resolve(value: unknown): void; reject(err: Error): void }

type Message = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: JsonRpcError
}

/** A line longer than this is a bug somewhere: dropped rather than buffered without end. */
const MAX_LINE = 64 * 1024 * 1024

export class AcpClient {
  private seq = 0
  private pending = new Map<number, Pending>()
  private buffer = ""
  private closed: Error | null = null

  /** A notification from the agent (`session/update`, …). */
  onNotification?: (method: string, params: unknown) => void
  /**
   * A request from the agent. Resolve with the result, or throw an AcpError (any other error becomes
   * -32603). Without a handler, every request fails with -32601.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown>
  /** The process is gone; every request in flight has been rejected. */
  onClose?: (code: number | null) => void

  constructor(private transport: AcpTransport) {
    transport.stdout.setEncoding?.("utf8")
    transport.stdout.on("data", (chunk: string | Buffer) => this.read(String(chunk)))
    transport.once("close", (code) => this.close(code))
    transport.stdin.on?.("error", () => {})
  }

  /** Sends a request and resolves with its result, or rejects with an AcpError (or the close error). */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.write({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    if (this.closed) return
    this.write({ jsonrpc: "2.0", method, params })
  }

  private write(msg: Message) {
    try {
      this.transport.stdin.write(JSON.stringify(msg) + "\n")
    } catch (err) {
      this.close(null, err instanceof Error ? err : new Error(String(err)))
    }
  }

  private read(chunk: string) {
    this.buffer += chunk
    let at: number
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      if (line.trim()) this.dispatch(line)
    }
    if (this.buffer.length > MAX_LINE) this.buffer = ""
  }

  private dispatch(line: string) {
    let msg: Message
    try {
      msg = JSON.parse(line)
    } catch {
      // Not ours (a stray print); agents must keep stdout for the protocol, but one bad line shouldn't end it.
      return
    }
    if (!msg || typeof msg !== "object") return
    if (msg.method !== undefined) {
      if (msg.id !== undefined) void this.answer(msg.id, msg.method, msg.params)
      else this.onNotification?.(msg.method, msg.params)
      return
    }
    if (typeof msg.id !== "number") return
    const waiting = this.pending.get(msg.id)
    if (!waiting) return
    this.pending.delete(msg.id)
    if (msg.error) waiting.reject(new AcpError(msg.error.code, msg.error.message, msg.error.data))
    else waiting.resolve(msg.result)
  }

  private async answer(id: number | string, method: string, params: unknown) {
    if (!this.onRequest) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    try {
      const result = await this.onRequest(method, params)
      this.write({ jsonrpc: "2.0", id, result: result ?? null })
    } catch (err) {
      const error: JsonRpcError =
        err instanceof AcpError
          ? { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }
          : { code: -32603, message: err instanceof Error ? err.message : String(err) }
      this.write({ jsonrpc: "2.0", id, error })
    }
  }

  private close(code: number | null, cause?: Error) {
    if (this.closed) return
    this.closed = cause ?? new Error(code === null ? "The agent process is gone" : `The agent process exited with code ${code}`)
    for (const p of this.pending.values()) p.reject(this.closed)
    this.pending.clear()
    this.onClose?.(code)
  }

  get isClosed() {
    return this.closed !== null
  }
}
