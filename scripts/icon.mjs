// Renders build/icon.svg → build/icon.png (1024) and build/icon.icns.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { Resvg } from "@resvg/resvg-js"

const svg = readFileSync("build/icon.svg")
const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng()

writeFileSync("build/icon.png", render(1024))

const iconset = "build/icon.iconset"
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const size of [16, 32, 128, 256, 512]) {
  writeFileSync(`${iconset}/icon_${size}x${size}.png`, render(size))
  writeFileSync(`${iconset}/icon_${size}x${size}@2x.png`, render(size * 2))
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", "build/icon.icns"])
rmSync(iconset, { recursive: true })
console.log("wrote build/icon.png and build/icon.icns")
