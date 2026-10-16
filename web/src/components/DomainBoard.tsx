import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BoardIssue, type BoardSession, type DomainBoard as Board, type TakenIssue } from "../api.js";
import { boardColumns, initials, labelText, setLinearHandoff, toLinearIssue } from "../utils/linear-board.js";
import { domainsHash, sessionHash } from "../utils/routing.js";

/** How often an open board re-reads Linear (the server caches 30 s on top). */
export const BOARD_POLL_MS = 60_000;

const PRIORITY: Record<number, { label: string; className: string }> = {
  1: { label: "Urgent", className: "text-cc-error" },
  2: { label: "High", className: "text-cc-warning" },
  3: { label: "Medium", className: "text-cc-fg" },
  4: { label: "Low", className: "text-cc-muted" },
};

/**
 * The Linear board of a domain (#/domains/<slug>/board): the linked team's
 * workflow states as columns (canceled/duplicate behind a toggle), the
 * project's (or team's) issues as cards, with the Companion sessions linked
 * to each. Data is read live from Linear with the domain's connection, so
 * teammates on the same workspace see the same board; it polls every minute
 * while the tab is visible. "Take it" assigns an issue to me, starts it, and
 * offers to start a session in this domain linked to it (Claude Code or
 * Codex: the Home page flow is the same for both).
 */
export function DomainBoard({ slug, domainName, linked }: { slug: string; domainName: string; linked: boolean }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mine, setMine] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [busyIssue, setBusyIssue] = useState("");
  const [taken, setTaken] = useState<{ issue: TakenIssue; connectionId: string } | null>(null);
  const [notLinked, setNotLinked] = useState(!linked);
  const loadingRef = useRef(false);

  const load = useCallback(async (refresh = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await api.getDomainBoard(slug, refresh);
      setBoard(res);
      setError("");
      setNotLinked(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not linked/i.test(msg)) setNotLinked(true);
      else setError(msg);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    setNotLinked(!linked);
    if (!linked) return;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, BOARD_POLL_MS);
    return () => clearInterval(timer);
  }, [linked, load]);

  async function move(issue: BoardIssue, stateId: string) {
    setBusyIssue(issue.id);
    setError("");
    try {
      await api.moveDomainIssue(slug, issue.id, stateId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyIssue("");
    }
  }

  async function take(issue: BoardIssue) {
    setBusyIssue(issue.id);
    setError("");
    try {
      const res = await api.takeDomainIssue(slug, issue.id);
      setTaken({ issue: res.issue, connectionId: res.connectionId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyIssue("");
    }
  }

  function startSession() {
    if (!taken) return;
    setLinearHandoff({ domain: slug, connectionId: taken.connectionId, issue: toLinearIssue(taken.issue, taken.connectionId) });
    window.location.hash = "#/";
  }

  if (notLinked) {
    return (
      <section aria-label="Linear board" className="text-[12px] space-y-1">
        <p>{domainName} is not linked to Linear yet.</p>
        <p className="text-cc-muted">
          Link it to a team (and optionally a project) in the <a href={domainsHash(slug, "linear")} className="text-cc-primary hover:underline">Linear tab</a> to
          see its issues here, take them and start sessions on them.
        </p>
      </section>
    );
  }

  const columns = board ? boardColumns(board.states, board.issues, { showHidden, mineId: mine ? board.viewer.id : undefined }) : [];
  const toggleClass = (on: boolean) =>
    `px-2 py-1 rounded-md border text-[11px] cursor-pointer ${on ? "border-cc-primary/40 bg-cc-primary/10 text-cc-primary" : "border-cc-border text-cc-muted hover:text-cc-fg"}`;

  return (
    <section aria-label="Linear board" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {board && (
          <span className="text-cc-muted">
            {board.team.key} · {board.link.projectName ?? "whole team"} · {board.link.workspaceName || board.link.connectionName}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" aria-pressed={mine} onClick={() => setMine(!mine)} className={toggleClass(mine)}>Mine</button>
        <button type="button" aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)} className={toggleClass(showHidden)}>Show canceled</button>
        <button type="button" onClick={() => void load(true)} disabled={loading} className="px-2 py-1 rounded-md border border-cc-border text-cc-muted hover:text-cc-fg disabled:opacity-50 cursor-pointer">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p role="alert" className="text-[12px] text-cc-error">{error}</p>}
      {!board && !error && <p className="text-[12px] text-cc-muted">Loading the board…</p>}
      {board?.truncated && <p className="text-[11px] text-cc-muted">Showing the most recently updated issues only.</p>}

      {taken && (
        <div role="status" className="rounded-lg border border-cc-primary/30 bg-cc-primary/5 p-2.5 text-[12px] flex flex-wrap items-center gap-2">
          <span className="flex-1 min-w-0">
            <span className="font-mono-code">{taken.issue.identifier}</span> is yours ({taken.issue.stateName}). Start a session in {domainName} linked to it?
          </span>
          <button type="button" onClick={startSession} className="px-2.5 py-1 rounded-md bg-cc-primary text-white cursor-pointer">Start a session</button>
          <button type="button" onClick={() => setTaken(null)} className="px-2.5 py-1 rounded-md text-cc-muted hover:bg-cc-hover cursor-pointer">Not now</button>
        </div>
      )}

      {board && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {columns.map(({ state, issues }) => (
            <section key={state.id} aria-label={`${state.name} (${issues.length})`} className="w-64 shrink-0 rounded-lg bg-cc-hover/40 p-1.5">
              <h4 className="px-1 pb-1 text-[11px] font-semibold text-cc-muted">
                {state.name} <span className="font-normal">{issues.length}</span>
              </h4>
              <ul className="space-y-1.5">
                {issues.map((issue) => (
                  <li key={issue.id}>
                    <IssueCard
                      issue={issue}
                      board={board}
                      sessions={board.sessions[issue.id] ?? []}
                      busy={busyIssue === issue.id}
                      onMove={(stateId) => void move(issue, stateId)}
                      onTake={() => void take(issue)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function IssueCard({
  issue,
  board,
  sessions,
  busy,
  onMove,
  onTake,
}: {
  issue: BoardIssue;
  board: Board;
  sessions: BoardSession[];
  busy: boolean;
  onMove: (stateId: string) => void;
  onTake: () => void;
}) {
  const mineAndStarted = issue.assignee?.id === board.viewer.id && !["triage", "backlog", "unstarted"].includes(issue.stateType);
  const priority = PRIORITY[issue.priority];
  return (
    <article aria-label={`${issue.identifier} ${issue.title}`} className="rounded-md border border-cc-border bg-cc-card p-2 text-[12px] space-y-1.5">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <span className="font-mono-code text-[10px] text-cc-muted">{issue.identifier}</span>
          {priority && <span className={`ml-1.5 text-[10px] ${priority.className}`}>{priority.label}</span>}
          <p className="leading-snug break-words">{issue.title}</p>
        </div>
        <Assignee assignee={issue.assignee} />
      </div>

      {issue.labels.length > 0 && (
        <ul aria-label="Labels" className="flex flex-wrap gap-1">
          {issue.labels.map((l) => (
            <li key={l.id} className="inline-flex items-center gap-1 px-1.5 rounded-full border border-cc-border text-[10px] text-cc-muted">
              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: l.color || "currentColor" }} />
              {labelText(l)}
            </li>
          ))}
        </ul>
      )}

      {sessions.length > 0 && (
        <ul aria-label="Sessions" className="space-y-0.5">
          {sessions.map((s) => (
            <li key={s.sessionId} className="text-[11px] truncate">
              <a href={sessionHash(s.sessionId)} className="text-cc-primary hover:underline">{s.name}</a>
              <span className="text-cc-muted"> · {s.backendType === "codex" ? "Codex" : "Claude"}{s.archived ? " · archived" : ""}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <select
          aria-label={`Move ${issue.identifier} to`}
          value={issue.stateId}
          disabled={busy}
          onChange={(e) => onMove(e.target.value)}
          className="min-w-0 flex-1 px-1 py-0.5 rounded bg-cc-input-bg border border-cc-border text-[11px] text-cc-fg"
        >
          {board.states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {!mineAndStarted && (
          <button type="button" onClick={onTake} disabled={busy} className="px-1.5 py-0.5 rounded bg-cc-primary/15 text-cc-primary text-[11px] hover:bg-cc-primary/25 disabled:opacity-50 cursor-pointer">
            Take it
          </button>
        )}
        <a href={issue.url} target="_blank" rel="noreferrer" className="text-[11px] text-cc-muted hover:text-cc-fg">
          Open in Linear<span className="sr-only"> ({issue.identifier})</span>
        </a>
      </div>
    </article>
  );
}

function Assignee({ assignee }: { assignee: BoardIssue["assignee"] }) {
  if (!assignee) return <span className="text-[10px] text-cc-muted shrink-0">Unassigned</span>;
  return (
    <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-cc-muted" title={assignee.name}>
      {assignee.avatarUrl ? (
        <img src={assignee.avatarUrl} alt="" className="w-4 h-4 rounded-full" />
      ) : (
        <span aria-hidden="true" className="w-4 h-4 rounded-full bg-cc-hover inline-flex items-center justify-center text-[8px]">{initials(assignee.name)}</span>
      )}
      <span className="max-w-[72px] truncate">{assignee.name}</span>
    </span>
  );
}
