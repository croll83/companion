import { useState } from "react";
import { api, type BrainAdoptCheck, type BrainInfo, type BrainInput, type BrainLintFixId, type EmbeddedBrainInput } from "../api.js";
import { brainsHash } from "../utils/routing.js";
import { EmbeddedBrainForm } from "./EmbeddedBrainForm.js";
import { AdviceItem, WikiCheck } from "./WikiCheck.js";

const BUTTON = "px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";

/**
 * "Adopt existing folder": an embedded brain on a wiki folder of this
 * machine, guided in three steps:
 *  1. the form (name, folder, about, language, hide secrets);
 *  2. if the folder lacks SCHEMA.md or index.md (the brain cannot start
 *     without them), what is missing, with a button that creates each one;
 *  3. once the brain runs, its lint as sentences with one-click fixes
 *     (WikiCheck), then "Done" opens the brain.
 */
export function AdoptBrainFlow({ onCreated, onClose }: { onCreated: (brain: BrainInfo) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ input: EmbeddedBrainInput; check: BrainAdoptCheck } | null>(null);
  const [created, setCreated] = useState<BrainInfo | null>(null);

  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = (input: EmbeddedBrainInput) => attempt(async () => {
    const brain = await api.createBrain(input);
    setPending(null);
    setCreated(brain);
    onCreated(brain);
  });

  const submit = (input: EmbeddedBrainInput | BrainInput) => attempt(async () => {
    const e = input as EmbeddedBrainInput;
    const check = await api.checkAdoptFolder({ wikiDir: e.wikiDir });
    if (check.ready) await create(e);
    else setPending({ input: e, check });
  });

  const fix = (id: BrainLintFixId) => attempt(async () => {
    if (!pending) return;
    const { input } = pending;
    const check = await api.checkAdoptFolder({ wikiDir: input.wikiDir, fix: id, name: input.name, about: input.about });
    setPending({ input, check });
  });

  if (created) {
    return (
      <div className="space-y-3">
        <p role="status" className="text-[12px]">
          Brain <strong>{created.name}</strong> runs on <span className="font-mono-code break-all">{created.embedded?.wikiDir}</span>. It is off on
          every domain until you choose it in one. Here is what its check found in the wiki:
        </p>
        <WikiCheck slug={created.slug} autoRun />
        <a href={brainsHash(created.slug)} onClick={onClose} className={`inline-block ${BUTTON}`}>Done</a>
      </div>
    );
  }

  if (pending) {
    const { check, input } = pending;
    return (
      <div className="space-y-2">
        <p className="text-[12px]">
          <span className="font-mono-code break-all">{check.path}</span> is not a brain wiki yet: the brain needs these files at its root.
          Companion can create them (nothing in the folder is changed or deleted).
        </p>
        {check.done && <p role="status" className="text-[12px] text-cc-success">{check.done}.</p>}
        <ul className="space-y-1.5">
          {check.advice.map((a) => <AdviceItem key={a.id} advice={a} busy={busy} onFix={(id) => void fix(id)} />)}
        </ul>
        {error && <p role="alert" className="text-[12px] text-cc-error">{error}</p>}
        <div className="flex gap-2">
          <button type="button" disabled={busy || !check.ready} onClick={() => void create(input)} className={BUTTON}>
            {busy ? "Working…" : "Create brain"}
          </button>
          <button type="button" onClick={() => setPending(null)} className="px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:bg-cc-hover cursor-pointer">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <EmbeddedBrainForm busy={busy} onSubmit={submit} onCancel={onClose} />
      {error && <p role="alert" className="text-[12px] text-cc-error">{error}</p>}
    </div>
  );
}
