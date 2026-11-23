// Copy buttons
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.copy)
    button.textContent = 'Copied'
    button.classList.add('done')
    setTimeout(() => {
      button.textContent = 'Copy'
      button.classList.remove('done')
    }, 1600)
  })
}

// Wordmark: the build renders it as an SVG of dots. Here it moves to a canvas: the dots light up on load,
// and the pointer drops two wave sources on it (the cursor and its mirror) whose interference ripples
// through the dots.
const svgMark = document.querySelector('svg.wordmark')
if (svgMark) {
  const vb = svgMark.viewBox.baseVal
  const dots = [...svgMark.querySelectorAll('circle')].map((c, i) => ({
    x: +c.getAttribute('cx'),
    y: +c.getAttribute('cy'),
    lit: c.parentNode.classList.contains('lit'),
    i,
  }))
  const R0 = 3.6
  const canvas = document.createElement('canvas')
  canvas.className = 'wordmark'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'ctrl.')
  svgMark.replaceWith(canvas)
  const ctx = canvas.getContext('2d')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  const css = getComputedStyle(document.documentElement)
  const hex = (v) => {
    const h = css.getPropertyValue(v).trim().replace('#', '')
    return [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16))
  }
  const FG = hex('--fg')
  const OFF = hex('--dot-off')
  const BLUE = [59, 130, 246]
  const SKY = [147, 197, 253]
  const mix = (a, b, t) => `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`

  let scale = 1
  function size() {
    const w = canvas.clientWidth
    const dpr = devicePixelRatio || 1
    scale = w / vb.width
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round((w * vb.height * dpr) / vb.width)
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)
    kick()
  }

  const start = performance.now()
  const pointer = { x: -1e4, y: -1e4, in: false }
  const trail = { x: -1e4, y: -1e4 }
  let amp = 0
  let raf = 0

  const K = (Math.PI * 2) / 46 // wavelength: a little under 5 dots
  const RADIUS = 210

  function frame(now) {
    raf = 0
    const t = (now - start) / 1000
    amp += ((pointer.in ? 1 : 0) - amp) * 0.08
    trail.x += (pointer.x - trail.x) * 0.12
    trail.y += (pointer.y - trail.y) * 0.12
    const mx = vb.width - trail.x
    const my = vb.height - trail.y
    ctx.clearRect(0, 0, vb.width, vb.height)
    let intro = false
    for (const d of dots) {
      let on = 1
      if (d.lit && !reduced) {
        const p = (now - start - (d.x * 0.9 + (d.i % 7) * 4)) / 500
        if (p < 1) intro = true
        on = Math.max(0, Math.min(1, p))
      }
      let v = 0
      if (amp > 0.002) {
        const d1 = Math.hypot(d.x - trail.x, d.y - trail.y)
        const d2 = Math.hypot(d.x - mx, d.y - my)
        const wave = (Math.sin(K * d1 - t * 5) + Math.sin(K * d2 - t * 5)) / 2
        v = amp * wave * Math.exp(-((d1 / RADIUS) ** 2))
      }
      const up = Math.max(0, v)
      const down = Math.max(0, -v)
      let r = R0
      let color
      if (d.lit) {
        r = R0 * (1 - 0.45 * down + 0.1 * up)
        color = up > 0.02 ? mix(FG, BLUE, Math.min(1, up * 1.3)) : mix(OFF, FG, on)
        if (down > 0.02) color = mix(FG, OFF, down * 0.7)
      } else {
        r = R0 * (1 + 0.2 * up)
        color = mix(OFF, SKY, Math.min(1, up * 1.2))
      }
      ctx.beginPath()
      ctx.arc(d.x, d.y, Math.max(0.4, r), 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    }
    if (intro || amp > 0.002 || pointer.in) kick()
  }

  function kick() {
    if (!raf) raf = requestAnimationFrame(frame)
  }

  const zone = canvas.parentElement
  zone.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect()
    pointer.x = (e.clientX - r.left) / scale
    pointer.y = (e.clientY - r.top) / scale
    if (!pointer.in) {
      trail.x = pointer.x
      trail.y = pointer.y
    }
    pointer.in = true
    kick()
  })
  zone.addEventListener('pointerleave', () => {
    pointer.in = false
    kick()
  })

  new ResizeObserver(size).observe(canvas)
}
