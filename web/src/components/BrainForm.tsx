import { useId, useState, type ReactNode } from "react";
import type { BrainAuthMode, BrainInfo, BrainInput } from "../api.js";

const FIELD = "w-full px-2 py-1.5 rounded-md bg-cc-input-bg border border-cc-border text-[13px] focus:outline-none focus:ring-1 focus:ring-cc-primary";
const HTTP_URL = /^https?:\/\/\S+$/i;

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] text-cc-muted">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-[10px] text-cc-muted leading-snug">{hint}</p>}
    </div>
  );
}

/**
 * "Connect remote brain" (no `brain`) and "Edit" (with one): name, what it
 * is about, base URL, authentication (none or a bearer token) and, under
 * Advanced, overrides of the MCP and health URLs. The token is write-only:
 * an existing one is never shown, an empty field keeps it.
 */
export function BrainForm({
  brain,
  busy,
  onSubmit,
  onCancel,
}: {
  brain?: BrainInfo;
  busy: boolean;
  onSubmit: (input: BrainInput) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(brain?.name ?? "");
  const [about, setAbout] = useState(brain?.about ?? "");
  const [baseUrl, setBaseUrl] = useState(brain?.remote?.baseUrl ?? "");
  const [mode, setMode] = useState<BrainAuthMode>(brain?.remote?.auth.mode ?? "none");
  const [token, setToken] = useState("");
  const [mcpUrl, setMcpUrl] = useState(brain?.remote?.mcpUrl ?? "");
  const [healthUrl, setHealthUrl] = useState(brain?.remote?.healthUrl ?? "");
  const ids = { name: useId(), about: useId(), base: useId(), mode: useId(), token: useId(), mcp: useId(), health: useId() };

  const editing = !!brain;
  const tokenNeeded = mode === "bearer" && !token.trim() && !(editing && brain.hasToken);
  const badUrl = [baseUrl, mcpUrl, healthUrl].some((u) => u.trim() && !HTTP_URL.test(u.trim()));
  const problem = !name.trim() ? "A name is required."
    : !baseUrl.trim() ? "The base URL is required."
    : badUrl ? "URLs must start with http:// or https://."
    : tokenNeeded ? "Bearer authentication needs a token."
    : "";
  const base = baseUrl.trim().replace(/\/+$/, "") || "<base>";

  const submit = () => {
    const input: BrainInput = {
      name: name.trim(),
      about: about.trim(),
      baseUrl: baseUrl.trim(),
      auth: { mode },
    };
    if (mode === "bearer" && token.trim()) input.token = token.trim();
    // On create an empty override is simply left out; on edit it removes the old one.
    if (mcpUrl.trim() || editing) input.mcpUrl = mcpUrl.trim() || null;
    if (healthUrl.trim() || editing) input.healthUrl = healthUrl.trim() || null;
    void onSubmit(input);
  };

  return (
    <form
      aria-label={editing ? `Edit brain ${brain.name}` : "Connect remote brain"}
      className="space-y-2.5"
      onSubmit={(e) => { e.preventDefault(); if (!problem) submit(); }}
    >
      <Field id={ids.name} label="Name">
        <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jarvis" className={FIELD} />
      </Field>
      <Field id={ids.about} label="What it is about" hint="Tells the model when to use the brain: it becomes the description of the brain's skill.">
        <textarea id={ids.about} value={about} onChange={(e) => setAbout(e.target.value)} rows={3} className={FIELD} />
      </Field>
      <Field id={ids.base} label="Base URL" hint={<>Companion uses <span className="font-mono-code">{base}/mcp</span>, <span className="font-mono-code">{base}/healthz</span> and <span className="font-mono-code">{base}/api/v1</span>.</>}>
        <input id={ids.base} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://100.116.99.9:7421" inputMode="url" className={`${FIELD} font-mono-code`} />
      </Field>
      <Field id={ids.mode} label="Authentication">
        <select id={ids.mode} value={mode} onChange={(e) => setMode(e.target.value as BrainAuthMode)} className={FIELD}>
          <option value="none">None (e.g. a brain on your tailnet)</option>
          <option value="bearer">Bearer token</option>
        </select>
      </Field>
      {mode === "bearer" && (
        <Field
          id={ids.token}
          label="Token"
          hint={editing && brain.hasToken
            ? "A token is set. Leave empty to keep it, or type a new one to replace it."
            : "Stored only on this machine, readable by you alone; never shown again."}
        >
          <input id={ids.token} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className={`${FIELD} font-mono-code`} />
        </Field>
      )}
      <details className="rounded-md border border-cc-border px-2 py-1.5">
        <summary className="text-[12px] text-cc-muted cursor-pointer">Advanced</summary>
        <div className="mt-2 space-y-2">
          <Field id={ids.mcp} label="MCP URL (override)">
            <input id={ids.mcp} value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder={`${base}/mcp`} className={`${FIELD} font-mono-code`} />
          </Field>
          <Field id={ids.health} label="Health URL (override)">
            <input id={ids.health} value={healthUrl} onChange={(e) => setHealthUrl(e.target.value)} placeholder={`${base}/healthz`} className={`${FIELD} font-mono-code`} />
          </Field>
        </div>
      </details>
      {problem && (name || baseUrl) && <p className="text-[11px] text-cc-warning">{problem}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !!problem}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          {editing ? "Save" : "Connect brain"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:bg-cc-hover cursor-pointer">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
