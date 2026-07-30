"use client";

/**
 * Two-state icon toggle button with the "material-symbols toggle_on/off" look
 * used by the quota page's Auto-refresh and Used-up toggles.
 *
 * Exists so a new toggle doesn't clone-paste the same h-8/rounded-lg/border
 * shell plus the on/off icon swap. The visual style is intentionally the same
 * for every caller — only the icon, label, and an optional trailing slot vary.
 *
 * @param {object} props
 * @param {boolean} props.active - whether the toggle is on (shows toggle_on + primary colour)
 * @param {(v: boolean) => void} props.onClick - receives the next boolean state
 * @param {string} props.icon - material-symbols-outlined icon name (e.g. "auto_awesome")
 * @param {string} [props.label] - inline text label (hidden on <sm screens, like Auto-refresh)
 * @param {string} [props.title] - hover tooltip
 * @param {React.ReactNode} [props.children] - optional trailing node (e.g. the `(60s)` countdown)
 * @param {string} [props.className] - extra classes on the outer button
 */
export default function IconToggleButton({
  active = false,
  onClick,
  label,
  title,
  children,
  className = "",
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(!active)}
      aria-pressed={active}
      className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 ${className}`}
      title={title}
    >
      <span
        className={`material-symbols-outlined text-[14px] ${
          active ? "text-primary" : "text-text-muted"
        }`}
      >
        {active ? "toggle_on" : "toggle_off"}
      </span>
      {label && (
        <span className="hidden text-text-primary sm:inline">{label}</span>
      )}
      {children}
    </button>
  );
}
