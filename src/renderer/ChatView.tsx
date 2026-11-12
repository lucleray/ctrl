import MarkdownIt from "markdown-it"
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { ChatPending, FormAnswer, FormField } from "../main/remote"
import type { ChatItem, ChatPart, ChatQueued } from "../main/remote-chat"
import type { BlockingWork, ChatStats, ModelChoices, ModelRef, SessionItem } from "../shared/types"
import { Icon } from "./icons"
import { keyOf, ModelPopover } from "./ModelPicker"

/**
 * opencode sessions as a chat, like remote control's phone view (src/remote/client.ts), for Settings →
 * Appearance → Sessions as chat. Same reads (src/main/remote-chat.ts), plus what only the desktop shows:
 * thinking text and full shell commands. The TUI keeps running underneath, so switching back is instant.
 */

export type ChatHandle = {
  focus(): void
  /** Inserts text at the cursor (session references dropped on the chat) */
  paste(text: string): void
}

type Props = {
  sessionID: string
  session: SessionItem | undefined
  archived: boolean
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })
// Wide tables scroll sideways in their own box instead of squeezing every column.
md.renderer.rules.table_open = () => '<div class="chat-table"><table>\n'
md.renderer.rules.table_close = () => "</table></div>\n"

/** Longest cell (in characters) for a column to stay compact (no minimum width, no wrapping), or to count as prose. */
const NARROW_COLUMN = 12
const PROSE_COLUMN = 40

// Sizes columns by their longest cell: short values ("#", a status) stay compact, prose gets more room than
// names and labels. CSS turns these into minimum widths; past them, the table scrolls sideways.
md.core.ruler.push("table_columns", (state) => {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "table_open") continue
    const cells: { token: (typeof tokens)[number]; col: number }[] = []
    const longest: number[] = []
    let col = -1
    let j = i + 1
    for (; j < tokens.length && tokens[j].type !== "table_close"; j++) {
      const t = tokens[j]
      if (t.type === "tr_open") col = -1
      else if (t.type === "th_open" || t.type === "td_open") {
        col++
        cells.push({ token: t, col })
        const text = tokens[j + 1]?.type === "inline" ? tokens[j + 1].content : ""
        longest[col] = Math.max(longest[col] ?? 0, [...text].length)
      }
    }
    for (const c of cells) {
      const len = longest[c.col] ?? 0
      if (len <= NARROW_COLUMN) c.token.attrJoin("class", "narrow")
      else if (len > PROSE_COLUMN) c.token.attrJoin("class", "prose")
    }
    i = j
  }
})

/** Rendered markdown by source: a streaming turn re-renders its last part only, and remounts render nothing. */
const htmlCache = new Map<string, string>()
const HTML_CACHE_MAX = 400
function renderMarkdown(text: string) {
  let html = htmlCache.get(text)
  if (html === undefined) {
    html = md.render(text)
    if (htmlCache.size >= HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value!)
    htmlCache.set(text, html)
  }
  return html
}

const TOOL_ICONS: Record<string, string> = { running: "◌", background: "↗", done: "✓", error: "✕" }
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/
const MAX_IMAGES = 6

/** `@session[Title](id)`, what a dropped session pastes (sessionMention in ReferenceDrop.tsx) */
const MENTION = /@session\[([^\]\n]*)\]\(((?:ses_|fx:)[^)\s]+)\)/g
/** A paste this long shows as one `[Pasted N lines]` token in the composer; ⌘V again pastes it in full. */
const LONG_PASTE_LINES = 5
const LONG_PASTE_CHARS = 800

const readImage = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/** Text with session mentions drawn as chips (sent messages, and ones waiting to steer). */
function withMentions(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(MENTION)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <span key={m.index} className="chat-chip" title={m[2]}>
        <Icon name="link" />
        {m[1].trim() || m[2]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** "shell: pnpm test" for one, "2 shells and a subagent" for more. */
function blockingLabel(work: BlockingWork[]) {
  if (work.length === 1) return work[0].title ? `${work[0].kind}: ${work[0].title}` : `a ${work[0].kind}`
  const count = (kind: BlockingWork["kind"]) => {
    const n = work.filter((w) => w.kind === kind).length
    return n > 1 ? `${n} ${kind}s` : n ? `a ${kind}` : ""
  }
  return [count("shell"), count("subagent")].filter(Boolean).join(" and ")
}

export const ChatView = forwardRef<ChatHandle, Props>(function ChatView({ sessionID, session, archived }, ref) {
  const [items, setItems] = useState<Map<string, ChatItem>>(new Map())
  const [cursor, setCursor] = useState<string | null>(null)
  const [pending, setPending] = useState<ChatPending[]>([])
  const [inbox, setInbox] = useState<ChatQueued[]>([])
  /** Sent from here, shown right away until the inbox (or the message list) has them */
  const [sent, setSent] = useState<ChatQueued[]>([])
  /** What holds the turn and can go on in the background (always empty for harnesses that can't) */
  const [blocking, setBlocking] = useState<BlockingWork[]>([])
  /** Asked to move it there, until `blocking` says what's left */
  const [moving, setMoving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const composer = useRef<ChatHandle>(null)
  /** What to do with the scroll position after the next render */
  const scroll = useRef<{ kind: "bottom" } | { kind: "keep"; fromBottom: number } | { kind: "follow" } | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      focus: () => composer.current?.focus(),
      paste: (t) => composer.current?.paste(t),
    }),
    [],
  )

  useEffect(() => {
    let live = true
    setItems(new Map())
    setCursor(null)
    setPending([])
    setInbox([])
    setSent([])
    setBlocking([])
    setMoving(false)
    setLoaded(false)
    setError(null)
    window.ctrl
      .chatOpen(sessionID)
      .then((page) => {
        if (!live) return
        scroll.current = { kind: "bottom" }
        setItems(new Map(page.items.map((i) => [i.id, i])))
        setCursor(page.cursor)
        setPending(page.pending)
        setInbox(page.inbox)
        setBlocking(page.blocking)
        setLoaded(true)
      })
      .catch((err) => live && setError(String(err?.message ?? err)))
    // Only the messages that changed come in: the others keep their object, so they don't re-render.
    const offUpdate = window.ctrl.onChatUpdate((id, next) => {
      if (id !== sessionID) return
      const el = list.current
      const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 160
      if (nearBottom) scroll.current = { kind: "follow" }
      setItems((prev) => {
        const map = new Map(prev)
        for (const i of next) map.set(i.id, i)
        return map
      })
    })
    const offPending = window.ctrl.onChatPending((id, p) => id === sessionID && setPending(p))
    const offInbox = window.ctrl.onChatInbox((id, q) => id === sessionID && setInbox(q))
    const offBlocking = window.ctrl.onChatBlocking((id, b) => {
      if (id !== sessionID) return
      setBlocking(b)
      setMoving(false)
    })
    requestAnimationFrame(() => composer.current?.focus())
    return () => {
      live = false
      offUpdate()
      offPending()
      offInbox()
      offBlocking()
    }
  }, [sessionID])

  useEffect(() => () => void window.ctrl.chatClose(), [])

  useLayoutEffect(() => {
    const el = list.current
    const s = scroll.current
    if (!el || !s) return
    scroll.current = null
    if (s.kind === "keep") el.scrollTop = el.scrollHeight - s.fromBottom
    else el.scrollTop = el.scrollHeight
  })

  // The composer growing (or a question showing) shrinks the list: keep the bottom in view.
  useEffect(() => {
    const el = list.current
    if (!el) return
    let fromBottom = 0
    const onScroll = () => (fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight)
    el.addEventListener("scroll", onScroll, { passive: true })
    let height = el.clientHeight
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === height) return
      height = el.clientHeight
      el.scrollTop = el.scrollHeight - el.clientHeight - fromBottom
    })
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [])

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await window.ctrl.chatMore(sessionID, cursor)
      const el = list.current
      scroll.current = { kind: "keep", fromBottom: el ? el.scrollHeight - el.scrollTop : 0 }
      setItems((prev) => new Map([...page.items.map((i) => [i.id, i] as const), ...prev]))
      setCursor(page.cursor)
    } finally {
      setLoadingMore(false)
    }
  }, [cursor, loadingMore, sessionID])

  const submit = useCallback(
    (text: string, images: string[]) => {
      scroll.current = { kind: "bottom" }
      window.ctrl.chatSend(sessionID, text, images).then(
        (id) => id && setSent((prev) => [...prev, { id, text, images: images.length }]),
        (err) => setError(String(err?.message ?? err)),
      )
    },
    [sessionID],
  )
  const stop = useCallback(() => void window.ctrl.chatStop(sessionID), [sessionID])
  const background = useCallback(() => {
    setMoving(true)
    window.ctrl.chatBackground(sessionID).then(
      // Nothing left to move (it ended first): `blocking` may not change, so don't wait for it forever.
      () => setTimeout(() => setMoving(false), 2000),
      (err) => {
        setMoving(false)
        setError(String(err?.message ?? err))
      },
    )
  }, [sessionID])

  const sorted = useMemo(() => [...items.values()].sort((a, b) => a.time - b.time), [items])
  // Waiting to steer: in the inbox (or just sent), and not delivered into the conversation yet.
  const waiting = useMemo(() => {
    const ids = new Set(inbox.map((q) => q.id))
    return [...inbox, ...sent.filter((q) => !ids.has(q.id))].filter((q) => !items.has(q.id))
  }, [inbox, sent, items])
  const running = session?.status === "running"
  const held = running && blocking.length > 0

  return (
    <div className="chat-view">
      <div
        className="chat-list"
        ref={list}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a")
          if (!a?.href) return
          e.preventDefault()
          void window.ctrl.openExternal(a.href)
        }}
      >
        <div className="chat-column">
          <div className="chat-top">
            {error ? (
              <p className="chat-empty">{error}</p>
            ) : !loaded ? (
              <p className="chat-empty">Loading…</p>
            ) : cursor ? (
              <button className="btn chat-more" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : "Load earlier messages"}
              </button>
            ) : !sorted.length ? (
              <p className="chat-empty">No messages yet</p>
            ) : null}
          </div>
          {sorted.map((i) => (
            <Message key={i.id} item={i} sessionID={sessionID} />
          ))}
        </div>
      </div>
      {!archived && (
        <div className="chat-bottom">
          <div className="chat-column">
            {waiting.length > 0 && (
              <div className="chat-waiting">
                {waiting.map((q) => (
                  <div key={q.id} className="chat-msg user waiting">
                    <div className="chat-bubble">
                      {q.images > 0 && <span className="chat-waiting-photos">{q.images === 1 ? "1 photo" : `${q.images} photos`} · </span>}
                      {withMentions(q.text)}
                    </div>
                  </div>
                ))}
                {held ? (
                  <div className="chat-waiting-note held">
                    <span className="chat-waiting-held">Waiting for {blockingLabel(blocking)}</span>
                    <button className="chat-waiting-action" disabled={moving} onClick={background}>
                      {moving ? "Moving…" : "Run in background"}
                      {!moving && <kbd>⌃B</kbd>}
                    </button>
                  </div>
                ) : (
                  <div className="chat-waiting-note">Steers the agent at its next step</div>
                )}
              </div>
            )}
            {pending.map((p) =>
              p.kind === "permission" ? (
                <Permission key={p.id} sessionID={sessionID} pending={p} />
              ) : (
                <Question key={p.id} sessionID={sessionID} pending={p} />
              ),
            )}
            <Composer
              ref={composer}
              placeholder={running ? "Steer the agent…" : "Message"}
              sendTitle={running ? "Steer (Enter)" : "Send (Enter)"}
              onSubmit={submit}
              onStop={running ? stop : undefined}
              onBackground={held && !moving ? background : undefined}
            />
            <div className="chat-meta">
              <Stats sessionID={sessionID} running={running} />
              <ModelButton sessionID={sessionID} directory={session?.directory} onPicked={() => composer.current?.focus()} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

/** No session on screen (the TUI's new-session screen): the composer alone, starting a new session. */
export const ChatHome = forwardRef<ChatHandle>(function ChatHome(_props, ref) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composer = useRef<ChatHandle>(null)
  useImperativeHandle(ref, () => ({ focus: () => composer.current?.focus(), paste: (t) => composer.current?.paste(t) }), [])
  useEffect(() => {
    requestAnimationFrame(() => composer.current?.focus())
  }, [])
  return (
    <div className="chat-view chat-home">
      <div className="chat-home-center">
        <div className="chat-column">
          <h2 className="chat-home-title">What do you want to work on?</h2>
          <Composer
            ref={composer}
            placeholder="Start a new session…"
            sendTitle="Start (Enter)"
            disabled={busy}
            onSubmit={(text, images) => {
              setBusy(true)
              setError(null)
              window.ctrl.chatNew(text, images).catch((err) => {
                setBusy(false)
                setError(String(err?.message ?? err))
              })
            }}
          />
          {error && <p className="chat-home-error">{error}</p>}
        </div>
      </div>
    </div>
  )
})

type ComposerProps = {
  placeholder: string
  sendTitle: string
  disabled?: boolean
  onSubmit(text: string, images: string[]): void
  /** Set while a turn runs: the button stops it when nothing's typed, and so does Esc */
  onStop?(): void
  /** Set while a shell or subagent holds the turn: ⌃B moves it to the background */
  onBackground?(): void
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const lineCount = (s: string) => s.split("\n").length

/**
 * The message box. Long pastes and dropped sessions go in as short tokens (`[Pasted 12 lines]`, `@Title`),
 * highlighted by a backdrop drawn under the transparent textarea, and are swapped for what they stand for
 * when sent. Backspace removes a token whole; ⌘V again right after a long paste puts the full text in.
 * Its own component, so typing never re-renders the messages.
 */
const Composer = forwardRef<ChatHandle, ComposerProps>(function Composer({ placeholder, sendTitle, disabled, onSubmit, onStop, onBackground }, ref) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<string[]>([])
  const input = useRef<HTMLTextAreaElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  /** Token label → the text it stands for */
  const tokens = useRef(new Map<string, string>())
  /** The last long paste, so the same ⌘V right after expands it */
  const lastPaste = useRef<{ label: string; text: string } | null>(null)

  /** Typed in through the editor, so ⌘Z undoes it and React's onChange sees it. */
  const insert = (s: string) => document.execCommand("insertText", false, s)

  const addToken = (base: string, value: string) => {
    let label = base
    for (let n = 2; tokens.current.has(label) && tokens.current.get(label) !== value; n++) label = base.replace(/(\]?)$/, ` #${n}$1`)
    tokens.current.set(label, value)
    return label
  }

  /** Session mentions in `s` become `@Title` tokens. */
  const tokenize = (s: string) => s.replace(MENTION, (whole, title: string, id: string) => addToken(`@${title.trim() || id}`, whole))

  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus(),
      paste: (t) => {
        const el = input.current
        if (!el) return
        el.focus()
        insert(tokenize(t))
      },
    }),
    [],
  )

  // Grow with its content, up to a third of the window.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 3)}px`
    if (backdrop.current) backdrop.current.scrollTop = el.scrollTop
  }, [text])

  const addImages = useCallback(async (files: File[]) => {
    const picked = files.filter((f) => IMAGE_TYPES.test(f.type))
    const urls = await Promise.all(picked.map(readImage))
    setImages((prev) => [...prev, ...urls].slice(0, MAX_IMAGES))
  }, [])

  const labels = [...tokens.current.keys()].filter((l) => text.includes(l))
  const empty = !text.trim() && !images.length

  const submit = () => {
    if (empty || disabled) return
    let out = text
    for (const label of labels) out = out.split(label).join(tokens.current.get(label)!)
    onSubmit(out, images)
    setText("")
    setImages([])
    tokens.current.clear()
    lastPaste.current = null
  }

  /** The token that ends (backward) or starts (forward) at the cursor, as [start, end]. */
  const tokenAt = (pos: number, backward: boolean): [number, number] | null => {
    for (const label of labels) {
      const start = backward ? pos - label.length : pos
      if (start >= 0 && text.startsWith(label, start)) return [start, start + label.length]
    }
    return null
  }

  const marked = useMemo(() => {
    if (!labels.length) return null
    const re = new RegExp(labels.map(escapeRegExp).join("|"), "g")
    const out: ReactNode[] = []
    let last = 0
    for (const m of text.matchAll(re)) {
      out.push(text.slice(last, m.index))
      out.push(
        <mark key={m.index} className="chat-token">
          {m[0]}
        </mark>,
      )
      last = m.index + m[0].length
    }
    out.push(text.slice(last))
    return out
  }, [text, labels.join("\n")])

  return (
    <div className={`chat-composer${disabled ? " disabled" : ""}`}>
      {images.length > 0 && (
        <div className="chat-tray">
          {images.map((src, n) => (
            <div key={n} className="chat-thumb">
              <img src={src} alt="" />
              <button title="Remove" onClick={() => setImages((prev) => prev.filter((_, k) => k !== n))}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-composer-row">
        <div className="chat-input">
          {marked && (
            <div className="chat-input-backdrop" ref={backdrop} aria-hidden>
              {marked}
              {"\u200b"}
            </div>
          )}
          <textarea
            ref={input}
            rows={1}
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onScroll={(e) => backdrop.current && (backdrop.current.scrollTop = e.currentTarget.scrollTop)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
                return
              }
              if (e.key === "Escape" && onStop) return onStop()
              // Like opencode's TUI. With nothing to move, ⌃B stays the text field's "back one character".
              if (e.key === "b" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && onBackground) {
                e.preventDefault()
                return onBackground()
              }
              const el = e.currentTarget
              if ((e.key === "Backspace" || e.key === "Delete") && el.selectionStart === el.selectionEnd && !e.metaKey && !e.altKey) {
                const range = tokenAt(el.selectionStart, e.key === "Backspace")
                if (!range) return
                e.preventDefault()
                el.setSelectionRange(range[0], range[1])
                document.execCommand("delete")
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (files.some((f) => IMAGE_TYPES.test(f.type))) {
                e.preventDefault()
                void addImages(files)
                return
              }
              const pasted = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n")
              if (!pasted) return
              const el = e.currentTarget
              const prev = lastPaste.current
              const at = el.selectionStart
              // The same long paste again, right after its token: put the full text in its place.
              if (prev && prev.text === pasted && el.selectionEnd === at && text.slice(at - prev.label.length, at) === prev.label) {
                e.preventDefault()
                lastPaste.current = null
                el.setSelectionRange(at - prev.label.length, at)
                insert(pasted)
                return
              }
              lastPaste.current = null
              const lines = lineCount(pasted)
              if (lines >= LONG_PASTE_LINES || pasted.length >= LONG_PASTE_CHARS) {
                e.preventDefault()
                const label = addToken(lines > 1 ? `[Pasted ${lines} lines]` : `[Pasted ${pasted.length.toLocaleString()} characters]`, pasted)
                lastPaste.current = { label, text: pasted }
                insert(label)
                return
              }
              if (MENTION.test(pasted)) {
                MENTION.lastIndex = 0
                e.preventDefault()
                insert(tokenize(pasted))
              }
            }}
            onDrop={(e) => {
              const files = [...e.dataTransfer.files]
              if (!files.some((f) => IMAGE_TYPES.test(f.type))) return
              e.preventDefault()
              void addImages(files)
            }}
          />
        </div>
        {/* One button: stop while a turn runs and nothing's typed, send otherwise (typing steers). */}
        {onStop && empty ? (
          <button className="chat-action stop" title="Stop (Esc)" onClick={onStop}>
            <span className="chat-stop-icon" />
          </button>
        ) : (
          <button className="chat-action" title={sendTitle} disabled={empty || disabled} onClick={submit}>
            ↑
          </button>
        )}
      </div>
    </div>
  )
})

/**
 * A box showing its first 3 lines; click it to see everything, click again to fold it back. Clicks that
 * select text or follow a link don't toggle it.
 */
function Clamp({ className, children }: { className: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || open) return
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    check()
    // The box grows until it's clamped (streaming), and rewraps when the window resizes.
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])
  const foldable = overflows || open
  return (
    <div
      ref={box}
      className={`chat-clamp ${className}${open ? " open" : ""}${foldable ? " foldable" : ""}${overflows && !open ? " clipped" : ""}`}
      onClick={(e) => {
        if (!foldable || (e.target as HTMLElement).closest("a") || window.getSelection()?.toString()) return
        setOpen((o) => !o)
      }}
    >
      {children}
    </div>
  )
}

const TextPart = memo(function TextPart({ text }: { text: string }) {
  return <div className="chat-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
})

function Thinking({ text }: { text?: string }) {
  if (!text) return <div className="chat-thinking">Thought</div>
  return (
    <Clamp className="chat-thinking has-text">
      <div className="chat-thinking-label">Thought</div>
      <div className="chat-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    </Clamp>
  )
}

const oneLine = (s: string) => s.trim().replace(/\s+/g, " ")

function Tool({ part }: { part: Extract<ChatPart, { type: "tool" }> }) {
  const head = (
    <>
      <span className="chat-tool-icon">{TOOL_ICONS[part.status]}</span>
      <span className="chat-tool-name">{part.name}</span>
      {part.status === "background" && <span className="chat-tool-tag">background</span>}
    </>
  )
  if (part.command) {
    // The summary is the command's description when it has one, else the command itself (shown below).
    const description = oneLine(part.command).startsWith(part.summary.replace(/…$/, "")) ? "" : part.summary
    return (
      <div className="chat-tool-block">
        <div className={`chat-tool ${part.status}`}>
          {head}
          {description && <span className="chat-tool-summary">{description}</span>}
        </div>
        <Clamp className="chat-cmd">{part.command}</Clamp>
      </div>
    )
  }
  return (
    <div className={`chat-tool ${part.status}`}>
      {head}
      {part.detail ? (
        <Clamp className="chat-tool-detail">{part.detail}</Clamp>
      ) : (
        <span className="chat-tool-summary">{part.summary}</span>
      )}
    </div>
  )
}

const Message = memo(function Message({ item, sessionID }: { item: ChatItem; sessionID: string }) {
  if (item.kind === "user") {
    return (
      <div className="chat-msg user">
        {!!item.images && (
          <div className="chat-photos">
            {Array.from({ length: item.images }, (_, n) => (
              <UserImage key={n} sessionID={sessionID} messageID={item.id} index={n} />
            ))}
          </div>
        )}
        {item.text.trim() && <div className="chat-bubble">{withMentions(item.text)}</div>}
      </div>
    )
  }
  if (item.kind === "note") {
    return (
      <div className="chat-msg note">
        <div className={`chat-tool ${item.failed ? "error" : "done"}`}>
          <span className="chat-tool-icon">{TOOL_ICONS[item.failed ? "error" : "done"]}</span>
          <span className="chat-tool-name">{item.source}</span>
          <span className="chat-tool-tag">background</span>
          <span className="chat-tool-summary">
            {item.failed ? "failed" : "finished"}
            {item.text && ` · ${item.text}`}
          </span>
        </div>
      </div>
    )
  }
  return (
    <div className="chat-msg assistant">
      {item.parts.map((p, n) =>
        p.type === "text" ? (
          <TextPart key={n} text={p.text} />
        ) : p.type === "reasoning" ? (
          <Thinking key={n} text={p.text} />
        ) : (
          <Tool key={n} part={p} />
        ),
      )}
      {item.error && <div className="chat-error">{item.error}</div>}
      {item.live && !item.parts.length && (
        <div className="chat-typing">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  )
})

function UserImage({ sessionID, messageID, index }: { sessionID: string; messageID: string; index: number }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.ctrl.chatImage(sessionID, messageID, index).then((s) => live && setSrc(s))
    return () => {
      live = false
    }
  }, [sessionID, messageID, index])
  return src ? <img src={src} alt="" /> : <div className="chat-photo-placeholder" />
}

function Permission({ sessionID, pending }: { sessionID: string; pending: Extract<ChatPending, { kind: "permission" }> }) {
  const reply = (decision: "once" | "always" | "reject") => void window.ctrl.chatReply(sessionID, pending.id, decision)
  return (
    <div className="chat-ask">
      <div className="chat-ask-detail">{pending.detail}</div>
      <div className="chat-ask-actions">
        <button className="btn primary" onClick={() => reply("once")}>
          Allow
        </button>
        <button className="btn" onClick={() => reply("always")}>
          Always
        </button>
        <button className="btn" onClick={() => reply("reject")}>
          Deny
        </button>
      </div>
    </div>
  )
}

/** A field shows when it isn't hidden and its `when` conditions hold for the answers so far. */
const fieldShown = (f: FormField, answers: FormAnswer) =>
  !f.hidden && (f.when ?? []).every((w) => (answers[w.key] === w.value) === (w.op === "eq"))

const hasValue = (v: FormAnswer[string] | undefined) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)

const answerLabel = (f: FormField, v: FormAnswer[string] | undefined) => {
  if (!hasValue(v)) return "—"
  const label = (x: string | number | boolean) =>
    typeof x === "boolean" ? (x ? "Yes" : "No") : (f.options?.find((o) => o.value === x)?.label ?? String(x))
  return Array.isArray(v) ? v.map(label).join(", ") : label(v!)
}

function initialAnswers(fields: FormField[]) {
  const answers: FormAnswer = {}
  for (const f of fields) {
    const d = f.default
    if (typeof d === "string" || typeof d === "number" || typeof d === "boolean") answers[f.key] = d
    else if (Array.isArray(d)) answers[f.key] = d.filter((x): x is string => typeof x === "string")
  }
  return answers
}

/** An opencode question form, one question at a time like the TUI (and the phone), ending on a review step. */
function Question({ sessionID, pending }: { sessionID: string; pending: Extract<ChatPending, { kind: "question" }> }) {
  const [answers, setAnswers] = useState<FormAnswer>(() => initialAnswers(pending.fields))
  const [own, setOwn] = useState<Record<string, string>>({})
  const [step, setStep] = useState(0)
  const [sent, setSent] = useState(false)
  const steps = pending.fields.filter((f) => fieldShown(f, answers))
  const multiStep = steps.length > 1
  const review = multiStep && step >= steps.length

  const finish = () => {
    const answer: FormAnswer = {}
    for (const f of steps) if (hasValue(answers[f.key])) answer[f.key] = answers[f.key]
    setSent(true)
    void window.ctrl.chatAnswer(sessionID, pending.id, answer)
  }
  const next = () => (step < steps.length - 1 || multiStep ? setStep(step + 1) : finish())
  const dismiss = () => void window.ctrl.chatAnswer(sessionID, pending.id, null)

  const top = (
    <div className="chat-q-top">
      <span className="chat-q-progress">{review ? "Review" : multiStep ? `${step + 1} of ${steps.length}` : "Question"}</span>
      <button className="chat-q-dismiss" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  )

  if (review) {
    const missing = steps.some((f) => f.required && f.type !== "external" && !hasValue(answers[f.key]))
    return (
      <div className={`chat-ask question${sent ? " sent" : ""}`}>
        {top}
        <div className="chat-q-heading">{pending.title}</div>
        {steps.map((f, i) => (
          <button key={f.key} className="chat-q-review" onClick={() => setStep(i)}>
            <span className="chat-q-desc">{f.title || f.key}</span>
            <span className="chat-q-label">{answerLabel(f, answers[f.key])}</span>
          </button>
        ))}
        <div className="chat-ask-actions">
          <button className="btn" onClick={() => setStep(steps.length - 1)}>
            Back
          </button>
          <button className="btn primary" disabled={missing} onClick={finish}>
            Submit
          </button>
        </div>
      </div>
    )
  }

  const f = steps[Math.min(step, steps.length - 1)]
  if (!f) return null
  const multi = f.type === "multiselect"
  const picks: { value: string | boolean; label: string; description?: string }[] =
    f.type === "boolean" ? [{ value: true, label: "Yes" }, { value: false, label: "No" }] : (f.options ?? [])
  const ownAllowed = f.type !== "boolean" && f.type !== "external" && (!picks.length || f.custom === true)
  const last = step >= steps.length - 1 && !multiStep
  const empty = !hasValue(answers[f.key])
  const numeric = f.type === "number" || f.type === "integer"
  const set = (v: FormAnswer[string]) => setAnswers((a) => ({ ...a, [f.key]: v }))

  return (
    <div className={`chat-ask question${sent ? " sent" : ""}`}>
      {top}
      <div className="chat-q-heading">{f.title || pending.title}</div>
      {f.description && <div className="chat-q-desc chat-q-help">{f.description}</div>}
      {multi && <div className="chat-q-desc chat-q-help">Pick any</div>}
      {picks.length > 0 && (
        <div className="chat-q-options">
          {picks.map((o) => {
            const cur = answers[f.key]
            const on = multi ? Array.isArray(cur) && cur.includes(o.value as string) : cur === o.value
            return (
              <button
                key={String(o.value)}
                className={`chat-q-option${on ? " on" : ""}`}
                onClick={() => {
                  if (multi) {
                    const prev = Array.isArray(cur) ? cur : []
                    set(on ? prev.filter((x) => x !== o.value) : [...prev, o.value as string])
                    return
                  }
                  set(o.value)
                  setOwn((x) => ({ ...x, [f.key]: "" }))
                  if (!last) setTimeout(() => setStep((s) => s + 1), 150)
                }}
              >
                <span className="chat-q-label">{o.label}</span>
                {o.description && <span className="chat-q-desc">{o.description}</span>}
              </button>
            )
          })}
        </div>
      )}
      {f.type === "external" && f.url && (
        <button className="btn" onClick={() => void window.ctrl.openExternal(f.url!)}>
          Open link
        </button>
      )}
      {ownAllowed && (
        <input
          className="chat-q-input"
          type={numeric ? "number" : "text"}
          placeholder={f.placeholder ?? (picks.length ? "Type your own answer…" : "Your answer")}
          value={own[f.key] ?? (!picks.length && answers[f.key] !== undefined ? String(answers[f.key]) : "")}
          onChange={(e) => {
            const v = e.target.value
            setOwn((x) => ({ ...x, [f.key]: v }))
            if (numeric) set(v === "" ? "" : Number(v))
            else if (multi) {
              const picked = (Array.isArray(answers[f.key]) ? (answers[f.key] as string[]) : []).filter((x) =>
                f.options?.some((o) => o.value === x),
              )
              set(v.trim() ? [...picked, v.trim()] : picked)
            } else set(v)
          }}
          onKeyDown={(e) => e.key === "Enter" && !(f.required && empty) && next()}
        />
      )}
      <div className="chat-ask-actions">
        {step > 0 && (
          <button className="btn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <button className="btn primary" disabled={!!f.required && f.type !== "external" && empty} onClick={next}>
          {last ? "Submit" : empty && !f.required ? "Skip" : "Next"}
        </button>
      </div>
    </div>
  )
}

/** The composer's model: the session's own, switched for its next turns (the TUI follows). */
function ModelButton({ sessionID, directory, onPicked }: { sessionID: string; directory?: string; onPicked(): void }) {
  const [model, setModel] = useState<ModelRef | null>(null)
  const [choices, setChoices] = useState<ModelChoices | null>(null)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    const load = () => void window.ctrl.chatModel(sessionID).then((m) => live && setModel(m), () => {})
    setModel(null)
    load()
    const off = window.ctrl.onChatModelChanged((id) => id === sessionID && load())
    return () => {
      live = false
      off()
    }
  }, [sessionID])

  useEffect(() => {
    let live = true
    void window.ctrl.listModels("opencode", directory).then((c) => live && setChoices(c), () => {})
    return () => {
      live = false
    }
  }, [directory])

  const current = model && choices?.models.find((m) => keyOf(m) === keyOf(model))
  const pick = (m: ModelRef) => {
    setOpen(false)
    // Keep the variant when the new model has one with the same name.
    const next = choices?.models.find((x) => keyOf(x) === keyOf(m))
    const variant = model?.variant && next?.variants.includes(model.variant) ? model.variant : undefined
    const ref = variant ? { ...m, variant } : m
    setModel(ref)
    void window.ctrl.chatSetModel(sessionID, ref)
    onPicked()
  }
  const setVariant = (variant: string | undefined) => {
    if (!model) return
    const ref = { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) }
    setModel(ref)
    void window.ctrl.chatSetModel(sessionID, ref)
  }

  return (
    <>
      <button
        ref={trigger}
        className={`chat-model${open ? " open" : ""}`}
        disabled={!choices}
        title="Model for the next messages"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="chat-model-name">{current?.name ?? model?.id ?? "Model"}</span>
        <Icon name="chevron-down" />
      </button>
      {current && current.variants.length > 0 && (
        <VariantMenu
          variants={current.variants}
          // opencode reports "default" for a session that never picked one: that's the Default row.
          value={model?.variant && current.variants.includes(model.variant) ? model.variant : undefined}
          onChange={(v) => {
            setVariant(v)
            onPicked()
          }}
        />
      )}
      {open && choices && trigger.current && (
        <ModelPopover
          anchor={trigger.current}
          align="right"
          choices={choices}
          value={model}
          onPick={pick}
          onClose={() => {
            setOpen(false)
            onPicked()
          }}
        />
      )}
    </>
  )
}

const money = (usd: number) => (usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`)
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** Last stats per session, so coming back to one (or the view remounting) shows them right away. */
const statsCache = new Map<string, ChatStats>()
/** While a turn runs, spend and context are re-read this often (each step of a turn adds to them). */
const STATS_RUNNING_MS = 15_000

/**
 * Spend and context used, under the composer. Read on open, when a turn ends, when the model changes and every
 * STATS_RUNNING_MS while one runs. A failed read keeps what's shown.
 */
function Stats({ sessionID, running }: { sessionID: string; running: boolean }) {
  const [stats, setStats] = useState<ChatStats | null>(() => statsCache.get(sessionID) ?? null)
  useEffect(() => {
    let live = true
    setStats(statsCache.get(sessionID) ?? null)
    const load = () =>
      void window.ctrl.chatStats(sessionID).then(
        (s) => {
          statsCache.set(sessionID, s)
          if (live) setStats(s)
        },
        () => {},
      )
    load()
    const timer = running ? setInterval(load, STATS_RUNNING_MS) : undefined
    const off = window.ctrl.onChatModelChanged((id) => id === sessionID && load())
    return () => {
      live = false
      clearInterval(timer)
      off()
    }
  }, [sessionID, running])
  if (!stats) return <span className="chat-stats" />
  const ctx = stats.context
  const pct = ctx?.limit ? Math.min(100, Math.round((ctx.used / ctx.limit) * 100)) : null
  return (
    <span className="chat-stats">
      <span title="Spent in this session">{money(stats.cost)}</span>
      {ctx && (
        <span
          className={pct !== null && pct >= 80 ? "warn" : ""}
          title={`Context: ${ctx.used.toLocaleString()}${ctx.limit ? ` of ${ctx.limit.toLocaleString()}` : ""} tokens`}
        >
          {pct !== null ? `${pct}% context` : `${tokens(ctx.used)} tokens`}
        </span>
      )}
    </span>
  )
}

/** The model's variants, in a small menu that opens upward (the composer sits at the bottom). */
function VariantMenu({ variants, value, onChange }: { variants: string[]; value?: string; onChange(v: string | undefined): void }) {
  const [open, setOpen] = useState(false)
  const options = [undefined, ...variants]
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, options.indexOf(value)))
    const down = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener("mousedown", down)
    window.addEventListener("blur", () => setOpen(false), { once: true })
    return () => document.removeEventListener("mousedown", down)
  }, [open])

  const pick = (v: string | undefined) => {
    setOpen(false)
    onChange(v)
  }

  return (
    <div
      className="chat-variant-wrap"
      ref={root}
      onKeyDown={(e) => {
        if (!open) return
        e.stopPropagation()
        if (e.key === "Escape") (e.preventDefault(), setOpen(false))
        else if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(options.length - 1, a + 1)))
        else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)))
        else if (e.key === "Enter") (e.preventDefault(), pick(options[active]))
      }}
    >
      <button className={`chat-variant${open ? " open" : ""}`} title="Variant" onClick={() => setOpen((o) => !o)}>
        {value ?? "Default"}
      </button>
      {open && (
        <div className="chat-variant-menu" role="listbox">
          {options.map((v, i) => (
            <div
              key={v ?? ""}
              role="option"
              aria-selected={v === value}
              className={`chat-variant-option${i === active ? " active" : ""}`}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(v)}
            >
              <span className="chat-variant-check">{v === value && <Icon name="check" />}</span>
              {v ?? "Default"}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
