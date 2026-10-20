import { useCallback, useEffect, useId, useState } from "react";
import { api, type LocalProviderInput, type LocalProviderView } from "../api.js";

/**
 * Settings → Providers → Local LLM (shown once "Enable local LLM" is on):
 * the Companion LLM proxies (tools/llm-proxy, running next to vLLM) that new
 * sessions can run on instead of the Anthropic account. Such a session is
 * still Claude Code, pointed at the proxy, so domains, memory, brains,
 * skills and MCP keep working.
 *
 * "Test" reads the proxy's GET /info and fills the models, the context
 * window and the reasoning levels (Claude Code effort value = model level,
 * the mapping the proxy applies); they can still be edited by hand.
 *
 * The token is write-only: the API never returns it (only `hasToken`), so
 * the form leaves the field empty and "keeps" the saved one unless a new
 * one is typed or "Remove the saved token" is ticked.
 */

interface FormState {
  name: string;
  baseUrl: string;
  token: string;
  clearToken: boolean;
  models: string;
  modelsManual: boolean;
  defaultModel: string;
  contextWindow: string;
  /** "low=off, medium=low, high=medium, xhigh=xhigh": Claude Code effort value = model level. */
  levels: string;
  defaultEffort: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  baseUrl: "",
  token: "",
  clearToken: false,
  models: "",
  modelsManual: false,
  defaultModel: "",
  contextWindow: "131072",
  levels: "low=off, medium=low, high=medium, xhigh=xhigh",
  defaultEffort: "high",
};

/** "low=off, high" → [["low","off"], ["high","high"]] */
export function parseLevels(text: string): [string, string][] {
  return text.split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [value, label] = pair.split("=").map((x) => x.trim());
    return [value, label || value];
  });
}

const levelsText = (levels: string[], labels: Record<string, string> = {}) =>
  levels.map((l) => (labels[l] && labels[l] !== l ? `${l}=${labels[l]}` : l)).join(", ");

function formOf(p: LocalProviderView): FormState {
  return {
    name: p.name,
    baseUrl: p.baseUrl,
    token: "",
    clearToken: false,
    models: p.models.join(", "),
    modelsManual: !!p.modelsManual,
    defaultModel: p.defaultModel ?? "",
    contextWindow: String(p.contextWindow),
    levels: levelsText(p.effortLevels, p.effortLabels),
    defaultEffort: p.defaultEffort ?? "",
  };
}

const splitList = (text: string) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/** The request body of the form, or an error to show. */
export function inputOf(form: FormState, editing: boolean): LocalProviderInput | string {
  const levels = parseLevels(form.levels);
  const input: LocalProviderInput = {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    models: splitList(form.models),
    modelsManual: form.modelsManual,
    defaultModel: form.defaultModel || null,
    contextWindow: Number(form.contextWindow),
    effortLevels: levels.map(([v]) => v),
    effortLabels: Object.fromEntries(levels),
    defaultEffort: form.defaultEffort || null,
  };
  if (form.token.trim()) input.token = form.token.trim();
  else if (editing && form.clearToken) input.token = "";
  return input;
}

function HealthBadge({ p }: { p: LocalProviderView }) {
  const s = p.health.status;
  const cls = s === "online" ? "text-cc-success bg-cc-success/10" : s === "offline" ? "text-cc-error bg-cc-error/10" : "text-cc-muted bg-cc-hover";
  return (
    <span className={`text-[10px] font-medium px-1.5 rounded-full leading-[16px] ${cls}`} title={p.health.error ?? undefined}>
      {s}
    </span>
  );
}

function ProviderForm({ editing, onSaved, onCancel }: { editing: LocalProviderView | null; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<FormState>(() => (editing ? formOf(editing) : EMPTY_FORM));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");
  const id = useId();
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const levels = parseLevels(form.levels);
  const models = splitList(form.models);

  async function test() {
    setTestResult("Testing…");
    try {
      const r = await api.testLocalProvider({ baseUrl: form.baseUrl, token: form.token || undefined, id: editing?.id });
      if (r.ok) {
        setTestResult(`Online${r.viaProxy ? " (Companion LLM proxy)" : " (not the Companion proxy: levels are not mapped)"} · ${r.models.length} model(s) in ${r.latencyMs} ms${r.models.length ? `: ${r.models.join(", ")}` : ""}`);
        setForm((f) => ({
          ...f,
          ...(!f.modelsManual && r.models.length > 0 ? { models: r.models.join(", ") } : {}),
          ...(r.contextWindow ? { contextWindow: String(r.contextWindow) } : {}),
          ...(r.effort && r.effort.levels.length > 0
            ? {
              levels: r.effort.levels.map((l) => (l.name === l.claude ? l.claude : `${l.claude}=${l.name}`)).join(", "),
              defaultEffort: r.effort.default ?? "",
            }
            : {}),
        }));
      } else {
        setTestResult(`Not reachable: ${r.error}`);
      }
    } catch (e) {
      setTestResult(`Not reachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function save() {
    const input = inputOf(form, !!editing);
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (editing) await api.updateLocalProvider(editing.id, input);
      else await api.createLocalProvider(input);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60";
  return (
    <form
      className="space-y-3 rounded-xl border border-cc-border p-3 sm:p-4"
      aria-label={editing ? `Edit ${editing.name}` : "New local provider"}
      onSubmit={(e) => { e.preventDefault(); void save(); }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          Name
          <input className={`${field} mt-1`} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="My vLLM" required />
        </label>
        <label className="block text-xs font-medium">
          Proxy URL
          <input className={`${field} mt-1`} value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="http://<proxy-host>:8787" required />
        </label>
        <label className="block text-xs font-medium">
          Proxy token
          <input
            type="password"
            autoComplete="off"
            className={`${field} mt-1`}
            value={form.token}
            onChange={(e) => set("token", e.target.value)}
            placeholder={editing?.hasToken ? "Saved — type to replace" : "The proxy's shared token"}
          />
        </label>
        <label className="block text-xs font-medium">
          Context window (tokens)
          <input type="number" min={32768} className={`${field} mt-1`} value={form.contextWindow} onChange={(e) => set("contextWindow", e.target.value)} />
        </label>
      </div>
      {editing?.hasToken && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={form.clearToken} onChange={(e) => set("clearToken", e.target.checked)} />
          Remove the saved token
        </label>
      )}
      <div>
        <label className="block text-xs font-medium" htmlFor={`${id}-models`}>Models</label>
        <div className="flex gap-2 mt-1">
          <input id={`${id}-models`} className={field} value={form.models} onChange={(e) => set("models", e.target.value)} placeholder="Read from GET /v1/models, or type them" />
          <button type="button" onClick={() => void test()} className="shrink-0 px-3 py-2 text-xs rounded-lg border border-cc-border hover:bg-cc-hover cursor-pointer">
            Test
          </button>
        </div>
        {testResult && <p className="mt-1 text-[11px] text-cc-muted" role="status">{testResult}</p>}
        <label className="flex items-center gap-2 mt-1 text-xs">
          <input type="checkbox" checked={form.modelsManual} onChange={(e) => set("modelsManual", e.target.checked)} />
          Keep this list (do not replace it with the server&apos;s)
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          Default model
          <select className={`${field} mt-1`} value={form.defaultModel} onChange={(e) => set("defaultModel", e.target.value)}>
            <option value="">First in the list</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium">
          Reasoning levels
          <input className={`${field} mt-1`} value={form.levels} onChange={(e) => set("levels", e.target.value)} placeholder="low=off, medium=low, high=medium, xhigh=xhigh" />
        </label>
        <label className="block text-xs font-medium">
          Default level
          <select className={`${field} mt-1`} value={form.defaultEffort} onChange={(e) => set("defaultEffort", e.target.value)}>
            <option value="">None</option>
            {levels.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-cc-muted">
        Levels are <code>claude effort=model level</code>: Claude Code sends its effort (low, medium, high, xhigh, max) with
        every request and the proxy turns it into the model&apos;s setting, so changing the level in a session applies to
        its next request. &quot;Test&quot; reads them from the proxy.
      </p>
      {error && <p className="text-xs text-cc-error" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 cursor-pointer">
          {busy ? "Saving…" : editing ? "Save" : "Add provider"}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-2 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function LocalProvidersSettings() {
  const [providers, setProviders] = useState<LocalProviderView[] | null>(null);
  const [editing, setEditing] = useState<LocalProviderView | "new" | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      setProviders(await api.listLocalProviders());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function remove(p: LocalProviderView) {
    if (!window.confirm(`Delete the local provider "${p.name}"? Sessions on it can no longer start.`)) return;
    try {
      await api.deleteLocalProvider(p.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function refresh(p: LocalProviderView) {
    setNote("");
    try {
      const r = await api.refreshLocalProvider(p.id);
      setNote(r.ok ? `${p.name}: ${r.provider.models.length} model(s), ${r.provider.effortLevels.length} level(s)` : `${p.name}: ${r.error}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-cc-muted">
        Each provider is a Companion LLM proxy running next to your model server (vLLM). Sessions keep domains, memory,
        brains, skills and MCP; pick &quot;Local&quot; when you start one.
      </p>
      {error && <p className="text-xs text-cc-error" role="alert">{error}</p>}
      {note && <p className="text-xs text-cc-muted" role="status">{note}</p>}
      {providers && providers.length === 0 && editing === null && (
        <p className="text-xs text-cc-muted">No local provider yet.</p>
      )}
      {providers && providers.length > 0 && (
        <ul className="space-y-2" aria-label="Local providers">
          {providers.map((p) => (
            <li key={p.id} className="rounded-xl border border-cc-border p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{p.name}</span>
                <HealthBadge p={p} />
                <span className="text-[11px] text-cc-muted truncate">{p.baseUrl}</span>
              </div>
              <p className="mt-1 text-[11px] text-cc-muted">
                {p.models.length ? p.models.join(", ") : "No model yet"} · {Math.round(p.contextWindow / 1024)}k context
                {p.effortLevels.length > 0 && ` · levels ${p.effortLevels.map((l) => p.effortLabels?.[l] ?? l).join("/")}`}
                {p.hasToken && " · token saved"}
                {p.health.error && ` · ${p.health.error}`}
              </p>
              <div className="mt-2 flex gap-1.5 flex-wrap">
                <button type="button" onClick={() => setEditing(p)} className="px-2.5 py-1.5 text-xs rounded-md border border-cc-border hover:bg-cc-hover cursor-pointer" aria-label={`Edit ${p.name}`}>
                  Edit
                </button>
                <button type="button" onClick={() => void refresh(p)} className="px-2.5 py-1.5 text-xs rounded-md border border-cc-border hover:bg-cc-hover cursor-pointer" aria-label={`Refresh ${p.name} from its proxy`}>
                  Refresh
                </button>
                <button type="button" onClick={() => void remove(p)} className="px-2.5 py-1.5 text-xs rounded-md border border-cc-error/30 text-cc-error hover:bg-cc-error/10 cursor-pointer" aria-label={`Delete ${p.name}`}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <ProviderForm
          key={editing === "new" ? "new" : editing.id}
          editing={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
        >
          Add local provider
        </button>
      )}
    </div>
  );
}
