import { useEffect, useId, useState } from "react";
import { api, type DomainSummary } from "../api.js";
import { useStore } from "../store.js";

type Step =
  | { kind: "idle" }
  | { kind: "choose"; target: string }
  | { kind: "moving"; target: string }
  | { kind: "done"; to: string }
  | { kind: "error"; message: string };

const DONE_MS = 5_000;

/**
 * The focused session's domain, in the session panel. A domain session can
 * move to another domain ("Change domain"): from the restart on, its memory,
 * skills, MCP servers and instructions are the new domain's (same
 * conversation, same folder). Sessions from before domains show a "legacy
 * memory" badge: they keep their folder-based memory and spawn as before
 * until they are migrated on purpose ("Migrate to domain", any domain
 * including GLOBAL). Works for Claude Code and Codex sessions.
 */
export function SessionDomain({ sessionId }: { sessionId: string }) {
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const domain = sdk?.domain || "global";
  const legacy = sdk?.legacyMemory === true || !sdk?.domain;
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const selectId = useId();

  useEffect(() => setStep({ kind: "idle" }), [sessionId]);

  useEffect(() => {
    let alive = true;
    api.listDomains().then((res) => { if (alive) setDomains(res.domains); }).catch(() => {});
    return () => { alive = false; };
  }, [sessionId]);

  useEffect(() => {
    if (step.kind !== "done") return;
    const timer = setTimeout(() => setStep({ kind: "idle" }), DONE_MS);
    return () => clearTimeout(timer);
  }, [step.kind]);

  const nameOf = (slug: string) => domains.find((d) => d.slug === slug)?.name ?? (slug === "global" ? "GLOBAL" : slug);
  // A legacy session is not really in GLOBAL yet, so it can migrate there too.
  const others = legacy ? domains : domains.filter((d) => d.slug !== domain);

  async function move(target: string) {
    setStep({ kind: "moving", target });
    try {
      await (legacy ? api.migrateSessionToDomain(sessionId, target) : api.changeSessionDomain(sessionId, target));
      setStep({ kind: "done", to: target });
      api.listSessions().then((list) => useStore.getState().setSdkSessions(list)).catch(() => {});
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <section aria-label="Session domain" className="shrink-0 px-4 py-2.5 border-b border-cc-separator">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Domain</h3>
          <p className="text-[11px] text-cc-fg flex items-center gap-1.5 min-w-0">
            <span className="truncate">{nameOf(domain)}</span>
            {legacy && (
              <span
                className="shrink-0 px-1.5 py-px rounded-full text-[10px] bg-cc-warning/15 text-cc-warning"
                title="Started before domains: it keeps its own folder-based memory and is not changed by domain settings"
              >
                legacy memory
              </span>
            )}
          </p>
        </div>
        {(step.kind === "idle" || step.kind === "done" || step.kind === "error") && others.length > 0 && (
          <button
            type="button"
            onClick={() => setStep({ kind: "choose", target: others[0].slug })}
            className="shrink-0 text-[11px] px-2 py-0.5 rounded-md text-cc-primary hover:bg-cc-primary/10 cursor-pointer"
          >
            {legacy ? "Migrate to domain" : "Change domain"}
          </button>
        )}
      </div>

      {(step.kind === "choose" || step.kind === "moving") && (
        <div
          className="mt-2 space-y-1.5 text-[11px]"
          role="group"
          aria-label={legacy ? "Migrate the session into a domain" : "Change the session's domain"}
        >
          <label htmlFor={selectId} className="block text-cc-muted">{legacy ? "Migrate to domain" : "Move to domain"}</label>
          <select
            id={selectId}
            value={step.target}
            disabled={step.kind === "moving"}
            onChange={(e) => setStep({ kind: "choose", target: e.target.value })}
            className="w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary"
          >
            {others.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </select>
          {legacy ? (
            <p className="text-cc-warning">
              The CLI restarts on the same conversation and folder, but from then on it reads the memory, skills, MCP
              servers and instructions of the domain. Its old folder memory is no longer read: copy the notes to keep into
              the domain memory first.
            </p>
          ) : (
            <p className="text-cc-warning">
              The CLI restarts on the same conversation and folder, but from then on it reads the memory, skills, MCP servers
              and instructions of the new domain, not of {nameOf(domain)}.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => move(step.target)}
              disabled={step.kind === "moving"}
              className="px-2.5 py-1 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {step.kind === "moving"
                ? (legacy ? "Migrating..." : "Moving...")
                : (legacy ? "Migrate and restart" : "Move and restart")}
            </button>
            <button
              type="button"
              onClick={() => setStep({ kind: "idle" })}
              disabled={step.kind === "moving"}
              className="px-2.5 py-1 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {step.kind === "done" && (
        <p role="status" className="mt-1 text-[11px] text-cc-success">Moved to {nameOf(step.to)}. The CLI is restarting.</p>
      )}
      {step.kind === "error" && <p role="alert" className="mt-1 text-[11px] text-cc-error">{step.message}</p>}
    </section>
  );
}
