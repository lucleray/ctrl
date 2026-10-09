import { utilityProcess, type UtilityProcess } from "electron"
import type { DatabaseSync } from "node:sqlite"
import type { IndexerMessage, IndexStatus, SearchResult } from "../shared/types"
import { openSearchDb, SearchReader } from "./search-db"

const HIT_LIMIT = 30

/**
 * Owns the indexer utility process and a read-only connection for queries.
 * WAL lets searches run while the indexer writes, and a query only touches a
 * bounded number of rows, so searching stays cheap on the main thread.
 */
export class Search {
  private child?: UtilityProcess
  private db?: DatabaseSync
  private reader?: SearchReader
  private status: IndexStatus = { indexing: false, done: 0, total: 0 }
  private stopped = false

  constructor(
    private entry: string,
    private dbPath: string,
  ) {}

  start() {
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: "ctrl indexer",
      env: process.env,
      stdio: "inherit",
    })
    this.child = child
    child.on("message", (msg: IndexerMessage) => {
      if (msg.type === "ready" && !this.reader) {
        this.db = openSearchDb(this.dbPath, { readOnly: true })
        this.reader = new SearchReader(this.db)
      } else if (msg.type === "status") {
        this.status = msg.status
      }
    })
    child.on("exit", (code) => {
      if (this.stopped) return
      console.error(`[ctrl] indexer exited (${code}), restarting`)
      setTimeout(() => this.start(), 2000)
    })
    child.postMessage({ type: "start", dbPath: this.dbPath })
  }

  search(query: string): SearchResult {
    return { hits: this.reader?.search(query, HIT_LIMIT) ?? [], status: this.status }
  }

  stop() {
    this.stopped = true
    this.child?.kill()
    this.db?.close()
  }
}
