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

// opencode / fx switch: swaps every screenshot to its fx twin (`<name>-fx.<ext>`)
const tabs = document.querySelectorAll('.switch [data-harness]')
function setHarness(harness) {
  document.documentElement.dataset.harness = harness
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.harness === harness))
  for (const img of document.querySelectorAll('img[data-src]')) {
    const ext = img.dataset.ext || 'png'
    img.src = `/media/${img.dataset.src}${harness === 'fx' ? '-fx' : ''}.${ext}`
  }
}
for (const tab of tabs) tab.addEventListener('click', () => setHarness(tab.dataset.harness))

// Wordmark: dots light up one by one on load
const lit = document.querySelectorAll('.wordmark .lit circle')
lit.forEach((dot, i) => {
  dot.style.animationDelay = `${(Number(dot.getAttribute('cx')) / 10) * 9 + (i % 7) * 4}ms`
})
