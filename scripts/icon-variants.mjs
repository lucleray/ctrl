// Generates ASCII/pixel-art icon candidates into a contact sheet for picking.
// Usage: node scripts/icon-variants.mjs <outdir>
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Resvg } from "@resvg/resvg-js"

const out = process.argv[2] ?? "build/variants"
mkdirSync(out, { recursive: true })

// macOS icon body: 824px squircle centred on a 1024 canvas.
const frame = (bg, inner, { stroke = "#ffffff1f" } = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.3"/>
    </filter>
    <clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
  </defs>
  <g filter="url(#sh)"><rect x="100" y="100" width="824" height="824" rx="186" fill="${bg}"/></g>
  <g clip-path="url(#sq)">${inner}</g>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185.5" fill="none" stroke="${stroke}"/>
</svg>`

/** Renders a bitmap (array of strings) centred at (cx, cy). `paint(ch)` → fill or null.
 * Cells of the same color are merged into one path so there are no seams. */
function pixels(rows, { cell, gap = 0, cx = 512, cy = 512, paint, shadow }) {
  const w = Math.max(...rows.map((r) => r.length)) * cell
  const h = rows.length * cell
  const x0 = cx - w / 2
  const y0 = cy - h / 2
  const size = cell - gap
  const layer = (dx, dy, colorFor) => {
    const byColor = new Map()
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        const fill = colorFor(ch)
        if (!fill) return
        const px = x0 + x * cell + gap / 2 + dx
        const py = y0 + y * cell + gap / 2 + dy
        byColor.set(fill, (byColor.get(fill) ?? "") + `M${px} ${py}h${size}v${size}h${-size}z`)
      }),
    )
    return [...byColor].map(([fill, d]) => `<path d="${d}" fill="${fill}"/>`).join("")
  }
  return (shadow ? layer(shadow.dx, shadow.dy, (ch) => (paint(ch) ? shadow.color : null)) : "") + layer(0, 0, paint)
}

/** Each "on" cell becomes an n×n grid of tiny dots (dot-matrix / ASCII-font look). */
function dots(rows, { cell, n = 3, cx = 512, cy = 512, paint, shadow }) {
  const w = Math.max(...rows.map((r) => r.length)) * cell
  const h = rows.length * cell
  const x0 = cx - w / 2
  const y0 = cy - h / 2
  const step = cell / n
  const r = step * 0.36
  let s = ""
  const draw = (dx, dy, colorFor) => {
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        const fill = colorFor(ch)
        if (!fill) return
        for (let i = 0; i < n; i++)
          for (let j = 0; j < n; j++)
            s += `<circle cx="${x0 + x * cell + step * (i + 0.5) + dx}" cy="${y0 + y * cell + step * (j + 0.5) + dy}" r="${r}" fill="${fill}"/>`
      }),
    )
  }
  if (shadow) draw(shadow.dx, shadow.dy, (ch) => (paint(ch) ? shadow.color : null))
  draw(0, 0, paint)
  return s
}

// ---------- glyphs ----------

// Blocky lowercase "ctrl" in the spirit of the opencode wordmark.
// '#' = main tone, '+' = counter (inner, darker) tone. 17 columns × 7 rows.
const LETTERS = {
  c: ["....", "....", "####", "#++.", "#++.", "#++.", "####"],
  t: [".#..", ".#..", "####", ".#..", ".#..", ".#..", ".###"],
  r: ["....", "....", "####", "#++.", "#++.", "#...", "#..."],
  l: ["#.", "#.", "#.", "#.", "#.", "#.", "##"],
}
const word = (w, sep = ".") =>
  LETTERS.c.map((_, row) => [...w].map((ch) => LETTERS[ch][row]).join(sep))
const CTRL = word("ctrl")

// Big pixel "c" with a cursor block.
const C_CURSOR = [
  "#######....",
  "#######....",
  "##.........",
  "##.........",
  "##.........",
  "##.........",
  "#######.###",
  "#######.###",
]

// Pixel "c_" prompt for the dot-matrix take.
const C_DOT = [
  "#####....",
  "#........",
  "#........",
  "#........",
  "#####.###",
]

const svgs = {}

// A. "ctrl" wordmark, white with dark counters + teal block cursor ('@')
svgs.a_wordmark = frame(
  "#111111",
  pixels(
    CTRL.map((r, i) => r + (i >= 2 ? ".@@" : "...")),
    {
      cell: 32,
      paint: (ch) => ({ "#": "#f2f2f2", "+": "#3d3d3d", "@": "#2dd4bf" })[ch] ?? null,
    },
  ),
)

// A2. Two-tone like opencode: "ct" grey ('g'), "rl" white
svgs.a2_wordmark_twotone = frame(
  "#141414",
  pixels(
    CTRL.map((r) => r.slice(0, 9).replaceAll("#", "g").replaceAll("+", "h") + r.slice(9)),
    {
      cell: 34,
      paint: (ch) => ({ "#": "#f2f2f2", "+": "#5a5a5a", g: "#8a8a8a", h: "#3a3a3a" })[ch] ?? null,
    },
  ),
)

// B. Dot-matrix "c_" in green phosphor with drop shadow + dashed corner frame
svgs.b_dotmatrix = frame(
  "#0a0f0a",
  `<rect x="196" y="196" width="632" height="632" fill="none" stroke="#4ade80" stroke-width="10" stroke-dasharray="34 22" opacity="0.55"/>` +
    dots(C_DOT, {
      cell: 64,
      n: 4,
      paint: (ch) => (ch === "#" ? "#4ade80" : null),
      shadow: { dx: 14, dy: 14, color: "#14532d" },
    }),
)

// B2. Dot-matrix, grey letters with dark outline shadow (closest to the ASCII font sample)
svgs.b2_dotmatrix_grey = frame(
  "#111111",
  dots(C_CURSOR, {
    cell: 52,
    n: 4,
    paint: (ch) => (ch === "#" ? "#d4d4d4" : null),
    shadow: { dx: 12, dy: 12, color: "#3a3a3a" },
  }),
)

// C. Extruded 3D pixel "c" (lit top/left faces), like the hexagram reference
function extruded(rows, { cell, depth, cx = 512, cy = 512, front, side, top }) {
  const w = Math.max(...rows.map((r) => r.length)) * cell
  const h = rows.length * cell
  const x0 = cx - w / 2 - depth / 2
  const y0 = cy - h / 2 - depth / 2
  const on = (x, y) => rows[y]?.[x] === "#"
  let s = ""
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch !== "#") return
      const px = x0 + x * cell
      const py = y0 + y * cell
      // side face (right) and bottom face, drawn as parallelograms toward +depth
      if (!on(x + 1, y))
        s += `<polygon points="${px + cell},${py} ${px + cell + depth},${py + depth} ${px + cell + depth},${py + cell + depth} ${px + cell},${py + cell}" fill="${side}"/>`
      if (!on(x, y + 1))
        s += `<polygon points="${px},${py + cell} ${px + cell},${py + cell} ${px + cell + depth},${py + cell + depth} ${px + depth},${py + cell + depth}" fill="${top}"/>`
    }),
  )
  let d = ""
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === "#") d += `M${x0 + x * cell} ${y0 + y * cell}h${cell}v${cell}h${-cell}z`
    }),
  )
  return s + `<path d="${d}" fill="${front}"/>`
}

svgs.c_extruded_light = frame(
  "#f4f4f2",
  extruded(C_CURSOR, { cell: 50, depth: 34, front: "#1c1c1c", side: "#8c8c8c", top: "#bdbdbd" }),
  { stroke: "#00000014" },
)

svgs.c2_extruded_dark = frame(
  "#16181d",
  extruded(C_CURSOR, { cell: 50, depth: 34, front: "#f5f5f5", side: "#5b6170", top: "#3a3f4a" }),
)

// D. ASCII characters: the "c_" drawn with monospace glyphs
function asciiArt(lines, { size, cx = 512, cy = 512, color, dim }) {
  const lh = size * 1.12
  const cw = size * 0.6
  const w = Math.max(...lines.map((l) => l.length)) * cw
  const y0 = cy - (lines.length * lh) / 2 + size * 0.8
  const x0 = cx - w / 2
  return lines
    .map((line, i) =>
      [...line]
        .map((ch, j) =>
          ch === " "
            ? ""
            : `<text x="${x0 + j * cw}" y="${y0 + i * lh}" font-family="Menlo, monospace" font-weight="700" font-size="${size}" fill="${ch === "." || ch === ":" ? dim : color}">${ch === "<" ? "&lt;" : ch === "&" ? "&amp;" : ch}</text>`,
        )
        .join(""),
    )
    .join("")
}

svgs.d_ascii_chars = frame(
  "#0c0c0c",
  asciiArt(
    [
      "..........",
      ".########.",
      ".##.......",
      ".##.......",
      ".##.......",
      ".##.......",
      ".########.",
      "......####",
      "..........",
    ],
    { size: 74, color: "#e5e5e5", dim: "#3a3a3a" },
  ),
)

svgs.d2_ascii_ctrl = frame(
  "#0c0c0c",
  asciiArt(
    [
      "+--------+",
      "|        |",
      "|  ctrl  |",
      "|  ____  |",
      "|        |",
      "+--------+",
    ],
    { size: 96, color: "#e5e5e5", dim: "#555" },
  ),
)

// ---------- render ----------
const names = Object.keys(svgs)
for (const name of names) {
  writeFileSync(join(out, `${name}.svg`), svgs[name])
  writeFileSync(join(out, `${name}.png`), new Resvg(svgs[name], { fitTo: { mode: "width", value: 512 } }).render().asPng())
}

// contact sheet: 4 columns with labels
const cols = 4
const tile = 300
const rows = Math.ceil(names.length / cols)
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * tile}" height="${rows * (tile + 40)}">
<rect width="100%" height="100%" fill="#e9e9e7"/>
${names
  .map((n, i) => {
    const x = (i % cols) * tile
    const y = Math.floor(i / cols) * (tile + 40)
    const inner = svgs[n].replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
    return `<g transform="translate(${x + 10},${y + 10}) scale(${(tile - 20) / 1024})">${inner.replaceAll('id="sh"', `id="sh${i}"`).replaceAll("url(#sh)", `url(#sh${i})`).replaceAll('id="sq"', `id="sq${i}"`).replaceAll("url(#sq)", `url(#sq${i})`)}</g>
<text x="${x + tile / 2}" y="${y + tile + 22}" text-anchor="middle" font-family="Helvetica" font-size="18" fill="#333">${n}</text>`
  })
  .join("\n")}
</svg>`
writeFileSync(join(out, "sheet.png"), new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng())
console.log(`wrote ${names.length} variants + sheet.png to ${out}`)
