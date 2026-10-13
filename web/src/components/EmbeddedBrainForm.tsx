import { useId, useState } from "react";
import type { BrainInfo, BrainInput, BrainLanguage, EmbeddedBrainInput } from "../api.js";
import { FIELD, Field } from "./BrainForm.js";

const LANGUAGES: { value: BrainLanguage; label: string }[] = [
  { value: "auto", label: "Italian and English (mixed wiki)" },
  { value: "en", label: "English" },
  { value: "it", label: "Italian" },
  { value: "none", label: "Other (no stemming)" },
];

/**
 * "Embedded brain (existing wiki folder)" (no `brain`) and its edit form
 * (with one). Companion runs the brain server itself on a wiki folder of this
 * machine (SCHEMA.md and index.md at its root; Companion never writes it).
 * Creating a new wiki from a template comes later. The folder of an
 * existing brain cannot change: another folder is another brain.
 */
export function EmbeddedBrainForm({
  brain,
  busy,
  onSubmit,
  onCancel,
}: {
  brain?: BrainInfo;
  busy: boolean;
  onSubmit: (input: EmbeddedBrainInput | BrainInput) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(brain?.name ?? "");
  const [about, setAbout] = useState(brain?.about ?? "");
  const [wikiDir, setWikiDir] = useState(brain?.embedded?.wikiDir ?? "");
  const [language, setLanguage] = useState<BrainLanguage>(brain?.embedded?.language ?? "auto");
  const [redactSecrets, setRedactSecrets] = useState(brain?.embedded?.redactSecrets ?? true);
  const [autostart, setAutostart] = useState(brain?.embedded?.autostart ?? true);
  const ids = { name: useId(), about: useId(), dir: useId(), lang: useId(), redact: useId(), auto: useId() };
  const editing = !!brain;

  const path = wikiDir.trim();
  const problem = !name.trim() ? "A name is required."
    : !path ? "The wiki folder is required."
    : !path.startsWith("/") && !path.startsWith("~/") ? "The wiki folder must be an absolute path (or start with ~/)."
    : "";

  const submit = () => {
    if (editing) {
      void onSubmit({ name: name.trim(), about: about.trim(), language, redactSecrets, autostart });
      return;
    }
    void onSubmit({ kind: "embedded", name: name.trim(), about: about.trim(), wikiDir: path, language, redactSecrets });
  };

  return (
    <form
      aria-label={editing ? `Edit brain ${brain.name}` : "Embedded brain"}
      className="space-y-2.5"
      onSubmit={(e) => { e.preventDefault(); if (!problem) submit(); }}
    >
      <Field id={ids.name} label="Name">
        <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work" className={FIELD} />
      </Field>
      <Field
        id={ids.dir}
        label="Wiki folder"
        hint={editing
          ? "Fixed for this brain: another folder is another brain."
          : "An existing wiki on this machine: a folder with SCHEMA.md and index.md at its root. Companion only reads it."}
      >
        <input
          id={ids.dir}
          value={wikiDir}
          onChange={(e) => setWikiDir(e.target.value)}
          readOnly={editing}
          placeholder="~/wiki"
          autoComplete="off"
          className={`${FIELD} font-mono-code ${editing ? "opacity-70" : ""}`}
        />
      </Field>
      <Field id={ids.about} label="What it is about" hint="Tells the model when to use the brain (the skill's description).">
        <textarea id={ids.about} value={about} onChange={(e) => setAbout(e.target.value)} rows={3} className={FIELD} />
      </Field>
      <Field id={ids.lang} label="Language of the wiki" hint="How search matches word forms (servizio / servizi, invoice / invoices).">
        <select id={ids.lang} value={language} onChange={(e) => setLanguage(e.target.value as BrainLanguage)} className={FIELD}>
          {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </Field>
      <div className="flex items-start gap-2">
        <input id={ids.redact} type="checkbox" checked={redactSecrets} onChange={(e) => setRedactSecrets(e.target.checked)} className="mt-0.5" />
        <label htmlFor={ids.redact} className="text-[12px] leading-snug">
          Hide secrets
          <span className="block text-[10px] text-cc-muted">Tokens and passwords found in the wiki reach sessions as [REDACTED].</span>
        </label>
      </div>
      {editing && (
        <div className="flex items-start gap-2">
          <input id={ids.auto} type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} className="mt-0.5" />
          <label htmlFor={ids.auto} className="text-[12px] leading-snug">Start with Companion</label>
        </div>
      )}
      {problem && (name || wikiDir) && <p className="text-[11px] text-cc-warning">{problem}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !!problem}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          {editing ? "Save" : busy ? "Starting…" : "Create brain"}
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
