// fx's session files, both layouts. Pure file reads, shared by main (src/main/fx.ts), the indexer and
// wrapped links, so none of them know where fx keeps what.
//
//   v1 (fx ≤ 0.0.16): ~/.fx/sessions/<id>/ session.json, events.jsonl, recovery.json, owner.live
//   v2 (fx ≥ 0.0.17): ~/.fx/sessions/v2/index.jsonl  one line per change (put / del), the session list
//                     ~/.fx/sessions/v2/<id>/log.jsonl  the whole session, append-only, one event per line
//                     ~/.fx/sessions/v2/<id>/lock       flock held by the fx process that has it open
//
// fx 0.0.17 converts a v1 session to v2 (same id) the first time it opens it, and moves the v1 folder away,
// so both exist side by side until every old session has been opened once.
import { existsSync } from "node:fs"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** fx's profile folder; CTRL_FX_HOME is a debug hook for throwaway sessions. */
export const FX_HOME = process.env.CTRL_FX_HOME || join(homedir(), ".fx")
export const SESSIONS_DIR = join(FX_HOME, "sessions")
/** Environment for the fx processes ctrl runs, so they use the same profile folder (fx ≥ 0.0.17 reads FX_HOME). */
export const FX_ENV: Record<string, string> = process.env.CTRL_FX_HOME ? { FX_HOME: process.env.CTRL_FX_HOME } : {}
export const V2_DIR = join(SESSIONS_DIR, "v2")
export const INDEX_FILE = join(V2_DIR, "index.jsonl")

/** A v1 session folder's name (not v2's root, fx's trash or staging). */
export const isV1Name = (name: string) => name !== "v2" && !name.startsWith(".") && !name.startsWith("trash")
/** A v2 session folder's name (not the index or staging). */
export const isV2Name = (name: string) => !name.startsWith(".") && !name.startsWith("index.")

export const v2Dir = (id: string) => join(V2_DIR, id)
export const v2Log = (id: string) => join(V2_DIR, id, "log.jsonl")
export const v2Lock = (id: string) => join(V2_DIR, id, "lock")
export const v1Log = (id: string) => join(SESSIONS_DIR, id, "events.jsonl")

/** The session's log and which layout it's in; v2 wins once fx has converted it. */
export function sessionLog(id: string): { layout: "v1" | "v2"; file: string } {
  return existsSync(v2Log(id)) ? { layout: "v2", file: v2Log(id) } : { layout: "v1", file: v1Log(id) }
}

/** One session as index.jsonl lists it (the newest `put`). */
export type IndexEntry = {
  id: string
  role: "root" | "child"
  title?: string
  workspace: string
  parent?: string
  created: number
  updated: number
}

/**
 * Folds index.jsonl lines into `into` (newest put per id, `del` removes it). Lines must be whole.
 * Returns the ids that changed.
 */
export function foldIndex(text: string, into: Map<string, IndexEntry>) {
  const changed = new Set<string>()
  for (const line of text.split("\n")) {
    if (!line) continue
    let e: { op?: string; id?: unknown; role?: unknown; title?: unknown; workspace?: unknown; parent?: unknown; created?: unknown; updated?: unknown }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof e.id !== "string") continue
    if (e.op === "del") {
      if (into.delete(e.id)) changed.add(e.id)
      continue
    }
    if (e.op !== "put") continue
    into.set(e.id, {
      id: e.id,
      role: e.role === "child" ? "child" : "root",
      title: typeof e.title === "string" && e.title ? e.title : undefined,
      workspace: typeof e.workspace === "string" ? e.workspace : "",
      parent: typeof e.parent === "string" ? e.parent : undefined,
      created: typeof e.created === "number" ? e.created : 0,
      updated: typeof e.updated === "number" ? e.updated : 0,
    })
    changed.add(e.id)
  }
  return changed
}

/**
 * Reads index.jsonl from `offset` (whole lines only) into `into`. The index is rewritten now and then
 * (fx rebuilds it): a file smaller than `offset` is read again from the start.
 */
export async function readIndex(into: Map<string, IndexEntry>, offset: number) {
  let fh
  try {
    fh = await open(INDEX_FILE, "r")
  } catch {
    if (offset > 0) into.clear()
    return { offset: 0, changed: new Set<string>(), reset: offset > 0 }
  }
  try {
    const { size } = await fh.stat()
    const reset = size < offset
    if (reset) {
      into.clear()
      offset = 0
    }
    if (size === offset) return { offset, changed: new Set<string>(), reset }
    const buf = Buffer.alloc(size - offset)
    await fh.read(buf, 0, buf.length, offset)
    const end = buf.lastIndexOf(0x0a)
    if (end === -1) return { offset, changed: new Set<string>(), reset }
    const changed = foldIndex(buf.subarray(0, end).toString("utf8"), into)
    return { offset: offset + end + 1, changed, reset }
  } finally {
    await fh.close()
  }
}

/** What the end of a log says about the turn. */
export type TurnState = "none" | "in-turn" | "completed" | "interrupted"
export type TurnTail = { turn: TurnState; ended?: number }

const V2_HEAD_RE = /^\{"v":\d+,"seq":\d+,"ts":(\d+),"kind":"(\w+)"/
const V1_HEAD_RE = /"timestamp_ms":(\d+),"event":\{"(\w+)"/

/** The turn state from one log line, or undefined when the line says nothing about turns. */
function turnOf(layout: "v1" | "v2", line: string): TurnTail | undefined {
  if (layout === "v1") {
    const m = line.match(V1_HEAD_RE)
    if (!m) return { turn: "none" }
    const kind = m[2]
    if (kind === "turn_completed") return { turn: "completed", ended: Number(m[1]) }
    if (kind === "interrupted") return { turn: "interrupted", ended: Number(m[1]) }
    if (kind === "context_checkpoint") return { turn: "none" }
    return { turn: "in-turn" }
  }
  const m = line.slice(0, 200).match(V2_HEAD_RE)
  if (!m) return undefined
  const kind = m[2]
  if (kind === "turn_committed") return { turn: "completed", ended: Number(m[1]) }
  if (kind === "turn_interrupted") return { turn: "interrupted", ended: Number(m[1]) }
  if (kind === "turn_started" || kind === "item") return { turn: "in-turn" }
  return undefined
}

const TAIL_START = 16 * 1024
const TAIL_MAX = 4 * 1024 * 1024

/**
 * The turn state at the end of a log. v1: its last line. v2: the newest line about a turn (settings,
 * `closed` and subagent lines can follow a turn's end), reading back a growing window.
 */
export async function lastTurn(layout: "v1" | "v2", file: string, size: number): Promise<TurnTail | undefined> {
  if (!size) return undefined
  const fh = await open(file, "r")
  try {
    for (let window = TAIL_START; ; window *= 2) {
      const len = Math.min(window, size)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, size - len)
      const text = buf.toString("utf8").replace(/\n+$/, "")
      const lines = text.split("\n")
      // The first line of a partial window may be cut: only trust it when the window starts the file.
      const whole = len === size ? lines : lines.slice(1)
      if (layout === "v1") {
        if (!whole.length && len < size && window < TAIL_MAX) continue
        return turnOf("v1", lines[lines.length - 1])
      }
      for (let i = whole.length - 1; i >= 0; i--) {
        const t = turnOf("v2", whole[i])
        if (t) return t
      }
      if (len === size || window >= TAIL_MAX) return { turn: "none" }
    }
  } finally {
    await fh.close()
  }
}

/** A message worth indexing: your prompts (and steering) and the assistant's replies. */
export type LogDoc = { seq: number; role: "user" | "assistant"; created: number; body: string }

/** Prompts and replies in whole log lines; tool calls, results and settings are skipped. */
export function parseLogLines(layout: "v1" | "v2", text: string): LogDoc[] {
  const docs: LogDoc[] = []
  for (const line of text.split("\n")) {
    if (layout === "v1") {
      // Cheap prefilter: most lines are tool calls/results.
      if (!/"event":\{"(user|assistant|steering)"/.test(line.slice(0, 200))) continue
      let e: { seq?: number; timestamp_ms?: number; event?: Record<string, { text?: unknown } | undefined> }
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      const [kind, payload] = Object.entries(e.event ?? {})[0] ?? []
      const body = typeof payload?.text === "string" ? payload.text.trim() : ""
      if (!body || typeof e.seq !== "number") continue
      docs.push({ seq: e.seq, role: kind === "assistant" ? "assistant" : "user", created: e.timestamp_ms ?? 0, body })
      continue
    }
    // `assistant_running` is a preview of the `assistant` line that follows it: skip it.
    if (!/"kind":"item","turn":\d+,"type":"(user|assistant|steering)"/.test(line.slice(0, 200))) continue
    let e: { seq?: number; ts?: number; type?: string; data?: { text?: unknown } }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const body = typeof e.data?.text === "string" ? e.data.text.trim() : ""
    if (!body || typeof e.seq !== "number") continue
    docs.push({ seq: e.seq, role: e.type === "assistant" ? "assistant" : "user", created: e.ts ?? 0, body })
  }
  return docs
}
