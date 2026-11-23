// The interactive demo: a fake ctrl window, driven by the list of features next to it.
// Nothing here talks to a model: sessions, replies and CLI output are all canned.

const root = document.getElementById('demo')
const mock = root.querySelector('.mock')
const listEl = root.querySelector('.flist')
const capTitle = root.querySelector('.cap-title')
const capHint = root.querySelector('.cap-hint')
const dockEl = root.querySelector('.mw-dock')

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const clone = (o) => JSON.parse(JSON.stringify(o))

const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`
const ICON = {
  folder: svg('<path d="M1.75 3.5h4l1.5 1.5h7v7.5h-12.5z"/>'),
  chev: svg('<path d="M6 4l4 4-4 4"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"/>'),
  board: svg('<rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="9" rx="1"/>'),
  pen: svg('<path d="M3 13l.6-2.7L10.8 3l2.2 2.2-7.3 7.2z"/>'),
  edit: svg('<path d="M13 9v4H3V3h4"/><path d="M7 9l.4-2L12 2.4 13.6 4 9 8.6z"/>'),
  bot: svg('<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6.2 9h.01M9.8 9h.01"/>'),
  archive: svg('<rect x="2" y="3" width="12" height="3" rx=".8"/><path d="M3 6v7h10V6M6.5 9h3"/>'),
  pr: svg('<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V6.5a2 2 0 0 0-2-2H7.5"/>'),
  issue: svg('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1"/>'),
  linear: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8l2 2 3-4"/>'),
  slack: svg('<path d="M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z"/>'),
  vercel: svg('<path d="M8 3l6 10H2z"/>'),
  tree: svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>'),
  session: svg('<path d="M2.5 3.5h11v7h-7l-3 2.5v-2.5h-1z"/>'),
  dock: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>'),
  link: svg('<path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>'),
  copy: svg('<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 10.5V3h7.5"/>'),
  shell: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10.5h2.5"/>'),
  sub: svg('<circle cx="8" cy="5" r="2.5"/><path d="M3.5 13.5c.6-2.4 2.4-3.5 4.5-3.5s3.9 1.1 4.5 3.5"/>'),
  x: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  up: svg('<path d="M8 13V3.5M4 7.5l4-4 4 4"/>'),
  stop: svg('<rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor"/>'),
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
}
const ic = (name, cls = '') => `<span class="ic ${cls}">${ICON[name]}</span>`

/* ---------- Data ---------- */

const SPACES = [
  { id: 'next', name: 'next.js', folder: '~/code/next.js', harness: 'opencode', model: 'Big Pickle', instr: 'Run pnpm test-dev on the files you touch.' },
  { id: 'ctrl', name: 'ctrl', folder: '~/code/ctrl', harness: 'fx', model: 'gpt-5.5 · high', instr: 'One worktree per session.' },
  { id: 'ai', name: 'AI SDK', folder: '~/code/ai', harness: 'opencode', model: 'Claude Opus 5.5', instr: '' },
]

const SESSIONS = [
  { id: 's1', title: 'Allow loopback IPs in dev origin check', space: 'next', status: 'idle', age: '1m', harness: 'opencode' },
  { id: 's2', title: 'Fix flaky GTM e2e test', space: 'next', status: 'done', age: '4m', harness: 'opencode' },
  { id: 's3', title: 'Type-check fails with noUnusedLocals', space: 'next', status: 'failed', age: '9m', harness: 'fx' },
  { id: 's4', title: 'Review #99933 prerender coverage', space: 'next', status: 'idle', age: '1h', harness: 'opencode' },
  { id: 's5', title: 'Check the preview deploy', space: 'next', parent: 's4', status: 'bg', age: '1h', harness: 'opencode', bot: 'Review #99933 prerender coverage' },
  { id: 's6', title: 'Website v2', space: 'ctrl', status: 'idle', age: '2m', harness: 'fx' },
  { id: 's7', title: 'Board columns by whose turn', space: 'ctrl', status: 'idle', age: '3h', harness: 'opencode' },
  { id: 's8', title: 'Revert HeyGen video provider', space: 'ai', status: 'input', age: '2m', harness: 'opencode' },
  { id: 's9', title: 'Release notes for 6.0', space: 'ai', status: 'idle', age: '5h', harness: 'fx' },
]

const PREVIEW = 'https://next-site-git-loopback-origins-acme.vercel.app/docs/app/api-reference/config/next-config-js/allowedDevOrigins'

const TX = {
  s1: [
    ['user', 'Requests from 127.0.0.1 get blocked by the dev origin check when next dev runs behind a local proxy'],
    ['tool', '$ rg -n "allowedDevOrigins" packages/next/src | head -3'],
    ['text', 'Found it. The check only trusts localhost, so 127.0.0.1 and ::1 count as cross-site. I added them to the default list, with a test for each.'],
    ['text', `Opened https://github.com/vercel/next.js/pull/99932 with the fix. The preview is at ${PREVIEW}`],
    ['meta', 'Build · Big Pickle · 1m 30s'],
  ],
  s2: [
    ['user', 'The GTM e2e test fails one run out of five on CI'],
    ['tool', '$ pnpm test-dev test/e2e/gtm --repeat 20'],
    ['text', 'It raced the script load. It now waits for the gtm.js request before asserting: 20/20 green. PR: https://github.com/vercel/next.js/pull/99940'],
    ['meta', 'Build · Big Pickle · 6m 12s'],
  ],
  s3: [
    ['user', 'Type-check fails with noUnusedLocals after the codegen change'],
    ['tool', '$ pnpm typecheck'],
    ['error', "✕ packages/next/src/build/types.ts:212  'Route' is declared but never used"],
    ['text', 'The generated types import Route even when no route is typed. Want me to drop the import from the template?'],
  ],
  s4: [
    ['user', 'Review https://github.com/vercel/next.js/pull/99933'],
    ['text', 'Two findings: the fallback shell skips @modal, and one test asserts on timing. I started a child session to check the preview deploy.'],
    ['meta', 'Build · Big Pickle · 3m 02s'],
  ],
  s5: [
    ['user', 'Check that the preview deploy serves the /@modal routes'],
    ['tool', '$ pnpm next start --port 4100   ↗ background'],
    ['text', 'The server keeps running in the background. Curling the routes now.'],
  ],
  s6: [
    ['user', 'Make a website for ctrl'],
    ['tool', '$ node site/build.mjs'],
    ['text', 'Built into site/dist. Deployed to https://ctrl.lucleray.me'],
    ['meta', 'fx · gpt-5.5 · 8m'],
  ],
  s7: [
    ['user', 'Sort the board by whose turn it is'],
    ['text', 'Done: Needs you, Waiting on others, In progress, Done. Merged in https://github.com/lucleray/ctrl/pull/52'],
    ['meta', 'Build · Big Pickle · 12m'],
  ],
  s8: [
    ['user', 'Revert the HeyGen video provider, it breaks the playground'],
    ['tool', '$ git log --oneline -- packages/heygen'],
    ['q', 'Revert it in both packages, or only in @ai-sdk/heygen?', ['Both packages', 'Only @ai-sdk/heygen']],
  ],
  s9: [
    ['user', 'Draft the release notes for 6.0'],
    ['text', 'Drafted in RELEASE.md: 14 features, 3 breaking changes, 2 deprecations.'],
    ['meta', 'fx · gpt-5.5 · 4m'],
  ],
}

const RES = {
  s1: [
    { type: 'pr', title: 'Allow loopback IPs by default in dev origin check', sub: 'vercel/next.js#99932', chips: [['draft', ''], ['CI', 'pending']] },
    { type: 'issue', title: 'Unused imports in generated .next types', sub: 'vercel/next.js#99919', chips: [] },
    { type: 'linear', title: 'DX-142', sub: 'Allow loopback ips in dev origin check', chips: [] },
    { type: 'slack', title: 'Thread · 9 Oct, 15:06', sub: 'acme · #devtools', chips: [] },
    { type: 'vercel', title: 'next-site-git-loopback-origins', sub: 'Preview', chips: [['Building', 'pending']] },
  ],
  s2: [{ type: 'pr', title: 'Wait for gtm.js before asserting', sub: 'vercel/next.js#99940', chips: [['CI', 'ok']] }],
  s3: [{ type: 'issue', title: 'noUnusedLocals fails on generated types', sub: 'vercel/next.js#99921', chips: [] }],
  s4: [
    { type: 'pr', title: 'Prerender coverage for parallel routes', sub: 'vercel/next.js#99933', chips: [['Waiting on @alice', '']] },
    { type: 'session', title: 'Check the preview deploy', sub: 'next.js · running', chips: [['running', 'pending']] },
  ],
  s6: [{ type: 'vercel', title: 'ctrl-site', sub: 'Production', chips: [['Ready', 'ok']] }],
  s7: [{ type: 'pr', title: 'Board columns by whose turn', sub: 'lucleray/ctrl#52', chips: [['merged', 'merged']] }],
  s8: [{ type: 'pr', title: 'Revert HeyGen video provider', sub: 'vercel/ai#812', chips: [['Changes requested', 'bad']] }],
}

const RES_GROUPS = [
  ['pr', 'Pull requests'],
  ['tree', 'Worktrees'],
  ['session', 'Sessions'],
  ['issue', 'Issues'],
  ['linear', 'Linear issues'],
  ['slack', 'Slack threads'],
  ['vercel', 'Vercel deployments'],
]

const CARDS = [
  { col: 0, type: 'GitHub', icon: 'pr', title: 'Allow loopback IPs by default', sub: 'vercel/next.js#99932', why: 'CI failed', tone: 'bad', s: ['s1'] },
  { col: 0, type: 'GitHub', icon: 'pr', title: 'Revert HeyGen video provider', sub: 'vercel/ai#812', why: 'Changes requested', tone: 'bad', s: ['s8'] },
  { col: 0, type: 'Slack', icon: 'slack', title: '“anyone looking at the GTM flake?”', sub: '#devtools · Alice', why: 'Asked you', tone: 'pending', s: ['s2'] },
  { col: 1, type: 'GitHub', icon: 'pr', title: 'Prerender coverage for parallel routes', sub: 'vercel/next.js#99933', why: 'Waiting on @alice', tone: '', s: ['s4', 's5'] },
  { col: 1, type: 'Linear', icon: 'linear', title: 'DX-142 Allow loopback ips', sub: 'Linear · In review', why: 'In review', tone: '', s: ['s1'] },
  { col: 2, type: 'Vercel', icon: 'vercel', title: 'ctrl-site', sub: 'Production', why: 'Building', tone: 'pending', s: ['s6'] },
  { col: 2, type: 'GitHub', icon: 'pr', title: 'Wait for gtm.js before asserting', sub: 'vercel/next.js#99940', why: 'CI running', tone: 'pending', s: ['s2'] },
  { col: 3, type: 'GitHub', icon: 'pr', title: 'Board columns by whose turn', sub: 'lucleray/ctrl#52', why: 'Merged', tone: 'merged', s: ['s7'] },
  { col: 3, type: 'Vercel', icon: 'vercel', title: 'next-site-git-canary', sub: 'Preview', why: 'Ready', tone: 'ok', s: ['s1'] },
]
const COLS = ['Needs you', 'Waiting on others', 'In progress', 'Done']

const CLI = [
  { cmd: 'ctrl space get self', out: '{ "name": "next.js", "folder": "~/code/next.js", "sessions": 6 }' },
  {
    cmd: 'ctrl session new --title "Fix GTM e2e test" --prompt -',
    out: '{ "id": "ses_8c1f", "parentID": "ses_41aa", "space": "next.js" }',
    run: () => addAgentSession('c1', 'Fix GTM e2e test'),
  },
  {
    cmd: 'ctrl session new --title "Fix type-check" --prompt -',
    out: '{ "id": "ses_9d02", "parentID": "ses_41aa", "space": "next.js" }',
    run: () => addAgentSession('c2', 'Fix type-check'),
  },
  {
    cmd: 'ctrl session wait ses_8c1f ses_9d02 --status idle',
    out: '{ "idle": ["ses_8c1f", "ses_9d02"], "waited": "41s" }',
    wait: 2600,
    run: () => S.sessions.filter((x) => x.id === 'c1' || x.id === 'c2').forEach((x) => (x.status = 'done')),
  },
  {
    cmd: 'ctrl worktree up ~/code/next.js',
    out: '{ "path": "~/.ctrl/worktrees/next-js/a866", "branch": "canary", "cold": false, "tookMs": 38 }',
    run: () => {
      S.res.sc = [{ type: 'tree', title: 'next.js · canary', sub: '~/.ctrl/worktrees/next-js/a866', chips: [['ready', 'ok']] }, ...(S.res.sc || [])]
      S.panel = 'float'
    },
  },
  { cmd: 'ctrl ui toast "Both fixes are in 🌊"', out: '{ "ok": true }', run: () => toast('Both fixes are in 🌊') },
]

const INSTALL = [
  ['p', '$ curl -fsSL https://ctrl.lucleray.me/install.sh | sh'],
  ['o', 'Downloading the latest ctrl (arm64)…'],
  ['bar', ''],
  ['o', 'Installing into /Applications…'],
  ['o', 'Linked ~/.local/bin/ctrl'],
  ['ok', '✓ ctrl 0.46.0 is installed. Opening it…'],
]

const SHORTCUTS = [
  ['New chat', '⌘N'],
  ['New session here', '⌘T'],
  ['Search', '⌘P'],
  ['Archive session', '⌘W'],
  ['Resources panel', '⇧⌘R'],
  ['Settings', '⌘,'],
  ['New session from screen', '⌃⌥⌘Space'],
]

const MODELS = ['Big Pickle', 'Claude Opus 5.5', 'GPT-5.5', 'Gemini 3 Pro', 'Kimi K3']

const REPLIES = [
  "On it. I'll start with the failing test and report back.",
  'Done. Ran the suite twice, all green.',
  'Good call. Switched approaches, the diff is half the size now.',
  'Pushed. CI is running on the PR.',
]

const SOUNDS = { Glass: [1568, 0.5], Ping: [1318, 0.35], Pop: [520, 0.12], Hero: [784, 0.6], Basso: [123, 0.5], Submarine: [220, 0.7], None: null }

/* ---------- State ---------- */

let S
let timers = []
let jumpN = 0
let visible = []
let hovering = false
let audio = null
let replyN = 0

function base() {
  return {
    spaces: clone(SPACES),
    sessions: clone(SESSIONS),
    tx: clone(TX),
    res: clone(RES),
    resArchived: [],
    archived: [
      { id: 'a1', title: 'Bump turbo to 2.4', space: 'next', status: 'idle', age: '2d', harness: 'opencode' },
      { id: 'a2', title: 'Investigate cold starts', space: 'ai', status: 'idle', age: '3d', harness: 'fx' },
    ],
    current: 's1',
    mode: 'term',
    main: 'term',
    overlay: null,
    panel: 'float',
    resTab: 'session',
    badges: false,
    toast: null,
    banner: null,
    dock: 0,
    recents: false,
    archivedOpen: false,
    folded: {},
    theme: 'light',
    tuiTheme: 'opencode',
    fontSize: 12,
    sbw: 212,
    drafts: {},
    prompt: {},
    pastes: {},
    settings: 'Appearance',
    settingsQuery: '',
    palette: '',
    paletteSel: 0,
    cli: { step: 0, lines: [], busy: false },
    install: { lines: [], busy: false },
    phone: { screen: 'list', session: null, q: 0, answers: [], perm: 'ask' },
    board: { hidden: [] },
    tools: { gh: 'ok', vercel: 'ok', aws: 'ok', pup: 'ok', linear: 'ok', notion: 'ok' },
    sounds: { finished: 'Glass', failed: 'Basso', 'needs you': 'Ping' },
    shortcuts: clone(SHORTCUTS),
    rebinding: -1,
    skills: { read: false, ctrl: true },
    instr: true,
    showInstr: false,
    update: 'idle',
    space: null,
    welcome: { step: 0, harness: 'opencode' },
    stream: null,
    steer: [],
    model: 'Big Pickle',
    picker: false,
    pickerQ: '',
    work: null,
    work2: [
      { kind: 'shell', label: 'pnpm next start --port 4100', ago: '6m' },
      { kind: 'sub', label: 'Check the /@modal routes', ago: '2m' },
    ],
    comp: { x: 440, y: 120 },
    hl: null,
    focus: null,
    switchMs: null,
    undo: null,
  }
}

const cur = () => S.sessions.find((x) => x.id === S.current)
const spaceOf = (x) => S.spaces.find((sp) => sp.id === x?.space) || S.spaces[0]
const byId = (id) => S.sessions.find((x) => x.id === id)

function later(ms, fn) {
  timers.push(
    setTimeout(() => {
      fn()
      render()
    }, ms),
  )
}

function clearTimers() {
  for (const t of timers) clearTimeout(t)
  timers = []
}

function toast(msg, opts = {}) {
  S.toast = { msg, ...opts, at: Date.now() }
  const at = S.toast.at
  if (!opts.sticky) later(opts.ms || 3200, () => S.toast?.at === at && (S.toast = null))
}

function play(name) {
  const s = SOUNDS[name]
  if (!s) return
  try {
    audio ||= new AudioContext()
    const t = audio.currentTime
    const o = audio.createOscillator()
    const g = audio.createGain()
    o.type = 'sine'
    o.frequency.value = s[0]
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + s[1])
    o.connect(g).connect(audio.destination)
    o.start(t)
    o.stop(t + s[1] + 0.05)
  } catch {}
}

/* ---------- Actions ---------- */

function open(id) {
  const x = byId(id)
  if (!x) return
  const t0 = performance.now()
  S.current = id
  if (x.status === 'done' || x.status === 'failed') x.status = 'idle'
  S.main = S.mode
  S.overlay = null
  S.picker = false
  render()
  S.switchMs = Math.max(1, Math.round(performance.now() - t0))
  if (S.feature === 'switch') render()
}

function visibleIds() {
  jumpN = 0
  visible = []
  sidebar()
  return visible
}

function newSession(spaceId, opts = {}) {
  const sp = S.spaces.find((s) => s.id === spaceId) || S.spaces[0]
  const id = 'n' + Date.now()
  S.sessions.unshift({ id, title: 'New session', space: sp.id, status: 'idle', age: 'now', harness: opts.harness || sp.harness, fresh: true })
  S.tx[id] = []
  if (opts.prompt) S.prompt[id] = opts.prompt
  S.folded[sp.id] = false
  S.current = id
  S.main = S.mode
  S.overlay = null
  S.focus = S.mode === 'chat' ? '[data-input="composer"]' : '[data-input="prompt"]'
}

function archive(id) {
  const x = byId(id)
  if (!x) return
  const ids = [id, ...S.sessions.filter((k) => k.parent === id).map((k) => k.id)]
  const gone = S.sessions.filter((k) => ids.includes(k.id))
  const before = clone(S.sessions)
  const wasCurrent = ids.includes(S.current)
  const order = visibleIds()
  S.sessions = S.sessions.filter((k) => !ids.includes(k.id))
  S.archived.unshift(...gone)
  if (wasCurrent) S.current = order.find((v) => !ids.includes(v) && byId(v)) || null
  const prevCurrent = id
  const tree = (S.res[id] || []).some((r) => r.type === 'tree')
  S.undo = () => {
    S.sessions = before
    S.archived = S.archived.filter((k) => !ids.includes(k.id))
    if (wasCurrent) S.current = prevCurrent
  }
  toast(`Archived “${x.title}”${tree ? ' · its worktree goes back to the pool' : ''}`, { action: 'Undo', act: 'undo', kbd: '⌘Z', ms: 5000 })
}

function unarchive(id) {
  const x = S.archived.find((k) => k.id === id)
  if (!x) return
  S.archived = S.archived.filter((k) => k.id !== id)
  S.sessions.push(x)
  toast(`Unarchived “${x.title}”`)
}

function send(id, text) {
  const x = byId(id)
  if (!x || !text.trim()) return
  const t = S.tx[id] || (S.tx[id] = [])
  for (const [token, full] of Object.entries(S.pastes[id] || {})) text = text.replace(token, full)
  t.push(['user', text])
  if (x.fresh || x.title === 'New session') {
    x.title = text.replace(/@?session\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/@\[([^\]]+)\]/g, '$1').split(/\s+/).slice(0, 6).join(' ').slice(0, 44)
    x.fresh = false
  }
  S.prompt[id] = ''
  S.drafts[id] = ''
  delete S.pastes[id]
  x.status = 'running'
  x.age = 'now'
  const ref = text.match(/session\[([^\]]+)\]/) || text.match(/@\[([^\]]+)\]/)
  const reply = ref
    ? `Read “${ref[1]}”. Picking up where it left off: the fix is in, I'll add the missing test next.`
    : REPLIES[replyN++ % REPLIES.length]
  if (S.main === 'chat') return stream(id, reply)
  later(1500, () => {
    t.push(['text', reply], ['meta', x.harness === 'fx' ? 'fx · gpt-5.5 · 2s' : `Build · ${S.model} · 2s`])
    x.status = S.current === id ? 'idle' : 'done'
  })
}

function stream(id, reply) {
  const x = byId(id)
  const t = S.tx[id]
  later(500, () => {
    t.push(['tool', '$ pnpm test-dev test/e2e/gtm --repeat 5'])
    t.push(['text', ''])
    S.stream = { id, words: reply.split(' '), i: 0, line: t.length - 1 }
    tick()
  })
  function tick() {
    const st = S.stream
    if (!st || st.id !== id) return
    if (S.steer.length && st.i > 3) {
      const msg = S.steer.shift()
      t.push(['user', msg], ['text', ''])
      st.line = t.length - 1
      st.words = 'Got it, changing course. Keeping the old behavior behind a flag and updating the tests to match.'.split(' ')
      st.i = 0
    }
    if (st.i >= st.words.length) {
      S.stream = null
      x.status = S.current === id ? 'idle' : 'done'
      render()
      return
    }
    t[st.line][1] += (st.i ? ' ' : '') + st.words[st.i++]
    render()
    timers.push(setTimeout(tick, 70))
  }
}

function insertPrompt(text) {
  const x = cur()
  if (!x) return
  const key = S.main === 'chat' ? 'drafts' : 'prompt'
  const prev = S[key][x.id] || ''
  S[key][x.id] = prev + (prev && !prev.endsWith(' ') ? ' ' : '') + text + ' '
  S.focus = S.main === 'chat' ? '[data-input="composer"]' : '[data-input="prompt"]'
}

function mention(x) {
  if (S.main === 'chat') return `@[${x.title}]`
  const s = cur()
  return `${s?.harness === 'fx' ? '' : '@'}session[${x.title}](ses_${(x.id.charCodeAt(1) * 7919).toString(16)}a)`
}

function addAgentSession(id, title) {
  S.sessions.push({ id, title, space: 'next', parent: 'sc', status: 'running', age: 'now', harness: 'opencode', bot: 'Fan out the flaky test fixes' })
  S.tx[id] = [['user', title]]
  S.folded.sc = false
}

function runCli() {
  const c = S.cli
  if (c.busy) return
  if (c.step >= CLI.length) {
    S.cli = { step: 0, lines: [], busy: false }
    S.sessions = S.sessions.filter((x) => x.id !== 'c1' && x.id !== 'c2')
    S.res.sc = []
    return
  }
  const step = CLI[c.step]
  c.busy = true
  c.lines.push(['p', ''])
  const line = c.lines.length - 1
  let i = 0
  const type = () => {
    if (i < step.cmd.length) {
      c.lines[line][1] = step.cmd.slice(0, ++i)
      render()
      timers.push(setTimeout(type, 16))
      return
    }
    if (step.wait) c.lines.push(['wait', 'waiting for 2 sessions…'])
    later(step.wait || 350, () => {
      if (step.wait) c.lines.pop()
      c.lines.push(['o', step.out])
      step.run?.()
      c.step++
      c.busy = false
    })
  }
  type()
}

function runInstall() {
  const ins = S.install
  if (ins.busy) return
  ins.lines = []
  ins.busy = true
  INSTALL.forEach((l, i) =>
    later(300 + i * 650, () => {
      ins.lines.push(clone(l))
      if (i === INSTALL.length - 1) {
        ins.busy = false
        toast('ctrl updates itself: new releases show up right here', { ms: 4000 })
      }
    }),
  )
  for (let p = 1; p <= 10; p++) later(300 + 2 * 650 + p * 55, () => ins.lines[2] && (ins.lines[2][1] = p * 10))
}

/* ---------- Render: sidebar ---------- */

function status(x) {
  const draft = S.drafts[x.id] && x.id !== S.current ? ic('pen', 'draft') : ''
  switch (x.status) {
    case 'running':
      return '<span class="spin" title="Running"></span>'
    case 'done':
      return '<span class="dot blue" title="Finished"></span>'
    case 'failed':
      return '<span class="dot red" title="Failed"></span>'
    case 'input':
      return '<span class="dot amber" title="Waiting for your answer"></span>'
    case 'bg':
      return `<span class="pulse" title="1 shell and 1 subagent still running">${ICON.shell}</span>`
    default:
      return `<span class="age">${draft}${x.age}</span>`
  }
}

const RANK = { input: 6, running: 5, failed: 4, done: 3, bg: 2 }
function rollup(list) {
  const top = list.reduce((a, x) => ((RANK[x.status] || 0) > (RANK[a?.status] || 0) ? x : a), null)
  return top && RANK[top.status] ? status(top) : ''
}

function row(x, depth, kids) {
  const n = ++jumpN
  visible.push(x.id)
  const on = x.id === S.current && (S.main === 'term' || S.main === 'chat' || S.main === 'cli')
  const folded = S.folded[x.id]
  const tail = S.badges && n <= 9 ? `<span class="kbd">⌘${n}</span>` : folded && kids.length ? rollup([x, ...kids]) || status(x) : status(x)
  return `<div class="row ${on ? 'on' : ''}" style="--d:${depth}" draggable="true" data-a="open" data-id="${x.id}" data-drop="session" data-session="${x.id}">
    ${kids.length ? `<span class="ic chev ${folded ? '' : 'open'}" data-a="fold" data-id="${x.id}">${ICON.chev}</span>` : '<span class="chev-sp"></span>'}
    ${x.bot ? `<span class="ic bot" data-tip="Created by an agent in “${esc(x.bot)}”">${ICON.bot}</span>` : ''}
    <span class="t">${esc(x.title)}</span>
    ${x.harness === 'fx' ? '<span class="tag">fx</span>' : ''}
    <button class="ic arch" data-a="archive" data-id="${x.id}" title="Archive (⌘W)">${ICON.archive}</button>
    ${tail}
  </div>`
}

function tree(x, depth) {
  const kids = S.sessions.filter((k) => k.parent === x.id && k.space === x.space)
  let out = row(x, depth, kids)
  if (kids.length && !S.folded[x.id]) for (const k of kids) out += tree(k, depth + 1)
  return out
}

function sidebar() {
  let spaces = ''
  for (const sp of S.spaces) {
    const open = !S.folded[sp.id]
    const list = S.sessions.filter((x) => x.space === sp.id)
    spaces += `<div class="sp" data-a="fold" data-id="${sp.id}" data-drop="space" data-space="${sp.id}">
      <span class="ic chev ${open ? 'open' : ''}">${ICON.chev}</span>${ic('folder')}<span class="t">${esc(sp.name)}</span>
      <button class="ic sp-more" data-a="space-settings" data-id="${sp.id}" title="Space settings">⋯</button>
      ${open ? '' : rollup(list)}</div>`
    if (open) for (const x of list.filter((x) => !x.parent || byId(x.parent)?.space !== x.space)) spaces += tree(x, 1)
  }
  const recents = S.recents
    ? S.sessions
        .slice(0, 6)
        .map((x) => `<div class="row" style="--d:0" data-a="open" data-id="${x.id}"><span class="t">${esc(x.title)}</span>${status(x)}</div>`)
        .join('')
    : ''
  const archived = S.archivedOpen
    ? S.archived
        .map(
          (x) =>
            `<div class="row dim" style="--d:0"><span class="t">${esc(x.title)}</span><button class="unarch" data-a="unarchive" data-id="${x.id}">Unarchive</button></div>`,
        )
        .join('')
    : ''
  return `<aside class="sb">
    <div class="sb-head"><b>ctrl</b><span class="sb-icons">
      <button class="ic" data-a="settings" title="Settings (⌘,)">${ICON.gear}</button>
      <button class="ic" data-a="palette" title="Search (⌘P)">${ICON.search}</button>
      <button class="ic ${S.main === 'board' ? 'on' : ''}" data-a="board" title="Board">${ICON.board}</button>
    </span></div>
    <button class="sb-new" data-a="new">${ic('edit')}New chat<kbd>⌘N</kbd></button>
    <div class="sb-scroll" data-scroll="sb">
      <div class="sb-label">Spaces <button class="ic" data-a="add-space" title="New space">${ICON.plus}</button></div>
      ${spaces}
      <div class="sb-label" data-a="recents">Recents <span class="ic chev ${S.recents ? 'down' : ''}">${ICON.chev}</span></div>
      ${recents}
      <div class="sb-label" data-a="archived">Archived · ${S.archived.length} <span class="ic chev ${S.archivedOpen ? 'down' : ''}">${ICON.chev}</span></div>
      ${archived}
    </div>
    <div class="sb-resize" data-resize title="Drag to resize, double-click to reset"></div>
  </aside>`
}

/* ---------- Render: views ---------- */

function linkify(t) {
  return esc(t)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a class="url" data-a="url">$1</a>')
    .replace(/(@?session\[[^\]]+\]\([^)]*\))/g, '<span class="mention">$1</span>')
}

function line([k, t, opts]) {
  if (k === 'q') {
    return `<div class="l q"><b>Question</b><div>${esc(t)}</div><div class="opts">${opts
      .map((o, i) => `<button data-a="answer" data-v="${esc(o)}"><span>${i + 1}</span>${esc(o)}</button>`)
      .join('')}</div></div>`
  }
  return `<div class="l ${k}">${k === 'meta' ? esc(t).replace(/^(\w+)/, '<b>$1</b>') : linkify(t)}</div>`
}

function term() {
  const x = cur()
  if (!x) return `<div class="view empty"><p>No session open</p><button data-a="new">New chat</button></div>`
  const tx = S.tx[x.id] || []
  const fx = x.harness === 'fx'
  return `<div class="view term ${fx ? 'fx' : ''}" data-drop="term">
    ${S.switchMs && S.feature === 'switch' ? `<span class="ms">⚡ switched in ${S.switchMs} ms</span>` : ''}
    <div class="tx" data-scroll="tx">${tx.length ? tx.map(line).join('') : `<div class="home"><b>${fx ? 'fx' : 'opencode'}</b><span>${esc(spaceOf(x).folder)}</span></div>`}
      ${x.status === 'running' ? '<div class="l run"><span class="spin"></span> Working…</div>' : ''}
      ${x.status === 'bg' ? '<div class="l run"><span class="pulse">' + ICON.shell + '</span> 1 shell running in the background</div>' : ''}
    </div>
    <div class="prompt">
      <textarea class="pin" rows="1" data-input="prompt" spellcheck="false" placeholder="${fx ? 'Message fx…' : 'Ask anything… “Fix the failing test”'}">${esc(S.prompt[x.id] || '')}</textarea>
      <div class="pmeta">${fx ? '<b>fx</b> · gpt-5.5 · high' : `<b>Build</b> · ${esc(S.model)} <span>OpenCode Zen</span>`}</div>
    </div>
    <div class="cwd"><span>${esc(spaceOf(x).folder)}</span><span>${fx ? '<b>esc</b> interrupt' : '<b>shift+tab</b> agents  <b>ctrl+p</b> commands'}</span></div>
  </div>`
}

function chat() {
  const x = cur()
  if (!x)
    return `<div class="view chat"><div class="chat-home"><h3>What do you want to work on?</h3>${composer(null)}</div></div>`
  const tx = S.tx[x.id] || []
  const msgs = tx
    .map(([k, t, opts]) => {
      if (k === 'user') return `<div class="bubble">${linkify(t).replace(/@\[([^\]]+)\]/g, '<span class="chip-s">@$1</span>')}</div>`
      if (k === 'text') return t ? `<div class="md">${linkify(t)}</div>` : ''
      if (k === 'tool') return `<div class="toolc">${ic('check')}<code>${esc(t.replace(/^\$ /, 'shell · '))}</code></div>`
      if (k === 'error') return `<div class="toolc err">✕ <code>${esc(t)}</code></div>`
      if (k === 'q') return line([k, t, opts])
      return ''
    })
    .join('')
  return `<div class="view chat" data-drop="term">
    <div class="msgs" data-scroll="tx">${msgs || '<div class="chat-home"><h3>What do you want to work on?</h3></div>'}
      ${S.stream?.id === x.id ? '<span class="typing"><i></i><i></i><i></i></span>' : ''}</div>
    ${composer(x)}
  </div>`
}

function composer(x) {
  const id = x?.id || 'home'
  const busy = S.stream && S.stream.id === id
  const steer = S.steer.map((m) => `<div class="steer">${esc(m)}<span>Steers the agent at its next step</span></div>`).join('')
  const work = x ? S.work2 : []
  const shells = work.filter((w) => w.kind === 'shell')
  const subs = work.filter((w) => w.kind === 'sub')
  const draft = S.drafts[id] || ''
  const shown = esc(draft).replace(/\[Pasted \d+ lines\]/g, (m) => m)
  return `<div class="composer-wrap">
    ${steer}
    <div class="composer">
      <textarea data-input="composer" rows="1" placeholder="${busy ? 'Steer the agent…' : 'Message the agent…'}">${shown}</textarea>
      <button class="send ${busy && !draft ? 'stop' : ''}" data-a="${busy && !draft ? 'stop' : 'send'}" title="${busy && !draft ? 'Stop (Esc)' : 'Send (↩)'}">${busy && !draft ? ICON.stop : ICON.up}</button>
    </div>
    <div class="cfoot">
      <span>$0.42 · 31% of 400k</span>
      ${subs.length ? `<button class="wk" data-a="work" data-v="sub">${ic('sub')}${subs.length} subagent</button>` : ''}
      ${shells.length ? `<button class="wk" data-a="work" data-v="shell">${ic('shell')}${shells.length} shell</button>` : ''}
      <span class="grow"></span>
      <button class="mp" data-a="picker">${esc(S.model)} <span>max</span> ▴</button>
      ${S.work ? workList(S.work) : ''}
      ${S.picker ? picker() : ''}
    </div>
  </div>`
}

function workList(kind) {
  const items = S.work2.filter((w) => w.kind === kind)
  return `<div class="pop work-pop">${items
    .map((w, i) => `<div class="pop-row">${ic(kind)}<span class="t">${esc(w.label)}</span><span class="age">${w.ago}</span><button class="ic" data-a="kill" data-v="${esc(w.label)}" title="${kind === 'shell' ? 'Kill' : 'Stop'}">${ICON.x}</button></div>`)
    .join('') || '<div class="pop-row dim">Nothing running</div>'}</div>`
}

function picker() {
  const q = S.pickerQ.toLowerCase()
  return `<div class="pop picker"><input data-input="picker" placeholder="Search models" value="${esc(S.pickerQ)}">${MODELS.filter((m) => m.toLowerCase().includes(q))
    .map((m) => `<button class="pop-row ${m === S.model ? 'on' : ''}" data-a="model" data-v="${esc(m)}"><span class="t">${esc(m)}</span>${m === S.model ? ic('check') : ''}</button>`)
    .join('')}</div>`
}

function cli() {
  const c = S.cli
  const next = CLI[c.step]
  return `<div class="view term cli">
    <div class="tx" data-scroll="tx">
      <div class="l user">Fix the two flaky tests in parallel, each in its own session, then tell me when both are in.</div>
      ${c.lines
        .map(([k, t]) =>
          k === 'p'
            ? `<div class="l cmd"><span class="pr">$</span> ${esc(t)}${c.busy && t.length && !c.lines.some((l) => l[0] === 'wait') ? '<span class="caret"></span>' : ''}</div>`
            : k === 'wait'
              ? `<div class="l run"><span class="spin"></span> ${esc(t)}</div>`
              : `<div class="l out">${esc(t)}</div>`,
        )
        .join('')}
    </div>
    <div class="cli-next">
      ${next ? `<code><span class="pr">$</span> ${esc(next.cmd)}</code>` : '<code class="dim">All done 🌊</code>'}
      <button class="run" data-a="cli" ${c.busy ? 'disabled' : ''}>${next ? (c.step ? '▶ Run next' : '▶ Run') : '↺ Again'}</button>
    </div>
  </div>`
}

function install() {
  const ins = S.install
  return `<div class="view term cli install">
    <div class="tx">
      ${ins.lines
        .map(([k, t]) =>
          k === 'bar'
            ? `<div class="l out bar"><span style="width:${t || 0}%"></span><em>${t || 0}%</em></div>`
            : `<div class="l ${k === 'p' ? 'cmd' : k === 'ok' ? 'okl' : 'out'}">${k === 'p' ? `<span class="pr">$</span> ${esc(t.slice(2))}` : esc(t)}</div>`,
        )
        .join('')}
      ${ins.lines.length ? '' : '<div class="l out dim">A fresh Mac. Nothing installed yet.</div>'}
    </div>
    <div class="cli-next"><code><span class="pr">$</span> curl -fsSL https://ctrl.lucleray.me/install.sh | sh</code>
      <button class="run" data-a="install" ${ins.busy ? 'disabled' : ''}>${ins.lines.length && !ins.busy ? '↺ Again' : '▶ Run'}</button></div>
  </div>`
}

function board() {
  const types = ['GitHub', 'Slack', 'Vercel', 'Linear']
  const shown = CARDS.filter((c) => !S.board.hidden.includes(c.type))
  return `<div class="view board">
    <div class="bhead"><b>Board</b><span class="chips">${types
      .map((t) => {
        const n = CARDS.filter((c) => c.type === t && c.col < 3).length
        return `<button class="fchip ${S.board.hidden.includes(t) ? 'off' : ''}" data-a="bfilter" data-v="${t}">${t} <span>${n}</span></button>`
      })
      .join('')}</span><span class="hint-sm">click: only · ⌘-click: toggle · ⌥-click: all but</span></div>
    <div class="cols">${COLS.map(
      (name, i) => `<div class="col ${i === 3 ? 'done' : ''}"><div class="col-h">${name} <span>${shown.filter((c) => c.col === i).length}</span></div>
        ${shown
          .filter((c) => c.col === i)
          .map(
            (c) => `<div class="card"><div class="card-t">${ic(c.icon)}<span>${esc(c.title)}</span></div><div class="card-s">${esc(c.sub)}</div>
              <div class="card-f"><span class="chip ${c.tone}">${esc(c.why)}</span>${c.s
                .map((id) => byId(id))
                .filter(Boolean)
                .map((x) => `<button class="schip" data-a="open" data-id="${x.id}">${ic('session')}${esc(x.title.split(' ').slice(0, 2).join(' '))}…</button>`)
                .join('')}</div></div>`,
          )
          .join('')}</div>`,
    ).join('')}</div>
  </div>`
}

function view() {
  if (S.main === 'chat') return chat()
  if (S.main === 'cli') return cli()
  if (S.main === 'board') return board()
  if (S.main === 'install') return install()
  return term()
}

/* ---------- Render: resources panel ---------- */

function panelItems() {
  const x = cur()
  if (!x) return []
  const ids = S.resTab === 'space' ? S.sessions.filter((k) => k.space === x.space).map((k) => k.id) : [x.id]
  const seen = new Set()
  const out = []
  for (const id of ids)
    for (const r of S.res[id] || []) {
      if (seen.has(r.sub) || S.resArchived.some((a) => a.sub === r.sub)) continue
      seen.add(r.sub)
      out.push(r)
    }
  return out
}

function chip([label, tone]) {
  return `<span class="chip ${tone}">${tone === 'pending' ? '<i></i>' : tone === 'ok' ? '✓ ' : ''}${esc(label)}</span>`
}

function panel() {
  if (!cur()) return ''
  const items = panelItems()
  if (S.panel === 'fold') return `<button class="rp-pill" data-a="panel-fold" title="Unfold">Resources <span>${items.length}</span></button>`
  const groups = RES_GROUPS.map(([type, label]) => {
    const list = items.filter((r) => r.type === type)
    if (!list.length) return ''
    return `<div class="rp-g">${label}<span>${list.length}</span></div>${list
      .map(
        (r) => `<div class="rp-row" draggable="true" data-res="${esc(r.sub)}">${ic(type)}<div class="rp-t"><span>${esc(r.title)}</span><small>${esc(r.sub)} ${r.chips.map(chip).join('')}</small></div>
        <button class="ic arch" data-a="res-archive" data-v="${esc(r.sub)}" title="Archive">${ICON.archive}</button></div>`,
      )
      .join('')}`
  }).join('')
  const arch = S.resArchived.length
    ? `<div class="rp-g arch-h">Archived<span>${S.resArchived.length}</span></div>${S.resArchived
        .map((r) => `<div class="rp-row dim">${ic(r.type)}<div class="rp-t"><span>${esc(r.title)}</span></div><button class="unarch" data-a="res-unarchive" data-v="${esc(r.sub)}">Unarchive</button></div>`)
        .join('')}`
    : ''
  return `<div class="rp ${S.panel}">
    <div class="rp-head"><b data-a="panel-fold" title="Fold">Resources</b><button class="ic" data-a="panel-dock" title="${S.panel === 'dock' ? 'Float' : 'Dock'}">${ICON.dock}</button><button class="ic" data-a="panel-close" title="Close (⇧⌘R)">${ICON.x}</button></div>
    <div class="seg"><button data-a="res-tab" data-v="session" class="${S.resTab === 'session' ? 'on' : ''}">This session</button><button data-a="res-tab" data-v="space" class="${S.resTab === 'space' ? 'on' : ''}">This space</button></div>
    <div class="rp-list">${groups || '<div class="rp-empty">No links yet</div>'}${arch}</div>
  </div>`
}

/* ---------- Render: overlays ---------- */

function palette() {
  const q = S.palette.trim().toLowerCase()
  const chats = S.sessions.filter((x) => !q || x.title.toLowerCase().includes(q) || spaceOf(x).name.toLowerCase().includes(q)).slice(0, 5)
  const msgs = []
  if (q.length > 1)
    for (const x of S.sessions)
      for (const [k, t] of S.tx[x.id] || []) {
        if (typeof t !== 'string') continue
        const i = t.toLowerCase().indexOf(q)
        if (i < 0 || k === 'meta') continue
        const a = Math.max(0, i - 28)
        const snip = (a ? '…' : '') + t.slice(a, i) + '\u0000' + t.slice(i, i + q.length) + '\u0001' + t.slice(i + q.length, i + q.length + 40) + '…'
        msgs.push({ x, snip })
        if (msgs.length > 4) break
      }
  const items = [...chats.map((x) => ({ x })), ...msgs]
  S.paletteSel = Math.min(S.paletteSel, Math.max(0, items.length - 1))
  let n = -1
  const rowHtml = (it) => {
    n++
    const snip = it.snip ? `<small>${esc(it.snip).replace('\u0000', '<mark>').replace('\u0001', '</mark>')}</small>` : `<small>${esc(spaceOf(it.x).name)}</small>`
    return `<button class="pal-row ${n === S.paletteSel ? 'on' : ''}" data-a="open" data-id="${it.x.id}">${ic(it.snip ? 'search' : 'session')}<span class="t"><span>${esc(it.x.title)}</span>${snip}</span>${status(it.x)}</button>`
  }
  return `<div class="ov top" data-a="close-ov"><div class="pal">
    <div class="pal-in">${ic('search')}<input data-input="palette" placeholder="Search chats and messages" value="${esc(S.palette)}" spellcheck="false"><kbd>esc</kbd></div>
    <div class="pal-res">${chats.length ? `<div class="pal-g">Chats</div>${chats.map((x) => rowHtml({ x })).join('')}` : ''}
      ${msgs.length ? `<div class="pal-g">Messages</div>${msgs.map(rowHtml).join('')}` : ''}
      ${items.length ? '' : '<div class="pal-empty">Nothing matches</div>'}</div>
  </div></div>`
}

function seg(key, opts, val) {
  return `<span class="segc">${opts.map((o) => `<button class="${o === val ? 'on' : ''}" data-a="set" data-k="${key}" data-v="${o}">${o}</button>`).join('')}</span>`
}
const toggle = (key, on) => `<button class="tog ${on ? 'on' : ''}" data-a="toggle" data-k="${key}" role="switch" aria-checked="${on}"><i></i></button>`

const TOOL_ROWS = [
  ['gh', 'gh', 'GitHub CLI · logged in'],
  ['vercel', 'vercel', 'Vercel CLI · logged in'],
  ['aws', 'AWS SSO · vercel', 'aws sso login'],
  ['pup', 'pup', 'Datadog CLI'],
  ['linear', 'linear', 'MCP · opencode, fx'],
  ['notion', 'notion', 'MCP · opencode'],
]

function settingsRows() {
  const t = S.tools
  return {
    Appearance: [
      ['Theme', seg('theme', ['system', 'light', 'dark'], S.theme)],
      [
        'opencode TUI theme',
        `<select data-change="tuiTheme">${['opencode', 'tokyonight', 'catppuccin', 'gruvbox'].map((o) => `<option ${o === S.tuiTheme ? 'selected' : ''}>${o}</option>`).join('')}</select>`,
      ],
      ['Terminal text size', `<span class="step"><button data-a="size" data-v="-1">−</button><b>${S.fontSize}</b><button data-a="size" data-v="1">+</button></span>`],
    ],
    Sessions: [
      ['Harness for new sessions', seg('harness', ['opencode', 'fx'], S.spaces[0].harness)],
      ['Default folder', '<code>~/code</code>'],
      ['Default model', `<code>${esc(S.model)}</code>`],
    ],
    Notifications: [
      ['Dock badge', toggle('badge', true)],
      ['Notify when a session needs you', toggle('notify', true)],
      ...Object.entries(S.sounds).map(([ev, v]) => [
        `Sound when it ${ev === 'needs you' ? 'needs you' : ev}`,
        `<span class="sound"><select data-change="sound:${ev}">${Object.keys(SOUNDS).map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select><button class="play" data-a="play" data-k="${ev}" title="Preview">▶</button></span>`,
      ]),
    ],
    Shortcuts: S.shortcuts.map(([label, keys], i) => [
      label,
      `<button class="bind ${S.rebinding === i ? 'wait' : ''}" data-a="rebind" data-v="${i}">${S.rebinding === i ? 'Press keys…' : esc(keys)}</button>`,
    ]),
    Agents: [
      ['read-session skill', S.skills.read ? `<span class="okt">✓ Installed</span><button class="btn" data-a="skill" data-k="read">Uninstall</button>` : `<button class="btn pri" data-a="skill" data-k="read">Install</button>`],
      ['ctrl command line + skill', S.skills.ctrl ? `<span class="okt">✓ Installed</span><button class="btn" data-a="skill" data-k="ctrl">Uninstall</button>` : `<button class="btn pri" data-a="skill" data-k="ctrl">Install</button>`],
      ['ctrl instructions', `${toggle('instr', S.instr)}<button class="btn" data-a="show-instr">${S.showInstr ? 'Hide text' : 'Show text'}</button>`],
    ],
    Tools: TOOL_ROWS.map(([k, label, sub]) => [
      `${label}<small>${sub}</small>`,
      t[k] === 'ok'
        ? '<span class="okt">● Working</span>'
        : t[k] === 'fixing'
          ? '<span class="pend">● Checking…</span>'
          : `<span class="bad">● ${k === 'notion' ? 'Needs sign-in' : 'Session expired'}</span><button class="btn pri" data-a="fix-tool" data-k="${k}">Fix</button>`,
    ]),
    Worktrees: [
      ['Size pools from usage', toggle('pools', true)],
      ['Clean up<small>released 2 worktrees · 12m ago</small>', `${toggle('clean', true)}<button class="btn" data-a="noop-toast" data-v="Cleaned up: nothing to release">Run now</button>`],
      ['Keep your checkouts up to date', toggle('pull', false)],
      [
        'Repositories',
        `<table class="wt"><tr><th></th><th>pool</th><th>warm</th><th>in use</th><th>instant</th></tr>
          <tr><td>next.js</td><td>auto · 2</td><td>2</td><td>3</td><td>97%</td></tr>
          <tr><td>ctrl</td><td>auto · 1</td><td>1</td><td>1</td><td>100%</td></tr>
          <tr><td>ai</td><td>auto · 1</td><td><span class="spin"></span></td><td>0</td><td>92%</td></tr></table>`,
      ],
    ],
    About: [
      ['Version', '<code>0.45.0</code>'],
      [
        'Updates',
        S.update === 'idle'
          ? '<button class="btn" data-a="update">Check for updates</button>'
          : S.update === 'checking'
            ? '<span class="pend"><span class="spin"></span> Checking…</span>'
            : S.update === 'found'
              ? '<span>0.46.0 is out</span><button class="btn pri" data-a="update">Update and restart</button>'
              : '<span class="okt">✓ You’re on 0.46.0</span>',
      ],
      ['Welcome screen', '<button class="btn" data-a="welcome">Show</button>'],
    ],
  }
}

function settings() {
  const all = settingsRows()
  const q = S.settingsQuery.trim().toLowerCase()
  const plain = (s) => s.replace(/<[^>]+>/g, ' ').toLowerCase()
  const match = (label) => !q || plain(label).includes(q)
  const sections = Object.keys(all)
  const hasMatch = (sec) => all[sec].some(([l]) => match(l)) || sec.toLowerCase().includes(q)
  const hl = (label) => (q ? label.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![^<]*>)`, 'i'), '<mark>$1</mark>') : label)
  const rowsOf = (sec) =>
    all[sec]
      .filter(([l]) => match(l) || sec.toLowerCase().includes(q))
      .map(([l, c]) => `<div class="srow"><span class="sl">${hl(l)}</span><span class="sc">${c}</span></div>`)
      .join('')
  const body = q
    ? sections.filter(hasMatch).map((sec) => `<div class="ssec-h" data-a="settings-sec" data-v="${sec}">${sec}</div>${rowsOf(sec)}`).join('') || '<div class="pal-empty">No settings match</div>'
    : `<h4>${S.settings}</h4>${rowsOf(S.settings)}${
        S.settings === 'Agents' && S.showInstr
          ? '<pre class="instr">You are running inside ctrl, an app that groups coding-agent sessions into spaces.\n`ctrl session get self`: this session\n`ctrl space get self`: the space it’s in\n`ctrl worktree up &lt;repo&gt;`: a ready git worktree\n…</pre>'
          : ''
      }`
  const red = (sec) => (sec === 'Tools' && Object.values(S.tools).some((v) => v !== 'ok')) || (sec === 'About' && S.update === 'found')
  return `<div class="ov" data-a="close-ov"><div class="set">
    <div class="set-nav">
      <div class="set-search">${ic('search')}<input data-input="settings" placeholder="Search settings" value="${esc(S.settingsQuery)}"></div>
      ${sections
        .map(
          (sec) =>
            `<button class="${!q && sec === S.settings ? 'on' : ''} ${q && !hasMatch(sec) ? 'dim' : ''}" data-a="settings-sec" data-v="${sec}">${sec}${red(sec) ? '<i class="rdot"></i>' : ''}</button>`,
        )
        .join('')}
    </div>
    <div class="set-body" data-scroll="set">${body}</div>
    <button class="ic set-x" data-a="close" title="Close (esc)">${ICON.x}</button>
  </div></div>`
}

function spaceSettings() {
  const sp = S.spaces.find((s) => s.id === S.space) || S.spaces[0]
  return `<div class="ov" data-a="close-ov"><div class="modal">
    <h4>${ic('folder')} ${esc(sp.name)} <small>for new sessions in this space</small></h4>
    <label>Folder<input data-input="sp-folder" value="${esc(sp.folder)}"></label>
    <label>Harness ${seg('sp-harness', ['opencode', 'fx'], sp.harness)}</label>
    <label>Model<select data-change="sp-model">${['Big Pickle', 'Claude Opus 5.5', 'GPT-5.5 · high', 'gpt-5.5 · high', 'Gemini 3 Pro']
      .map((m) => `<option ${m === sp.model ? 'selected' : ''}>${m}</option>`)
      .join('')}</select></label>
    <label class="col">Instructions<textarea data-input="sp-instr" rows="3" placeholder="Attached to every session in this space, invisibly">${esc(sp.instr)}</textarea></label>
    <div class="modal-f"><button class="btn" data-a="close">Cancel</button><button class="btn pri" data-a="space-save">Save</button></div>
  </div></div>`
}

function welcome() {
  const w = S.welcome
  if (w.step === 1)
    return `<div class="ov"><div class="modal welcome">
      <h4>Watch your tools</h4><p class="dim">ctrl found these and checks them every few minutes:</p>
      <div class="found">${['gh · logged in', 'vercel · logged in', 'AWS SSO · vercel', 'linear MCP', 'notion MCP', 'pup']
        .map((t) => `<div>${ic('check')}${t}</div>`)
        .join('')}</div>
      <div class="modal-f"><button class="btn" data-a="welcome-done">Skip</button><button class="btn pri" data-a="welcome-done">Watch these</button></div></div></div>`
  const card = (h, v) =>
    `<button class="hcard ${w.harness === h ? 'on' : ''}" data-a="set" data-k="welcome" data-v="${h}"><b>${h}</b><span>${ic('check')} installed · ${v}</span></button>`
  return `<div class="ov"><div class="modal welcome">
    <img src="/icon.png" width="44" height="44" alt=""><h4>Welcome to ctrl</h4>
    <p class="dim">Both harnesses are installed. Pick the one new sessions start with:</p>
    <div class="hcards">${card('opencode', '2.0.31')}${card('fx', '0.0.19')}</div>
    <div class="modal-f"><button class="btn pri" data-a="welcome-next">Start with ${w.harness}</button></div></div></div>`
}

function phone() {
  const p = S.phone
  let screen
  if (p.screen === 'list') {
    screen = `<div class="ph-top"><b>ctrl</b><i class="cdot"></i><span class="grow"></span><span class="ph-tab on">Sessions</span><span class="ph-tab">Board</span></div>
      <div class="ph-search">${ic('search')} Search</div>
      ${S.spaces
        .map(
          (sp) => `<div class="ph-sp">${ic('folder')}${esc(sp.name)}</div>${S.sessions
            .filter((x) => x.space === sp.id && !x.parent)
            .map((x) => `<button class="ph-row" data-a="phone-open" data-id="${x.id}"><span class="t">${esc(x.title)}</span>${x.harness === 'fx' ? '<span class="tag">fx</span>' : ''}${status(x)}</button>`)
            .join('')}`,
        )
        .join('')}`
  } else {
    const x = byId(p.session)
    const tx = S.tx[x.id] || []
    const msgs = tx
      .filter(([k]) => k !== 'meta' && k !== 'q')
      .map(([k, t]) => (k === 'user' ? `<div class="bubble">${esc(t)}</div>` : k === 'tool' ? `<div class="toolc">${ic('check')}<code>${esc(t.replace(/^\$ /, ''))}</code></div>` : t ? `<div class="md">${esc(t)}</div>` : ''))
      .join('')
    const qs = [
      ['Revert it in both packages, or only in @ai-sdk/heygen?', ['Both packages', 'Only @ai-sdk/heygen']],
      ['Open a PR when it’s done?', ['Yes, as a draft', 'No, just commit']],
    ]
    let ask = ''
    if (x.id === 's8' && x.status === 'input') {
      if (p.q < qs.length) {
        const [q, opts] = qs[p.q]
        ask = `<div class="ph-q"><small>${p.q + 1} of ${qs.length}</small><b>${esc(q)}</b>${opts.map((o) => `<button data-a="phone-answer" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`
      } else {
        ask = `<div class="ph-q"><small>Review</small>${p.answers.map((a, i) => `<div class="rv"><span>${i + 1}.</span>${esc(a)}</div>`).join('')}<button class="pri" data-a="phone-submit">Submit</button></div>`
      }
    } else if (p.perm === 'ask' && x.id !== 's8') {
      ask = `<div class="ph-q"><small>Permission</small><b>Run <code>pnpm test-dev test/e2e/gtm</code>?</b><div class="ph-perm"><button class="pri" data-a="phone-perm" data-v="allow">Allow</button><button data-a="phone-perm" data-v="always">Always</button><button data-a="phone-perm" data-v="deny">Deny</button></div></div>`
    }
    screen = `<div class="ph-top"><button class="ph-back" data-a="phone-back">‹</button><b class="t">${esc(x.title)}</b></div>
      <div class="ph-msgs" data-scroll="ph">${msgs}${x.status === 'running' ? '<span class="typing"><i></i><i></i><i></i></span>' : ''}${ask}</div>
      <div class="ph-comp"><input data-input="phone" placeholder="Message"><button data-a="phone-send">${ICON.up}</button></div>`
  }
  return `<div class="ov dimmed"><div class="phone-wrap"><div class="qr"><div class="qr-code"></div><span>Scan to open your sessions on your phone, over Tailscale</span></div>
    <div class="phone"><div class="notch"></div><div class="ph-screen">${screen}</div></div></div></div>`
}

function companion() {
  const rows = ['s1', 's4'].map(byId).filter(Boolean)
  return `<div class="ov browser-ov">
    <div class="browser">
      <div class="b-bar"><i></i><i></i><i></i><span class="b-url">github.com/vercel/next.js/pull/99932</span></div>
      <div class="b-page"><h3>Allow loopback IPs by default in dev origin check <span>#99932</span></h3>
        <p><span class="chip">Draft</span> wants to merge 3 commits into <code>canary</code></p>
        <div class="b-line"></div><div class="b-line s"></div><div class="b-line"></div><div class="b-line m"></div><div class="b-line s"></div></div>
    </div>
    <div class="comp" style="left:${S.comp.x}px;top:${S.comp.y}px">
      <div class="comp-h" data-drag="comp"><b>ctrl</b><span class="grow"></span><span class="dim">⋯</span></div>
      <div class="comp-now"><span class="t"><small>Chrome</small>vercel/next.js#99932</span><button class="btn pri" data-a="comp-new" title="⌃⌥⌘Space">New</button></div>
      <div class="comp-l">Spaces</div>
      <div class="comp-sp">${ic('folder')} next.js</div>
      ${rows
        .map(
          (x, i) =>
            `<button class="comp-row" data-a="open" data-id="${x.id}"><span class="t">${esc(x.title)}</span>${S.badges ? `<span class="kbd">⌃${i + 1}</span>` : status(x)}</button>`,
        )
        .join('')}
    </div>
  </div>`
}

function overlay() {
  switch (S.overlay) {
    case 'palette':
      return palette()
    case 'settings':
      return settings()
    case 'space':
      return spaceSettings()
    case 'welcome':
      return welcome()
    case 'phone':
      return phone()
    case 'companion':
      return companion()
    default:
      return ''
  }
}

function app() {
  jumpN = 0
  visible = []
  const dark = S.theme === 'dark' || (S.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  const showPanel = (S.main === 'term' || S.main === 'chat' || S.main === 'cli') && S.panel !== 'none'
  return `<div class="app ${dark ? 'dark' : ''} tui-${S.tuiTheme}" style="--sbw:${S.sbw}px;--fs:${S.fontSize}px">
    ${sidebar()}
    <div class="main ${showPanel ? 'p-' + S.panel : ''}">${view()}${showPanel ? panel() : ''}</div>
    ${overlay()}
    ${
      S.banner
        ? `<button class="banner" data-a="banner"><img src="/icon.png" alt="" width="30" height="30"><span><b>${esc(S.banner.title)}</b><small>${esc(S.banner.body)}</small></span><em>now</em></button>`
        : ''
    }
    ${
      S.toast
        ? `<div class="toast">${esc(S.toast.msg)}${S.toast.action ? `<button data-a="${S.toast.act}">${esc(S.toast.action)}${S.toast.kbd ? ` <kbd>${S.toast.kbd}</kbd>` : ''}</button>` : ''}<button class="ic" data-a="toast-x">${ICON.x}</button></div>`
        : ''
    }
  </div>`
}

function render() {
  const ae = document.activeElement
  const key = ae && mock.contains(ae) ? ae.dataset.input : null
  const sel = key && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null
  const scrolls = {}
  for (const el of mock.querySelectorAll('[data-scroll]')) scrolls[el.dataset.scroll] = [el.scrollTop, el.scrollHeight - el.clientHeight - el.scrollTop < 8]
  mock.innerHTML = app()
  for (const el of mock.querySelectorAll('[data-scroll]')) {
    const prev = scrolls[el.dataset.scroll]
    if (['tx', 'ph'].includes(el.dataset.scroll) && (!prev || prev[1])) el.scrollTop = el.scrollHeight
    else if (prev) el.scrollTop = prev[0]
  }
  const restore = (el, range) => {
    el.focus({ preventScroll: true })
    if (range && el.setSelectionRange) el.setSelectionRange(...range)
  }
  if (S.focus) {
    const el = mock.querySelector(S.focus)
    if (el) restore(el, [el.value.length, el.value.length])
    S.focus = null
  } else if (key) {
    const el = mock.querySelector(`[data-input="${key}"]`)
    if (el) restore(el, sel)
  }
  if (S.hl) for (const el of mock.querySelectorAll(S.hl)) el.classList.add('hl')
  dockEl.innerHTML = S.dock ? `<img src="/icon.png" alt="" width="16" height="16"><b>${S.dock}</b>` : ''
}

/* ---------- Features ---------- */

const chatMode = (s) => {
  s.mode = 'chat'
  s.main = 'chat'
  s.panel = 'fold'
}

const FEATURES = [
  ['Stay on top'],
  { id: 'spaces', label: 'Spaces for every project', hint: 'Fold a space, or hover one and open its <b>⋯</b> settings.', hl: '.sp' },
  {
    id: 'status',
    label: 'Status dots at a glance',
    hint: '<span class="dot blue"></span> finished · <span class="dot red"></span> failed · <span class="dot amber"></span> waiting on you. Watch “Website v2” run.',
    setup: (s) => {
      byId('s6').status = 'running'
    },
    start: () => later(3000, () => (byId('s6').status = 'done')),
  },
  { id: 'input', label: 'See who’s waiting on you', hint: 'Open the amber session and answer its question.', hl: '[data-session="s8"]' },
  {
    id: 'notify',
    label: 'Notifications & dock badge',
    hint: 'A session finishes while you look elsewhere: macOS pings you. Click the banner.',
    setup: (s) => {
      byId('s6').status = 'running'
      s.dock = 1
    },
    start: () =>
      later(1800, () => {
        byId('s6').status = 'done'
        S.dock = 2
        S.banner = { title: 'Website v2', body: 'Finished · ctrl', id: 's6' }
        if (audio) play(S.sounds.finished)
      }),
  },
  {
    id: 'sounds',
    label: 'A sound for each event',
    hint: 'Pick a sound and press ▶. Your own audio file works too.',
    setup: (s) => {
      s.overlay = 'settings'
      s.settings = 'Notifications'
    },
  },
  {
    id: 'bg',
    label: 'Background shells & subagents',
    hint: 'The pulsing icon: the turn is over, but a shell or subagent still runs. Open it.',
    hl: '[data-session="s5"] .pulse',
  },
  { id: 'children', label: 'Child sessions, nested', hint: 'Fold “Review #99933”, or drop a session onto another to nest it.', hl: '[data-session="s4"] .chev' },
  { id: 'agentmade', label: 'Spot sessions agents started', hint: 'Hover the bot icon to see which session made it.', hl: '.row .bot' },
  { id: 'move', label: 'Drag sessions between spaces', hint: 'Drag a session onto another space’s folder.', hl: '.sp' },
  { id: 'archive', label: 'Archive, with undo', hint: 'Hover a session and archive it (or <kbd>⌘W</kbd>), then <kbd>⌘Z</kbd>.' },
  {
    id: 'recents',
    label: 'Recents & Archived',
    hint: 'Every session, newest first, plus the archived ones a click away.',
    setup: (s) => {
      s.recents = true
      s.archivedOpen = true
      s.folded = { next: true, ai: true }
    },
  },
  {
    id: 'spacesettings',
    label: 'Per-space folder, model & prompt',
    hint: 'Set where new sessions start, which harness and model, and instructions they all get.',
    setup: (s) => {
      s.overlay = 'space'
      s.space = 'next'
    },
  },

  ['Move fast'],
  { id: 'switch', label: 'Instant switching', hint: 'Click around the sidebar: the terminal never restarts.' },
  { id: 'jump', label: 'Jump with ⌘1–9', hint: 'Hold <kbd>⌘</kbd> over the window (or <button class="hold" data-hold>hold here</button>), then press a number.' },
  {
    id: 'search',
    label: 'Search every message',
    hint: 'Try “loopback”, “flaky” or “gtm”. <kbd>⌘P</kbd> opens it anytime.',
    setup: (s) => {
      s.overlay = 'palette'
      s.focus = '[data-input="palette"]'
    },
  },
  { id: 'new', label: '⌘N new chat, ⌘T new session here', hint: 'Press <kbd>⌘N</kbd> or click New chat, then type a first message.', hl: '.sb-new' },
  { id: 'harness', label: 'fx and opencode, side by side', hint: 'Open the fx session, then an opencode one. Same sidebar, same space.', hl: '.tag' },
  {
    id: 'keys',
    label: 'Terminal keys that just work',
    hint: '<kbd>⇧↩</kbd> adds a line, <kbd>↩</kbd> sends. Try it in the prompt.',
    setup: (s) => (s.focus = '[data-input="prompt"]'),
  },
  { id: 'files', label: 'Drop files, paste their path', hint: 'Drop any file from your desktop onto the terminal.' },
  { id: 'links', label: '⌘-click wrapped links', hint: '⌘-click the long preview URL, even where it wraps.', hl: '.url' },

  ['Share context'],
  { id: 'reference', label: 'Hand one session to another', hint: 'Drag a session from the sidebar onto the terminal, then send.', hl: '[data-session="s2"]' },
  { id: 'resources', label: 'Every link in one place', hint: 'PRs, issues, Linear, Slack, deploys. Switch to <b>This space</b>.', hl: '.rp .seg' },
  {
    id: 'live',
    label: 'Live PR, CI & deploy status',
    hint: 'Watch CI and the preview deploy update on their own.',
    start: () => {
      later(2200, () => (S.res.s1[0].chips = [['draft', ''], ['CI', 'ok']]))
      later(3600, () => (S.res.s1[4].chips = [['Ready', 'ok']]))
    },
  },
  { id: 'dockpanel', label: 'Dock or fold the links panel', hint: 'Click <b>Resources</b> to fold it, or the dock button to make it a column.', hl: '.rp-head' },
  { id: 'draglink', label: 'Drag a link into the prompt', hint: 'Drag a row from the panel onto the terminal.', hl: '.rp-row' },
  { id: 'archivelink', label: 'Archive links you’re done with', hint: 'Hover a link and archive it. It comes back if a session mentions it again.' },

  ['Let agents drive'],
  {
    id: 'cli',
    label: 'A ctrl CLI made for agents',
    hint: 'Run the agent’s commands: JSON in, JSON out.',
    setup: (s) => cliSetup(s, 0),
  },
  {
    id: 'fanout',
    label: 'Fan out work, wait for it',
    hint: 'The agent starts two child sessions and waits for both. Watch the sidebar.',
    setup: (s) => cliSetup(s, 1),
  },
  {
    id: 'worktree',
    label: 'Warm git worktrees on tap',
    hint: 'A ready checkout in milliseconds, from a pool ctrl keeps warm.',
    setup: (s) => cliSetup(s, 4),
  },
  {
    id: 'release',
    label: 'Worktrees freed on archive',
    hint: 'Archive this session: its worktree goes back to the pool.',
    setup: (s) => {
      s.res.s1 = [{ type: 'tree', title: 'next.js · luc/loopback', sub: '~/.ctrl/worktrees/next-js/b21c', chips: [['ready', 'ok']] }, ...s.res.s1]
    },
    hl: '[data-session="s1"] .arch',
  },
  {
    id: 'pools',
    label: 'Pools sized from your usage',
    hint: 'ctrl replays the last 7 days to pick each repo’s pool size.',
    setup: (s) => {
      s.overlay = 'settings'
      s.settings = 'Worktrees'
    },
  },
  {
    id: 'instructions',
    label: 'Agents know they’re in ctrl',
    hint: 'An invisible instruction tells them how to look around. Show its text.',
    setup: (s) => {
      s.overlay = 'settings'
      s.settings = 'Agents'
    },
  },
  {
    id: 'skills',
    label: 'read-session & ctrl skills',
    hint: 'One click installs the skills agents use to read sessions and drive ctrl.',
    setup: (s) => {
      s.overlay = 'settings'
      s.settings = 'Agents'
    },
  },

  ['Keep tools working'],
  {
    id: 'tools',
    label: 'Watches MCP servers & logins',
    hint: 'When a login expires, ctrl tells you, with a fix button.',
    setup: (s) => (s.tools.aws = 'broken'),
    start: () => later(900, () => toast('AWS SSO (vercel): session expired', { action: 'Fix', act: 'fix-aws', sticky: true })),
  },
  {
    id: 'toolsettings',
    label: 'One list of every tool',
    hint: 'gh, vercel, AWS SSO, MCP servers: checked every 10 minutes.',
    setup: (s) => {
      s.tools.notion = 'broken'
      s.overlay = 'settings'
      s.settings = 'Tools'
    },
  },

  ['Make it yours'],
  {
    id: 'settingsearch',
    label: 'Search every setting',
    hint: 'Try “sound”, “model” or “update”.',
    setup: (s) => {
      s.overlay = 'settings'
      s.focus = '[data-input="settings"]'
    },
  },
  {
    id: 'shortcuts',
    label: 'Rebind any shortcut',
    hint: 'Click a shortcut, then press the keys you want.',
    setup: (s) => {
      s.overlay = 'settings'
      s.settings = 'Shortcuts'
    },
  },
  {
    id: 'themes',
    label: 'Light, dark & TUI themes',
    hint: 'Switch the theme, then the opencode TUI theme.',
    setup: (s) => {
      s.overlay = 'settings'
      s.settings = 'Appearance'
    },
  },
  { id: 'resize', label: 'Resizable sidebar', hint: 'Drag the sidebar’s edge. Double-click it to reset.', hl: '.sb-resize' },
  { id: 'welcome', label: 'A welcome that sets you up', hint: 'Pick a harness, then the tools to watch.', setup: (s) => (s.overlay = 'welcome') },
  { id: 'install', label: 'One-line install', hint: 'One curl command. No Gatekeeper prompt.', setup: (s) => (s.main = 'install') },
  {
    id: 'updates',
    label: 'Updates itself',
    hint: 'Checked every 6 hours. Or check now.',
    setup: (s) => {
      s.overlay = 'settings'
      s.settings = 'About'
    },
  },

  ['Beta'],
  { id: 'chat', beta: true, label: 'Chat view', hint: 'Sessions as a chat instead of a terminal. Send a message.', setup: (s) => chatMode(s) },
  {
    id: 'steer',
    beta: true,
    label: 'Steer a turn mid-flight',
    hint: 'The agent is writing: send a message to change course.',
    setup: (s) => {
      chatMode(s)
      s.current = 's2'
      byId('s2').status = 'idle'
    },
    start: () => {
      byId('s2').status = 'running'
      stream('s2', 'Looking at the CI logs from the last 20 runs. The flake only shows up on the slowest runners, which points at the script load race again.')
    },
  },
  {
    id: 'footer',
    beta: true,
    label: 'Spend, context & model picker',
    hint: 'Open the model picker, or see what’s still running.',
    setup: (s) => {
      chatMode(s)
      s.current = 's4'
    },
    hl: '.cfoot',
  },
  {
    id: 'paste',
    beta: true,
    label: 'Long pastes fold into a token',
    hint: 'Paste 5+ lines into the composer, or <button class="hold" data-a="sample-paste">paste a sample</button>.',
    setup: (s) => {
      chatMode(s)
      s.focus = '[data-input="composer"]'
    },
  },
  {
    id: 'drafts',
    beta: true,
    label: 'Drafts stay with their session',
    hint: 'Type something, switch sessions, come back. The pencil marks a draft.',
    setup: (s) => {
      chatMode(s)
      s.drafts.s2 = 'Can you also check the Safari run?'
      s.focus = '[data-input="composer"]'
    },
  },
  {
    id: 'phone',
    beta: true,
    label: 'Your sessions on your phone',
    hint: 'Tap a session, answer its permission, send a message.',
    setup: (s) => (s.overlay = 'phone'),
  },
  {
    id: 'phoneq',
    beta: true,
    label: 'Answer agents from the couch',
    hint: 'The agent asks two questions. Answer them, review, submit.',
    setup: (s) => {
      s.overlay = 'phone'
      s.phone = { screen: 'chat', session: 's8', q: 0, answers: [], perm: 'ask' }
    },
  },
  { id: 'board', beta: true, label: 'Board: whose turn is it', hint: 'Every PR, deploy and thread, sorted by whose turn it is. Filter by type.', setup: (s) => (s.main = 'board') },
  {
    id: 'companion',
    beta: true,
    label: 'Companion for what’s on screen',
    hint: 'Looking at a PR? The companion lists the sessions that mentioned it. Drag it around.',
    setup: (s) => (s.overlay = 'companion'),
  },
  {
    id: 'ctrljump',
    beta: true,
    label: '⌃1–9 from any app',
    hint: 'Hold <kbd>⌃</kbd> over the window to number the rows, then press one.',
    setup: (s) => (s.overlay = 'companion'),
  },
]

function cliSetup(s, steps) {
  s.sessions.unshift({ id: 'sc', title: 'Fan out the flaky test fixes', space: 'next', status: 'idle', age: 'now', harness: 'opencode' })
  s.current = 'sc'
  s.main = 'cli'
  s.panel = 'none'
  s.folded = { ai: true, ctrl: true }
  // Replay the first steps instantly, so later features start mid-story.
  S = s
  for (let i = 0; i < steps; i++) {
    const step = CLI[i]
    s.cli.lines.push(['p', step.cmd], ['o', step.out])
    step.run?.()
    if (i === 3) s.sessions.filter((x) => x.id === 'c1' || x.id === 'c2').forEach((x) => (x.status = 'done'))
  }
  s.cli.step = steps
  s.toast = null
}

const items = FEATURES.filter((f) => !Array.isArray(f))
let feature

function select(id) {
  feature = items.find((f) => f.id === id) || items[0]
  clearTimers()
  S = base()
  S.feature = feature.id
  S.hl = feature.hl || null
  feature.setup?.(S)
  for (const b of listEl.querySelectorAll('[data-f]')) b.classList.toggle('on', b.dataset.f === feature.id)
  const btn = listEl.querySelector(`[data-f="${feature.id}"]`)
  if (btn) {
    const top = btn.offsetTop
    if (top < listEl.scrollTop || top > listEl.scrollTop + listEl.clientHeight - 40) listEl.scrollTo({ top: top - 80, behavior: 'smooth' })
  }
  capTitle.innerHTML = `${esc(feature.label)}${feature.beta ? '<span class="beta">beta</span>' : ''}`
  capHint.innerHTML = feature.hint
  render()
  feature.start?.()
}

listEl.innerHTML = FEATURES.map((f) =>
  Array.isArray(f)
    ? `<li class="fgroup">${f[0]}</li>`
    : `<li><button data-f="${f.id}">${esc(f.label)}${f.beta ? '<span class="beta">beta</span>' : ''}</button></li>`,
).join('')
root.querySelector('.demo-count b').textContent = items.length

/* ---------- Events ---------- */

function act(a, el, e) {
  const id = el.dataset.id
  const v = el.dataset.v
  const x = cur()
  switch (a) {
    case 'open':
      if (S.overlay === 'companion') S.overlay = null
      return open(id)
    case 'fold':
      e.stopPropagation()
      S.folded[id] = !S.folded[id]
      break
    case 'archive':
      e.stopPropagation()
      archive(id)
      break
    case 'unarchive':
      unarchive(id)
      break
    case 'undo':
      S.undo?.()
      S.undo = null
      S.toast = null
      break
    case 'toast-x':
      S.toast = null
      break
    case 'recents':
      S.recents = !S.recents
      break
    case 'archived':
      S.archivedOpen = !S.archivedOpen
      break
    case 'new':
      newSession(x?.space || 'next')
      break
    case 'add-space': {
      const n = S.spaces.length - 2
      S.spaces.unshift({ id: 'sp' + Date.now(), name: n > 1 ? `New space ${n}` : 'New space', folder: '~', harness: 'opencode', model: 'Big Pickle', instr: '' })
      toast('Space created. Drag sessions into it.')
      break
    }
    case 'space-settings':
      e.stopPropagation()
      S.space = id
      S.overlay = 'space'
      break
    case 'space-save':
      S.overlay = null
      toast('Saved. New sessions in this space use it.')
      break
    case 'palette':
      S.overlay = 'palette'
      S.palette = ''
      S.focus = '[data-input="palette"]'
      break
    case 'settings':
      S.overlay = 'settings'
      break
    case 'settings-sec':
      S.settings = v
      S.settingsQuery = ''
      break
    case 'board':
      S.main = S.main === 'board' ? S.mode : 'board'
      S.overlay = null
      break
    case 'close':
      S.overlay = null
      break
    case 'close-ov':
      if (e.target !== el) return
      S.overlay = null
      break
    case 'answer':
      x.status = 'running'
      S.tx[x.id] = S.tx[x.id].filter((l) => l[0] !== 'q')
      S.tx[x.id].push(['user', v])
      later(1600, () => {
        S.tx[x.id].push(['text', `Reverted ${v === 'Both packages' ? 'in both packages' : 'in @ai-sdk/heygen'}. The playground loads again.`], ['meta', 'Build · Big Pickle · 1m 04s'])
        x.status = 'idle'
      })
      break
    case 'url':
      if (e.metaKey || e.ctrlKey) toast('Opened in your browser')
      else toast('⌘-click to open links', { ms: 1800 })
      break
    case 'panel-fold':
      S.panel = S.panel === 'fold' ? 'float' : 'fold'
      break
    case 'panel-dock':
      S.panel = S.panel === 'dock' ? 'float' : 'dock'
      break
    case 'panel-close':
      S.panel = 'none'
      toast('Resources hidden. ⇧⌘R brings it back.', { action: 'Show', act: 'panel-show' })
      break
    case 'panel-show':
      S.panel = 'float'
      S.toast = null
      break
    case 'res-tab':
      S.resTab = v
      break
    case 'res-archive': {
      const r = panelItems().find((r) => r.sub === v)
      if (r) S.resArchived.push(r)
      break
    }
    case 'res-unarchive':
      S.resArchived = S.resArchived.filter((r) => r.sub !== v)
      break
    case 'send':
      if (x) send(x.id, S.drafts[x.id] || '')
      else {
        const text = S.drafts.home || ''
        if (!text.trim()) break
        newSession('next')
        S.drafts.home = ''
        send(S.current, text)
      }
      break
    case 'stop':
      S.stream = null
      if (x) {
        x.status = 'idle'
        S.tx[x.id].push(['meta', 'Interrupted'])
      }
      break
    case 'picker':
      S.picker = !S.picker
      S.work = null
      S.pickerQ = ''
      if (S.picker) S.focus = '[data-input="picker"]'
      break
    case 'model':
      S.model = v
      S.picker = false
      toast(`Next turns use ${v}. The TUI follows.`)
      break
    case 'work':
      S.work = S.work === v ? null : v
      S.picker = false
      break
    case 'kill':
      S.work2 = S.work2.filter((w) => w.label !== v)
      if (!S.work2.length) S.work = null
      break
    case 'sample-paste':
      handlePaste(Array.from({ length: 12 }, (_, i) => `  at Object.<anonymous> (test/e2e/gtm.test.ts:${40 + i}:7)`).join('\n'))
      break
    case 'cli':
      runCli()
      break
    case 'install':
      runInstall()
      break
    case 'bfilter': {
      const types = ['GitHub', 'Slack', 'Vercel', 'Linear']
      const h = S.board.hidden
      if (e.metaKey || e.shiftKey) S.board.hidden = h.includes(v) ? h.filter((t) => t !== v) : [...h, v]
      else if (e.altKey) S.board.hidden = [v]
      else S.board.hidden = h.length === 3 && !h.includes(v) ? [] : types.filter((t) => t !== v)
      break
    }
    case 'set':
      if (el.dataset.k === 'theme') S.theme = v
      else if (el.dataset.k === 'harness') S.spaces.forEach((sp) => (sp.harness = v))
      else if (el.dataset.k === 'sp-harness') S.spaces.find((s) => s.id === S.space).harness = v
      else if (el.dataset.k === 'welcome') S.welcome.harness = v
      break
    case 'toggle':
      if (el.dataset.k === 'instr') S.instr = !S.instr
      else el.classList.toggle('on')
      if (el.dataset.k !== 'instr') return
      break
    case 'size':
      S.fontSize = Math.min(16, Math.max(10, S.fontSize + Number(v)))
      break
    case 'play':
      play(S.sounds[el.dataset.k])
      return
    case 'rebind':
      S.rebinding = S.rebinding === Number(v) ? -1 : Number(v)
      break
    case 'skill':
      S.skills[el.dataset.k] = !S.skills[el.dataset.k]
      toast(S.skills[el.dataset.k] ? 'Installed. Agents pick it up on their next turn.' : 'Uninstalled')
      break
    case 'show-instr':
      S.showInstr = !S.showInstr
      break
    case 'fix-tool':
    case 'fix-aws': {
      const k = el.dataset.k || 'aws'
      S.tools[k] = 'fixing'
      toast(k === 'notion' ? 'Signing in to notion…' : 'Opening your browser for aws sso login…')
      later(1700, () => {
        S.tools[k] = 'ok'
        toast(`✓ ${k === 'aws' ? 'AWS SSO' : k} works again`)
      })
      break
    }
    case 'update':
      if (S.update === 'idle') {
        S.update = 'checking'
        later(1200, () => (S.update = 'found'))
      } else if (S.update === 'found') {
        S.update = 'done'
        S.overlay = null
        toast('Updating… ctrl restarts in a second')
        later(1800, () => toast('✓ You’re on ctrl 0.46.0'))
      }
      break
    case 'welcome':
      S.overlay = 'welcome'
      S.welcome = { step: 0, harness: 'opencode' }
      break
    case 'welcome-next':
      S.welcome.step = 1
      break
    case 'welcome-done':
      S.overlay = null
      toast(`All set. New sessions start with ${S.welcome.harness}.`)
      break
    case 'noop-toast':
      toast(v)
      break
    case 'banner':
      S.banner = null
      S.dock = Math.max(0, S.dock - 1)
      return open(S.sessions.find((x) => x.id === 's6') ? 's6' : S.current)
    case 'phone-open':
      S.phone = { ...S.phone, screen: 'chat', session: id }
      break
    case 'phone-back':
      S.phone.screen = 'list'
      break
    case 'phone-perm': {
      const s = byId(S.phone.session)
      S.phone.perm = v
      if (v === 'deny') {
        S.tx[s.id].push(['text', 'Okay, I won’t run it. Want me to do something else?'])
        break
      }
      S.tx[s.id].push(['tool', '$ pnpm test-dev test/e2e/gtm'])
      s.status = 'running'
      later(1500, () => {
        S.tx[s.id].push(['text', '20/20 passed.'])
        s.status = 'idle'
      })
      break
    }
    case 'phone-answer':
      S.phone.answers.push(v)
      S.phone.q++
      break
    case 'phone-submit': {
      const s = byId('s8')
      s.status = 'running'
      S.tx.s8 = S.tx.s8.filter((l) => l[0] !== 'q')
      S.tx.s8.push(['user', S.phone.answers.join(' · ')])
      later(1600, () => {
        S.tx.s8.push(['text', 'Reverted and opened a draft PR: vercel/ai#813'])
        s.status = 'idle'
      })
      break
    }
    case 'phone-send': {
      const input = mock.querySelector('[data-input="phone"]')
      const s = byId(S.phone.session)
      if (!input?.value.trim() || !s) break
      S.tx[s.id].push(['user', input.value])
      s.status = 'running'
      later(1400, () => {
        S.tx[s.id].push(['text', REPLIES[replyN++ % REPLIES.length]])
        s.status = 'idle'
      })
      break
    }
    case 'comp-new':
      S.overlay = null
      newSession('next', { prompt: 'https://github.com/vercel/next.js/pull/99932 ' })
      toast('New session with the link on screen typed in')
      break
    default:
      return
  }
  render()
}

function handlePaste(text) {
  const x = cur()
  const id = x?.id || 'home'
  const lines = text.split('\n').length
  if (lines < 5 && text.length < 800) return false
  const token = `[Pasted ${lines} lines]`
  S.pastes[id] = { ...(S.pastes[id] || {}), [token]: text }
  const prev = S.drafts[id] || ''
  S.drafts[id] = prev + (prev && !prev.endsWith(' ') ? ' ' : '') + token + ' '
  S.focus = '[data-input="composer"]'
  render()
  return true
}

root.addEventListener('click', (e) => {
  const f = e.target.closest('[data-f]')
  if (f) return select(f.dataset.f)
  if (e.target.closest('.cap-next')) {
    const i = items.indexOf(feature)
    return select(items[(i + 1) % items.length].id)
  }
  const el = e.target.closest('[data-a]')
  if (!el || !root.contains(el)) {
    if (S.picker || S.work) {
      S.picker = false
      S.work = null
      render()
    }
    return
  }
  if (S.hl) {
    S.hl = null
    for (const h of mock.querySelectorAll('.hl')) h.classList.remove('hl')
  }
  act(el.dataset.a, el, e)
})

root.addEventListener('dblclick', (e) => {
  if (e.target.closest('[data-resize]')) {
    S.sbw = 212
    render()
  }
})

root.addEventListener('input', (e) => {
  const k = e.target.dataset.input
  const x = cur()
  if (k === 'prompt' && x) S.prompt[x.id] = e.target.value
  else if (k === 'composer') {
    S.drafts[x?.id || 'home'] = e.target.value
    const btn = mock.querySelector('.send')
    if (btn && S.stream) render()
  } else if (k === 'palette') {
    S.palette = e.target.value
    S.paletteSel = 0
    render()
  } else if (k === 'settings') {
    S.settingsQuery = e.target.value
    render()
  } else if (k === 'picker') {
    S.pickerQ = e.target.value
    render()
  } else if (k === 'sp-folder') S.spaces.find((s) => s.id === S.space).folder = e.target.value
  else if (k === 'sp-instr') S.spaces.find((s) => s.id === S.space).instr = e.target.value
})

root.addEventListener('change', (e) => {
  const k = e.target.dataset.change
  if (!k) return
  if (k === 'tuiTheme') S.tuiTheme = e.target.value
  else if (k.startsWith('sound:')) {
    S.sounds[k.slice(6)] = e.target.value
    play(e.target.value)
  } else if (k === 'sp-model') S.spaces.find((s) => s.id === S.space).model = e.target.value
  render()
})

root.addEventListener('paste', (e) => {
  if (e.target.dataset?.input !== 'composer') return
  const text = e.clipboardData.getData('text')
  if (handlePaste(text)) e.preventDefault()
})

mock.addEventListener('keydown', (e) => {
  const k = e.target.dataset?.input
  const x = cur()
  if (k === 'prompt' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (x) send(x.id, e.target.value)
    render()
  } else if (k === 'composer' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (S.stream && x && e.target.value.trim()) {
      S.steer.push(e.target.value.trim())
      S.drafts[x.id] = ''
      render()
    } else act('send', e.target, e)
  } else if (k === 'composer' && e.key === 'Backspace') {
    const v = e.target.value.slice(0, e.target.selectionStart)
    const m = v.match(/\[Pasted \d+ lines\] ?$/)
    if (m && e.target.selectionStart === e.target.selectionEnd) {
      e.preventDefault()
      const id = x?.id || 'home'
      S.drafts[id] = v.slice(0, -m[0].length) + e.target.value.slice(e.target.selectionStart)
      render()
    }
  } else if (k === 'palette') {
    const rows = mock.querySelectorAll('.pal-row')
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      S.paletteSel = (S.paletteSel + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % Math.max(1, rows.length)
      render()
    } else if (e.key === 'Enter' && rows[S.paletteSel]) open(rows[S.paletteSel].dataset.id)
  }
})

const inDemo = () => hovering || root.contains(document.activeElement)
const isJumpKey = (e) => /^Digit[1-9]$/.test(e.code)

window.addEventListener('keydown', (e) => {
  if (!S || !inDemo()) return
  if (S.rebinding >= 0) {
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return
    e.preventDefault()
    const keys = (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '') + (e.metaKey ? '⌘' : '') + (e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key === ' ' ? 'Space' : e.key)
    S.shortcuts[S.rebinding][1] = keys
    S.rebinding = -1
    return render()
  }
  if (e.key === 'Meta' && !S.badges && S.overlay !== 'companion') {
    S.badges = true
    return render()
  }
  if (e.key === 'Control' && !S.badges && S.overlay === 'companion') {
    S.badges = true
    return render()
  }
  if (e.key === 'Escape') {
    if (S.overlay && S.overlay !== 'companion') {
      S.overlay = null
      S.rebinding = -1
    } else if (S.stream) act('stop', mock, e)
    S.picker = false
    S.work = null
    return render()
  }
  if (e.ctrlKey && !e.metaKey && isJumpKey(e) && S.overlay === 'companion') {
    e.preventDefault()
    const id = ['s1', 's4'][Number(e.code.slice(5)) - 1]
    if (id) {
      S.overlay = null
      S.badges = false
      open(id)
    }
    return
  }
  if (!e.metaKey) return
  const key = e.key.toLowerCase()
  if (isJumpKey(e)) {
    e.preventDefault()
    const id = visibleIds()[Number(e.code.slice(5)) - 1]
    if (id) open(id)
  } else if (key === 'p' || key === 'k') {
    e.preventDefault()
    act('palette', mock, e)
  } else if (key === 'n') {
    e.preventDefault()
    act('new', mock, e)
  } else if (key === 't') {
    e.preventDefault()
    newSession(cur()?.space || 'next', { harness: cur()?.harness })
    render()
  } else if (key === 'w') {
    e.preventDefault()
    if (S.current) {
      archive(S.current)
      render()
    }
  } else if (key === 'z' && S.undo && !e.target.matches?.('input, textarea')) {
    e.preventDefault()
    act('undo', mock, e)
  } else if (key === ',') {
    e.preventDefault()
    act('settings', mock, e)
  } else if (key === 'r' && e.shiftKey) {
    e.preventDefault()
    S.panel = S.panel === 'none' ? 'float' : 'none'
    render()
  }
})

window.addEventListener('keyup', (e) => {
  if ((e.key === 'Meta' || e.key === 'Control') && S?.badges) {
    S.badges = false
    render()
  }
})
window.addEventListener('blur', () => {
  if (S?.badges) {
    S.badges = false
    render()
  }
})

root.addEventListener('pointerenter', () => (hovering = true))
root.addEventListener('pointerleave', () => (hovering = false))

root.addEventListener('pointerdown', (e) => {
  if (e.target.closest('[data-hold]')) {
    e.preventDefault()
    S.badges = true
    render()
    const up = () => {
      S.badges = false
      render()
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointerup', up)
    return
  }
  const handle = e.target.closest('[data-resize]')
  const drag = e.target.closest('[data-drag]')
  if (!handle && !drag) return
  e.preventDefault()
  const sb = mock.querySelector('.app')
  const comp = mock.querySelector('.comp')
  const x0 = e.clientX
  const y0 = e.clientY
  const zoom = parseFloat(getComputedStyle(mock).zoom) || 1
  const w0 = S.sbw
  const c0 = { ...S.comp }
  const move = (ev) => {
    const dx = (ev.clientX - x0) / zoom
    const dy = (ev.clientY - y0) / zoom
    if (handle) {
      S.sbw = Math.round(Math.min(320, Math.max(150, w0 + dx)))
      sb.style.setProperty('--sbw', S.sbw + 'px')
    } else {
      S.comp = { x: Math.max(0, c0.x + dx), y: Math.max(0, c0.y + dy) }
      comp.style.left = S.comp.x + 'px'
      comp.style.top = S.comp.y + 'px'
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
})

/* Drag and drop: sessions onto the terminal, spaces or other sessions; links and files onto the terminal */

let dragging = null
mock.addEventListener('dragstart', (e) => {
  const rowEl = e.target.closest?.('[data-session]')
  const resEl = e.target.closest?.('[data-res]')
  if (rowEl) dragging = { kind: 'session', id: rowEl.dataset.session }
  else if (resEl) dragging = { kind: 'res', sub: resEl.dataset.res }
  else return
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData('text/plain', 'ctrl')
})
mock.addEventListener('dragend', () => {
  dragging = null
  for (const o of mock.querySelectorAll('.over')) o.classList.remove('over')
})
mock.addEventListener('dragover', (e) => {
  const t = e.target.closest('[data-drop]')
  if (!t) return
  const kind = t.dataset.drop
  const files = !dragging && e.dataTransfer.types.includes('Files')
  if (kind === 'term' ? !(dragging || files) : dragging?.kind !== 'session' || t.dataset.session === dragging.id) return
  e.preventDefault()
  for (const o of mock.querySelectorAll('.over')) if (o !== t) o.classList.remove('over')
  t.classList.add('over')
})
mock.addEventListener('dragleave', (e) => {
  const t = e.target.closest('[data-drop]')
  if (t && !t.contains(e.relatedTarget)) t.classList.remove('over')
})
mock.addEventListener('drop', (e) => {
  const t = e.target.closest('[data-drop]')
  if (!t) return
  e.preventDefault()
  const kind = t.dataset.drop
  if (kind === 'term') {
    if (dragging?.kind === 'session') {
      const x = byId(dragging.id)
      if (x) insertPrompt(mention(x))
    } else if (dragging?.kind === 'res') {
      const r = panelItems().find((r) => r.sub === dragging.sub)
      if (r) insertPrompt(r.type === 'pr' || r.type === 'issue' ? `https://github.com/${r.sub.replace('#', '/pull/')}` : r.sub)
    } else if (e.dataTransfer.files.length) {
      insertPrompt([...e.dataTransfer.files].map((f) => '~/Desktop/' + f.name.replace(/([ ()'&])/g, '\\$1')).join(' '))
    }
  } else if (dragging?.kind === 'session') {
    const x = byId(dragging.id)
    if (kind === 'space' && x) {
      const sp = t.dataset.space
      x.space = sp
      x.parent = undefined
      S.sessions.filter((k) => k.parent === x.id).forEach((k) => (k.space = sp))
      S.folded[sp] = false
      toast(`Moved to ${S.spaces.find((s) => s.id === sp).name}`)
    } else if (kind === 'session' && x) {
      const target = byId(t.dataset.session)
      let p = target
      while (p) {
        if (p.id === x.id) return
        p = byId(p.parent)
      }
      x.parent = target.id
      x.space = target.space
      S.folded[target.id] = false
      toast(`Nested under “${target.title}”`)
    }
  }
  dragging = null
  render()
})

/* Fit the 760px-wide mock on small screens */
function fit() {
  const w = mock.parentElement.clientWidth
  mock.style.zoom = w < 760 ? String(w / 760) : ''
}
new ResizeObserver(fit).observe(mock.parentElement)

select('spaces')
