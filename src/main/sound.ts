import { spawn, type ChildProcess } from "node:child_process"

let playing: ChildProcess | undefined

/** A sound choice is a system sound name ("Glass") or an absolute path to an audio file. */
export const soundPath = (choice: string) =>
  choice.startsWith("/") ? choice : `/System/Library/Sounds/${choice}.aiff`

/** Plays through afplay (macOS), cutting off the previous sound so bursts don't pile up. */
export function playSound(choice: string) {
  if (process.platform !== "darwin") return
  playing?.kill()
  const child = spawn("afplay", [soundPath(choice)], { stdio: "ignore" })
  child.on("error", () => {})
  child.on("exit", () => {
    if (playing === child) playing = undefined
  })
  playing = child
}
