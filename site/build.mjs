// Builds the ctrl.lucleray.me static site into site/dist: the pages in site/, the README media from
// docs/media and the app icon, with the dot-matrix wordmark rendered into the HTML.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = dirname(fileURLToPath(import.meta.url))
const root = join(site, '..')
const dist = join(site, 'dist')

const GLYPHS = {
  c: ['....', '....', '.XXX', 'X...', 'X...', 'X...', '.XXX'],
  t: ['.X..', '.X..', 'XXXX', '.X..', '.X..', '.X..', '..XX'],
  r: ['....', '....', 'X.XX', 'XX..', 'X...', 'X...', 'X...'],
  l: ['XX.', '.X.', '.X.', '.X.', '.X.', '.X.', '.XX'],
  '.': ['..', '..', '..', '..', '..', 'XX', 'XX'],
}

// Each glyph pixel is a 3x3 block of dots, like the app icon.
function wordmark(text) {
  const SUB = 3
  const STEP = 10
  const R = 3.6
  const rows = 7 * SUB
  const cols = []
  for (const [i, ch] of [...text].entries()) {
    if (i > 0) cols.push(Array(7).fill('.'))
    const g = GLYPHS[ch]
    for (let x = 0; x < g[0].length; x++) cols.push(g.map((row) => row[x]))
  }
  const width = cols.length * SUB
  let lit = ''
  let off = ''
  for (let cx = 0; cx < width; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const on = cols[Math.floor(cx / SUB)][Math.floor(cy / SUB)] === 'X'
      const dot = `<circle cx="${cx * STEP + STEP / 2}" cy="${cy * STEP + STEP / 2}" r="${R}"/>`
      if (on) lit += dot
      else off += dot
    }
  }
  return (
    `<svg class="wordmark" viewBox="0 0 ${width * STEP} ${rows * STEP}" role="img" aria-label="ctrl.">` +
    `<g class="off">${off}</g><g class="lit">${lit}</g></svg>`
  )
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const html = readFileSync(join(site, 'index.html'), 'utf8').replace('<!--WORDMARK-->', wordmark('ctrl.'))
writeFileSync(join(dist, 'index.html'), html)
for (const file of ['style.css', 'main.js']) cpSync(join(site, file), join(dist, file))
cpSync(join(root, 'docs/media'), join(dist, 'media'), { recursive: true })
cpSync(join(root, 'build/icon.png'), join(dist, 'icon.png'))

console.log(`site built into ${dist}`)
