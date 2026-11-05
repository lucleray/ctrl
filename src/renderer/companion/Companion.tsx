import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { CompanionApi, CompanionGroup, CompanionSession, CompanionView } from "../../companion/types"
import { age } from "../format"
import { Icon } from "../icons"
import { StatusIcon } from "../StatusIcon"

declare global {
  interface Window {
    companion: CompanionApi
  }
}

/** Same delay as the main window's ⌘ hints (jump.ts): a quick ⌃1 doesn't flash them. */
const HOLD_MS = 300
const HintsShown = createContext(false)

/** True while ⌃ is held on its own in any app (after HOLD_MS). */
function useHints() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.companion.onHold((held) => {
      clearTimeout(timer)
      if (held) timer = setTimeout(() => setShown(true), HOLD_MS)
      else setShown(false)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [])
  return shown
}

export function Companion() {
  const [view, setView] = useState<CompanionView | null>(null)
  const hints = useHints()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => window.companion.onView(setView), [])

  // The window fits its content (main keeps it anchored to its corner).
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const fit = () => window.companion.resize(el.getBoundingClientRect().height)
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    fit()
    return () => observer.disconnect()
  }, [])

  // Ages tick without a new view.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const ctx = view?.context
  return (
    <div className="companion" ref={root}>
      <div className="companion-header">
        <span className="companion-title">ctrl</span>
        <button className="icon-btn companion-menu" title="More" onClick={() => window.companion.menu()}>
          <Icon name="dots" />
        </button>
      </div>
      {ctx && (
        <div className="companion-context">
          <div className="companion-context-text">
            <div className="companion-app">{ctx.app}</div>
            {ctx.label && <div className="companion-label">{ctx.label}</div>}
          </div>
          <button
            className="btn companion-new"
            title={[ctx.label ? `New session about ${ctx.label}` : "New session", view?.shortcut].filter(Boolean).join("  ")}
            onClick={() => window.companion.newSession()}
          >
            <Icon name="compose" />
            New
          </button>
        </div>
      )}
      {view && !view.trusted && (
        <button className="companion-access" onClick={() => window.companion.requestAccess()}>
          <Icon name="alert" />
          <span>Allow Accessibility for ctrl to read Slack, Notion and Linear</span>
        </button>
      )}
      {view?.groups.length ? (
        <HintsShown.Provider value={hints}>
          <Sections groups={view.groups} />
        </HintsShown.Provider>
      ) : (
        <div className="empty">
          {!ctx
            ? "Switch to an app to see related sessions"
            : ctx.resource
              ? `No session mentions ${ctx.resource}`
              : "Nothing here that sessions mention"}
        </div>
      )}
    </div>
  )
}

/** The sidebar's layout: Spaces (one folder per space), then Recents and Archived, which fold. */
function Sections({ groups }: { groups: CompanionGroup[] }) {
  // Kept while the window lives, like the sidebar's (which are saved): Recents open, Archived folded.
  const [recentsOpen, setRecentsOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const spaces = groups.filter((g) => g.kind === "space")
  const recents = groups.find((g) => g.kind === "recents")
  const archived = groups.find((g) => g.kind === "archived")
  return (
    <>
      {spaces.length > 0 && (
        <section className="section">
          <div className="section-header">
            <span>Spaces</span>
          </div>
          {spaces.map((g) => (
            <div key={g.id} className="space">
              <div className="row space-header companion-space">
                <Icon name="folder-open" />
                <span className="label">{g.name}</span>
              </div>
              <div className="space-sessions">
                {g.sessions.map((s) => (
                  <Row key={s.id} session={s} />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
      {recents && (
        <FoldSection title="Recents" open={recentsOpen} onToggle={() => setRecentsOpen((o) => !o)}>
          {recents.sessions.map((s) => (
            <Row key={s.id} session={s} />
          ))}
        </FoldSection>
      )}
      {archived && (
        <FoldSection title="Archived" className="archived" open={archivedOpen} onToggle={() => setArchivedOpen((o) => !o)}>
          {archived.sessions.map((s) => (
            <Row key={s.id} session={s} />
          ))}
        </FoldSection>
      )}
    </>
  )
}

function FoldSection(props: { title: string; open: boolean; onToggle(): void; className?: string; children: ReactNode }) {
  return (
    <section className={`section ${props.className ?? ""}`}>
      <button className="section-header toggle" onClick={props.onToggle}>
        <span>{props.title}</span>
        <Icon name={props.open ? "chevron-down" : "chevron-right"} />
      </button>
      {props.open && props.children}
    </section>
  )
}

function Row({ session: s }: { session: CompanionSession }) {
  const hints = useContext(HintsShown)
  return (
    <button
      className="row session companion-session"
      onClick={() => window.companion.open(s.id)}
      title={[s.title, s.exact ? undefined : `Mentioned ${s.via} in the same channel`, s.jump && `⌃${s.jump}`]
        .filter(Boolean)
        .join("\n")}
    >
      {s.harness === "fx" && <span className="harness-tag">fx</span>}
      <span className="label">{s.title || "Untitled"}</span>
      {!s.exact && (
        <span className="companion-via">
          <Icon name="hash" />
        </span>
      )}
      {hints && s.jump ? (
        <kbd className="jump-hint">⌃{s.jump}</kbd>
      ) : s.status === "idle" || s.archived ? (
        <span className="meta">{age(s.last)}</span>
      ) : (
        <StatusIcon status={s.status} />
      )}
    </button>
  )
}
