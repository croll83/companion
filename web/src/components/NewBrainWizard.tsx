import { useCallback, useEffect, useId, useState } from "react";
import { api, type BrainInfo, type NewBrainResult } from "../api.js";
import { brainsHash, domainsHash } from "../utils/routing.js";
import { FIELD, Field } from "./BrainForm.js";

/** The folder name the server will pick (a preview: the server decides). */
export function previewSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

const BUTTON = "px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";
const QUIET = "px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:bg-cc-hover cursor-pointer";

/** git is missing: a new wiki is a git repository, so nothing can be created until it is installed. */
function GitMissing({ onRetry, checking }: { onRetry: () => void; checking: boolean }) {
  return (
    <div role="alert" className="p-3 rounded-lg border border-cc-warning/40 bg-cc-warning/10 text-[12px] space-y-1.5">
      <p className="font-semibold">git is needed for a new brain</p>
      <p>
        A new wiki is a git repository, so every change of the wiki has a history and can be backed up. Install git on the machine
        that runs Companion, then check again.
      </p>
      <ul className="list-disc pl-5 space-y-0.5">
        <li>Linux: <code className="font-mono-code">sudo apt install git</code> (or your distribution's package manager)</li>
        <li>macOS: <code className="font-mono-code">xcode-select --install</code></li>
        <li>
          Other systems:{" "}
          <a href="https://git-scm.com/downloads" target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline">git-scm.com/downloads</a>
        </li>
      </ul>
      <button type="button" onClick={onRetry} disabled={checking} className={BUTTON}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

/** After the brain was created: where its wiki is, and that it is on no domain yet (D4). */
function Created({ result, onClose }: { result: NewBrainResult; onClose: () => void }) {
  const { brain, wiki } = result;
  return (
    <div role="status" className="space-y-2 text-[12px]">
      <p className="text-[13px] font-semibold">Brain {brain.name} is ready.</p>
      <p>
        Its wiki is <span className="font-mono-code break-all">{wiki.dir}</span>, a git repository on <span className="font-mono-code">main</span>{" "}
        (first commit <span className="font-mono-code">{wiki.commit.slice(0, 7)}</span>). Tags to start with: {wiki.tags.join(", ")}.
      </p>
      <div className="p-2.5 rounded-lg border border-cc-border space-y-1">
        <p className="font-semibold">It is off on every domain.</p>
        <p>
          To use it, open a domain in <a href={domainsHash()} className="text-cc-primary hover:underline">Domains</a> and choose{" "}
          <strong>{brain.name}</strong> under <strong>Brain</strong> (one brain per domain). Sessions of that domain get it when they
          start or reload.
        </p>
      </div>
      <p className="text-cc-muted">
        Next: give it something to read with <strong>Add source</strong> in its <strong>Inbox</strong> tab.
      </p>
      <div className="flex gap-2">
        <a href={brainsHash(brain.slug)} onClick={onClose} className={BUTTON}>Open the brain</a>
        <button type="button" onClick={onClose} className={QUIET}>Done</button>
      </div>
    </div>
  );
}

/**
 * "New brain": only a name, what it is about and optional tags. Companion
 * creates a wiki from its template (~/companion_brain_<slug>, a git
 * repository), runs an embedded brain on it (started with Companion, secrets
 * hidden) and leaves it on no domain. The folder can be changed under
 * Advanced. git is checked first: without it a blocking card explains how
 * to install it.
 */
export function NewBrainWizard({ onCreated, onClose }: { onCreated: (brain: BrainInfo) => void; onClose: () => void }) {
  const [git, setGit] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [tags, setTags] = useState("");
  const [wikiDir, setWikiDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NewBrainResult | null>(null);
  const ids = { name: useId(), about: useId(), tags: useId(), dir: useId() };

  const checkGit = useCallback(async () => {
    setChecking(true);
    try {
      setGit((await api.brainGit()).available);
    } catch {
      // Unknown: let the user try; the server answers with the reason.
      setGit(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void checkGit(); }, [checkGit]);

  const slug = previewSlug(name);
  const path = wikiDir.trim();
  const problem = !name.trim() ? "A name is required."
    : !slug ? "The name must contain letters or digits."
    : path && !path.startsWith("/") && !path.startsWith("~/") ? "The folder must be an absolute path (or start with ~/)."
    : "";

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.createNewBrain({
        name: name.trim(),
        about: about.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        ...(path ? { wikiDir: path } : {}),
      });
      setResult(r);
      onCreated(r.brain);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/git is not installed/.test(msg)) setGit(false);
      else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  if (result) return <Created result={result} onClose={onClose} />;
  if (git === false) return <GitMissing onRetry={() => void checkGit()} checking={checking} />;

  return (
    <form aria-label="New brain" className="space-y-2.5" onSubmit={(e) => { e.preventDefault(); if (!problem) void submit(); }}>
      <Field id={ids.name} label="Name">
        <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Boat" className={FIELD} />
      </Field>
      <Field id={ids.about} label="What it is about" hint="A few sentences: it becomes the wiki's Domain and tells the model when to use the brain. Its language sets how search matches words.">
        <textarea id={ids.about} value={about} onChange={(e) => setAbout(e.target.value)} rows={3} className={FIELD} />
      </Field>
      <Field id={ids.tags} label="Tags (optional)" hint="Comma-separated, e.g. engines, electronics, charter: the first tags of the wiki's taxonomy.">
        <input id={ids.tags} value={tags} onChange={(e) => setTags(e.target.value)} autoComplete="off" className={FIELD} />
      </Field>
      <details className="rounded-md border border-cc-border px-2 py-1.5">
        <summary className="text-[12px] text-cc-muted cursor-pointer">Advanced</summary>
        <div className="mt-1.5">
          <Field id={ids.dir} label="Wiki folder" hint="A new or empty folder. Deleting the brain later never deletes this folder.">
            <input
              id={ids.dir}
              value={wikiDir}
              onChange={(e) => setWikiDir(e.target.value)}
              placeholder={`~/companion_brain_${slug || "<name>"}`}
              autoComplete="off"
              className={`${FIELD} font-mono-code`}
            />
          </Field>
        </div>
      </details>
      <p className="text-[11px] text-cc-muted">
        Companion creates the wiki{path ? "" : <> in <span className="font-mono-code">~/companion_brain_{slug || "<name>"}</span></>}, starts its brain and
        leaves it off on every domain until you choose it in one.
      </p>
      {problem && name && <p className="text-[11px] text-cc-warning">{problem}</p>}
      {error && <p role="alert" className="text-[11px] text-cc-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !!problem || git === null} className={BUTTON}>
          {busy ? "Creating…" : "Create brain"}
        </button>
        <button type="button" onClick={onClose} className={QUIET}>Cancel</button>
      </div>
    </form>
  );
}
