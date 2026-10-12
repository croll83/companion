/** The on/off switch of the Domains page (MCP servers, plugins, skill groups, Chrome). */
export function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-8 h-[18px] rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${checked ? "bg-cc-primary" : "bg-cc-border"}`}
    >
      <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${checked ? "left-[16px]" : "left-[2px]"}`} />
    </button>
  );
}
