import { useId, useState } from "react";
import { api, type BrainSourceInput } from "../api.js";
import { FIELD, Field } from "./BrainForm.js";

/** Largest source accepted (the brain checks the same limit). */
export const MAX_SOURCE_BYTES = 1_000_000;
const TEXT_FILE = /\.(md|markdown|txt|text)$/i;
const BUTTON = "px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";

type Mode = "text" | "file" | "url";

/**
 * "Add source": give the brain something to read. A text (pasted, or a
 * markdown or text file up to 1 MB) is saved by the brain in its wiki under
 * raw/sources/, and a note in the inbox asks the consolidation to turn it
 * into pages. An URL is recorded as a note only: Companion downloads nothing.
 */
export function BrainAddSource({ slug, onAdded, onCancel }: { slug: string; onAdded: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<Mode>("text");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const ids = { name: useId(), text: useId(), file: useId(), url: useId(), note: useId(), mode: useId() };

  const bytes = new TextEncoder().encode(text).length;
  const problem = mode === "url"
    ? (!/^https?:\/\/\S+$/i.test(url.trim()) ? "An http:// or https:// address is required." : "")
    : !name.trim() ? "A name is required."
    : !text.trim() ? (mode === "file" ? "Choose a markdown or text file." : "Paste the text of the source.")
    : bytes > MAX_SOURCE_BYTES ? "The source is larger than 1 MB."
    : "";

  const pickFile = async (file: File | undefined) => {
    setError("");
    if (!file) return;
    if (!TEXT_FILE.test(file.name)) {
      setError("Only markdown or text files (.md, .txt). For a PDF, paste its text instead.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError("The file is larger than 1 MB.");
      return;
    }
    setName(file.name);
    setText(await file.text());
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const input: BrainSourceInput = mode === "url"
        ? { url: url.trim(), ...(note.trim() ? { note: note.trim() } : {}) }
        : { name: name.trim(), text, ...(note.trim() ? { note: note.trim() } : {}) };
      const r = await api.addBrainSource(slug, input);
      setSaved(r.path
        ? `Saved as ${r.path}. A note in the inbox asks the consolidation to turn it into pages.`
        : "Recorded as a note in the inbox: the consolidation will read the page at that address.");
      setName("");
      setText("");
      setUrl("");
      setNote("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const modes: { value: Mode; label: string }[] = [
    { value: "text", label: "Paste text" },
    { value: "file", label: "Upload a file" },
    { value: "url", label: "Link (URL)" },
  ];

  return (
    <form aria-label="Add source" className="p-2.5 rounded-lg border border-cc-border space-y-2" onSubmit={(e) => { e.preventDefault(); if (!problem) void submit(); }}>
      <fieldset>
        <legend className="text-[11px] text-cc-muted">Kind of source</legend>
        <div className="mt-0.5 flex flex-wrap gap-3">
          {modes.map((m) => (
            <label key={m.value} className="flex items-center gap-1 text-[12px]">
              <input type="radio" name={ids.mode} value={m.value} checked={mode === m.value} onChange={() => { setMode(m.value); setSaved(""); setError(""); }} />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
      {mode === "url" ? (
        <Field id={ids.url} label="Address" hint="Companion does not download it: the consolidation reads it when it runs.">
          <input id={ids.url} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoComplete="off" className={FIELD} />
        </Field>
      ) : (
        <>
          {mode === "file" && (
            <Field id={ids.file} label="File" hint="Markdown or plain text, up to 1 MB.">
              <input id={ids.file} type="file" accept=".md,.markdown,.txt,.text,text/markdown,text/plain" onChange={(e) => void pickFile(e.target.files?.[0])} className="block text-[12px]" />
            </Field>
          )}
          <Field id={ids.name} label="Name" hint="The file becomes raw/sources/<date>-<name>.md in the wiki.">
            <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. engine manual" autoComplete="off" className={FIELD} />
          </Field>
          {mode === "text" && (
            <Field id={ids.text} label="Text">
              <textarea id={ids.text} value={text} onChange={(e) => setText(e.target.value)} rows={6} className={`${FIELD} font-mono-code`} />
            </Field>
          )}
          {mode === "file" && text && <p className="text-[11px] text-cc-muted">{Math.ceil(bytes / 1024)} KB read from the file.</p>}
        </>
      )}
      <Field id={ids.note} label="Note for the consolidation (optional)" hint="What matters in it, which pages it should update. No secrets or personal data.">
        <input id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" className={FIELD} />
      </Field>
      {problem && (name || text || url) && <p className="text-[11px] text-cc-warning">{problem}</p>}
      {error && <p role="alert" className="text-[12px] text-cc-error">{error}</p>}
      {saved && <p role="status" className="text-[12px] text-cc-success">{saved}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !!problem} className={BUTTON}>{busy ? "Saving…" : "Add source"}</button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:bg-cc-hover cursor-pointer">Close</button>
      </div>
    </form>
  );
}
