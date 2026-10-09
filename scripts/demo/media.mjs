// Turns raw captures (2800x1800: a 1400x900 window at 2x) into README media. Runs inside
// Electron for nativeImage (crop, resize, decode), so it needs no image tools.
// Usage: electron scripts/demo/media.mjs <raw dir> <out dir> <gifenc dir>   (run by capture.mjs)
import { app, nativeImage } from "electron"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

const [raw, out, gifencDir] = process.argv.slice(-3)
/** "-fx" for the fx captures (hero-fx.png, …) */
const suffix = process.env.CTRL_MEDIA_SUFFIX ?? ""
const { GIFEncoder, quantize, applyPalette } = createRequire(join(gifencDir, "x.js"))("gifenc")

// name: crop in raw pixels (or null for the whole window), output width
const STILLS = {
  hero: [null, 1600],
  resources: [{ x: 1760, y: 0, width: 1040, height: 1160 }, 780],
  search: [{ x: 560, y: 40, width: 1680, height: 1000 }, 1100],
  jump: [{ x: 0, y: 0, width: 800, height: 1500 }, 500],
}
const GIF_WIDTH = 1000

const load = (file, crop, width) => {
  let img = nativeImage.createFromPath(file)
  if (crop) img = img.crop(crop)
  return img.resize({ width, quality: "best" })
}

app.dock?.hide()
// Not a top-level await: that blocks Electron's ready event in an ESM entry point.
app.whenReady().then(main)

function main() {
for (const [name, [crop, width]] of Object.entries(STILLS)) {
  const file = join(raw, `${name}.png`)
  if (!existsSync(file)) {
    console.log(`[media] missing ${file}`)
    continue
  }
  writeFileSync(join(out, `${name}${suffix}.png`), load(file, crop, width).toPNG())
  console.log(`[media] ${name}${suffix}.png`)
}

const framesDir = join(raw, "reference")
const files = existsSync(framesDir) ? readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort() : []
if (files.length) {
  const frames = files.map((f) => {
    const img = load(join(framesDir, f), null, GIF_WIDTH)
    const { width, height } = img.getSize()
    const rgba = Buffer.from(img.toBitmap())
    for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]] // BGRA → RGBA
    return { rgba, width, height }
  })
  // One shared palette, from a mid-drag frame, so colors don't flicker between frames.
  const palette = quantize(frames[Math.floor(frames.length / 2)].rgba, 256)
  const gif = GIFEncoder()
  // Consecutive identical frames become one longer frame: most of the clip is still.
  let last = null
  const queue = []
  for (const f of frames) {
    const index = applyPalette(f.rgba, palette)
    if (last && Buffer.compare(Buffer.from(index), Buffer.from(last.index)) === 0) last.delay += 100
    else queue.push((last = { index, delay: 100, width: f.width, height: f.height }))
  }
  queue.at(-1).delay += 2500
  for (const f of queue) gif.writeFrame(f.index, f.width, f.height, { delay: f.delay, palette })
  gif.finish()
  writeFileSync(join(out, `reference${suffix}.gif`), gif.bytes())
  console.log(`[media] reference${suffix}.gif (${frames.length} frames, ${queue.length} distinct)`)
}
app.quit()
}
