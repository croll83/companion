import type { LocalProviderView } from "../../api.js";

export interface LocalChoice {
  provider: string;
  model: string;
}

/** The provider's default model, else its first one ("" when it has none). */
export function defaultModelOf(p: LocalProviderView | undefined): string {
  return p?.defaultModel ?? p?.models[0] ?? "";
}

/**
 * New session on a local provider: which provider and which of its models
 * (in the Home toolbar, instead of the Claude model selector). Warns when
 * the provider is offline or has no model yet; the session can still be
 * started (the server may come back), but it would not answer meanwhile.
 */
export function LocalProviderPicker({
  providers,
  value,
  onChange,
}: {
  providers: LocalProviderView[];
  value: LocalChoice;
  onChange: (next: LocalChoice) => void;
}) {
  const provider = providers.find((p) => p.id === value.provider);
  const select = "px-2 py-1 text-[11px] sm:text-xs bg-transparent text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover border border-transparent focus:outline-none focus:border-cc-primary/40 cursor-pointer max-w-[11rem] truncate";
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <select
        aria-label="Local provider"
        className={select}
        value={value.provider}
        onChange={(e) => {
          const next = providers.find((p) => p.id === e.target.value);
          onChange({ provider: e.target.value, model: defaultModelOf(next) });
        }}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}{p.health.status === "offline" ? " (offline)" : ""}
          </option>
        ))}
      </select>
      <select
        aria-label="Local model"
        className={select}
        value={value.model}
        disabled={!provider || provider.models.length === 0}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
      >
        {(provider?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      {provider && provider.health.status === "offline" && (
        <span role="status" className="text-[11px] text-cc-warning">
          {provider.name} is offline{provider.health.error ? ` (${provider.health.error})` : ""}: the session will not answer until it is back.
        </span>
      )}
      {provider && provider.models.length === 0 && (
        <span role="status" className="text-[11px] text-cc-warning">
          {provider.name} has no model yet: add one in Settings → Local providers.
        </span>
      )}
    </div>
  );
}
