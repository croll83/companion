/**
 * The on/off switch of the Domains page (MCP servers, plugins, skills,
 * Chrome). `mixed` shows a group whose items are partly on
 * (aria-checked="mixed"); a click then turns the whole group on.
 */
export function Toggle({
  label,
  checked,
  mixed,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mixed ? "mixed" : checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(mixed ? true : !checked)}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${checked || mixed ? "bg-cc-primary" : "bg-cc-border"} ${mixed ? "opacity-70" : ""}`}
    >
      <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white transition-all ${mixed ? "left-[10px]" : checked ? "left-[18px]" : "left-[2px]"}`} />
    </button>
  );
}
