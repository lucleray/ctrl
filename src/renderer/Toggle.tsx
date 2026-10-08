export function Toggle({ on, onChange, title }: { on: boolean; onChange(on: boolean): void; title?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      title={title}
      className={`switch ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  )
}
