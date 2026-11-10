import MarkdownIt from "markdown-it"
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"
import type { ChatPending, FormAnswer, FormField } from "../main/remote"
import type { ChatItem } from "../main/remote-chat"
import type { SessionItem } from "../shared/types"

/**
 * opencode sessions as a chat, like remote control's phone view (src/remote/client.ts), for Settings →
 * Appearance → Sessions as chat. Same reads (src/main/remote-chat.ts): text, thinking markers and tool
 * one-liners. The TUI keeps running underneath, so switching back to the terminal is instant.
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

const TOOL_ICONS: Record<string, string> = { running: "◌", done: "✓", error: "✕" }
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/
const MAX_IMAGES = 6

const readImage = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

export const ChatView = forwardRef<ChatHandle, Props>(function ChatView({ sessionID, session, archived }, ref) {
  const [items, setItems] = useState<Map<string, ChatItem>>(new Map())
  const [cursor, setCursor] = useState<string | null>(null)
  const [pending, setPending] = useState<ChatPending[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [images, setImages] = useState<string[]>([])
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  /** What to do with the scroll position after the next render */
  const scroll = useRef<{ kind: "bottom" } | { kind: "keep"; fromBottom: number } | { kind: "follow" } | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus(),
      paste: (t) => {
        const el = input.current
        if (!el) return
        el.focus()
        document.execCommand("insertText", false, t)
      },
    }),
    [],
  )

  useEffect(() => {
    let live = true
    setItems(new Map())
    setCursor(null)
    setPending([])
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
        setLoaded(true)
      })
      .catch((err) => live && setError(String(err?.message ?? err)))
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
    requestAnimationFrame(() => input.current?.focus())
    return () => {
      live = false
      offUpdate()
      offPending()
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

  const submit = useCallback(() => {
    if (!text.trim() && !images.length) return
    void window.ctrl.chatSend(sessionID, text, images).catch((err) => setError(String(err?.message ?? err)))
    setText("")
    setImages([])
    scroll.current = { kind: "bottom" }
  }, [text, images, sessionID])

  const addImages = useCallback(async (files: File[]) => {
    const picked = files.filter((f) => IMAGE_TYPES.test(f.type))
    const urls = await Promise.all(picked.map(readImage))
    setImages((prev) => [...prev, ...urls].slice(0, MAX_IMAGES))
  }, [])

  // Grow with its content, up to a third of the window.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 3)}px`
  }, [text])

  const sorted = [...items.values()].sort((a, b) => a.time - b.time)
  const running = session?.status === "running"

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
            {pending.map((p) =>
              p.kind === "permission" ? (
                <Permission key={p.id} sessionID={sessionID} pending={p} />
              ) : (
                <Question key={p.id} sessionID={sessionID} pending={p} />
              ),
            )}
            <div className="chat-composer">
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
                <textarea
                  ref={input}
                  rows={1}
                  value={text}
                  placeholder={running ? "Queue a message…" : "Message"}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      submit()
                    }
                    if (e.key === "Escape" && running) void window.ctrl.chatStop(sessionID)
                  }}
                  onPaste={(e) => {
                    const files = [...e.clipboardData.files]
                    if (!files.some((f) => IMAGE_TYPES.test(f.type))) return
                    e.preventDefault()
                    void addImages(files)
                  }}
                  onDrop={(e) => {
                    const files = [...e.dataTransfer.files]
                    if (!files.some((f) => IMAGE_TYPES.test(f.type))) return
                    e.preventDefault()
                    void addImages(files)
                  }}
                />
                {running && (
                  <button className="chat-stop" title="Stop (Esc)" onClick={() => void window.ctrl.chatStop(sessionID)}>
                    ■
                  </button>
                )}
                <button className="chat-send" title="Send (Enter)" disabled={!text.trim() && !images.length} onClick={submit}>
                  ↑
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

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
        {item.text.trim() && <div className="chat-bubble">{item.text}</div>}
      </div>
    )
  }
  return (
    <div className="chat-msg assistant">
      {item.parts.map((p, n) =>
        p.type === "text" ? (
          <div key={n} className="chat-md" dangerouslySetInnerHTML={{ __html: md.render(p.text) }} />
        ) : p.type === "reasoning" ? (
          <div key={n} className="chat-thinking">
            Thought
          </div>
        ) : (
          <div key={n} className={`chat-tool ${p.status}`}>
            <span className="chat-tool-icon">{TOOL_ICONS[p.status]}</span>
            <span className="chat-tool-name">{p.name}</span>
            <span className="chat-tool-summary">{p.summary}</span>
          </div>
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
