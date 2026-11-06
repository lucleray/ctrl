import { Icon } from "./icons"

/**
 * Over the top of an archived session's terminal, which stays read-only (scrolling only) until
 * it's unarchived. A state of the session on screen, not a notification: it goes away with it.
 */
export function ArchivedBanner({ onUnarchive }: { onUnarchive(): void }) {
  return (
    <div className="archived-banner" role="status">
      <Icon name="archive" />
      <span className="archived-banner-text">This session is archived. Unarchive it to continue.</span>
      <button className="btn primary" onClick={onUnarchive}>
        Unarchive
      </button>
    </div>
  )
}
