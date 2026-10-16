import { useCallback, useEffect, useId, useState } from "react";
import {
  api,
  type DomainLinearInfo,
  type DomainLinearInput,
  type EffectiveLinearRule,
  type LinearConnectionSummary,
  type LinearProject,
  type LinearTeamStates,
} from "../api.js";
import { domainsHash } from "../utils/routing.js";

const INHERIT = "__inherit__";
const OFF = "__off__";
const WHOLE_TEAM = "";

type RuleChoice = string; // INHERIT, OFF or a state id

function ruleChoice(rule: { enabled: boolean; stateId: string } | undefined): RuleChoice {
  if (!rule) return INHERIT;
  return rule.enabled && rule.stateId ? rule.stateId : OFF;
}

function ruleInput(choice: RuleChoice): DomainLinearInput["autoTransition"] {
  if (choice === INHERIT) return null;
  if (choice === OFF) return { enabled: false };
  return { enabled: true, stateId: choice };
}

/** "the connection's setting (In Progress)" / "(off)" for the inherit option. */
function inheritedLabel(rule: EffectiveLinearRule | undefined): string {
  if (!rule || rule.source === "domain") return "Connection default";
  return `Connection default (${rule.enabled && rule.stateId ? rule.stateName || "a state" : "off"})`;
}

const selectClass =
  "px-1.5 py-1 rounded-md bg-cc-input-bg border border-cc-border text-[12px] text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary max-w-full";

/**
 * The Linear link of one domain: which connection (workspace), team and
 * optionally project its board and Home page issue picker use, and the
 * per-domain transition rules (on session start, on archive). Rules left on
 * "Connection default" keep the connection's setting, which is how every
 * domain behaves until it chooses (no migration needed). Applies to Claude
 * Code and Codex sessions alike.
 */
export function DomainLinear({ slug, onChanged }: { slug: string; onChanged: () => void }) {
  const ids = { conn: useId(), team: useId(), project: useId(), start: useId(), archive: useId() };
  const [info, setInfo] = useState<DomainLinearInfo | null>(null);
  const [connections, setConnections] = useState<LinearConnectionSummary[] | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [teams, setTeams] = useState<LinearTeamStates[]>([]);
  const [teamId, setTeamId] = useState("");
  const [projects, setProjects] = useState<LinearProject[]>([]);
  const [projectId, setProjectId] = useState(WHOLE_TEAM);
  const [start, setStart] = useState<RuleChoice>(INHERIT);
  const [archive, setArchive] = useState<RuleChoice>(INHERIT);
  const [loading, setLoading] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.getDomainLinear(slug), api.listLinearConnections()])
      .then(([linkInfo, { connections: conns }]) => {
        setInfo(linkInfo);
        setConnections(conns);
        const link = linkInfo.link;
        setConnectionId(link && !link.broken ? link.connectionId : conns[0]?.id ?? "");
        setTeamId(link && !link.broken ? link.teamId : "");
        setProjectId(link?.projectId ?? WHOLE_TEAM);
        setStart(ruleChoice(link?.autoTransition));
        setArchive(ruleChoice(link?.archiveTransition));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Teams (with their workflow states) of the chosen connection.
  useEffect(() => {
    if (!connectionId) { setTeams([]); return; }
    let active = true;
    setLoading("teams");
    api.getLinearStates(connectionId)
      .then(({ teams: list }) => { if (active) setTeams(list); })
      .catch((e: unknown) => { if (active) { setTeams([]); setError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (active) setLoading(""); });
    return () => { active = false; };
  }, [connectionId]);

  // Projects of the chosen team.
  useEffect(() => {
    if (!connectionId || !teamId) { setProjects([]); return; }
    let active = true;
    api.listLinearTeamProjects(teamId, connectionId)
      .then(({ projects: list }) => { if (active) setProjects(list); })
      .catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [connectionId, teamId]);

  const link = info?.link ?? null;
  const team = teams.find((t) => t.id === teamId);
  // Rules name states of the saved team: changing the team resets them.
  const sameTeam = !!link && link.connectionId === connectionId && link.teamId === teamId;
  const resetRules = () => { setStart(INHERIT); setArchive(INHERIT); };

  async function save() {
    if (!connectionId || !teamId) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api.setDomainLinear(slug, {
        connectionId,
        teamId,
        ...(projectId ? { projectId } : {}),
        autoTransition: ruleInput(start),
        archiveTransition: ruleInput(archive),
      });
      setSaved(true);
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function unlink() {
    setSaving(true);
    setError("");
    try {
      await api.clearDomainLinear(slug);
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!info || !connections) {
    return error ? <p role="alert" className="text-[12px] text-cc-error">{error}</p> : <p className="text-[12px] text-cc-muted">Loading Linear…</p>;
  }

  if (connections.length === 0) {
    return (
      <section aria-label="Linear link" className="text-[12px] space-y-1">
        <p>No Linear connection yet.</p>
        <p className="text-cc-muted">
          Add one (an API key per workspace) in <a href="#/integrations/linear" className="text-cc-primary hover:underline">Linear settings</a>, then link this domain to a team.
        </p>
      </section>
    );
  }

  const ruleSelect = (id: string, label: string, value: RuleChoice, onChange: (v: RuleChoice) => void, effective?: EffectiveLinearRule) => (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-[12px] w-40 shrink-0">{label}</label>
      <select id={id} value={value} disabled={saving || !team} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value={INHERIT}>{sameTeam ? inheritedLabel(effective) : "Connection default"}</option>
        <option value={OFF}>Off</option>
        {team?.states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );

  return (
    <section aria-label="Linear link" className="space-y-3 text-[12px]">
      <p className="text-cc-muted leading-snug">
        Link this domain to a Linear team, and optionally one of its projects: the domain gets a{" "}
        <a href={domainsHash(slug, "board")} className="text-cc-primary hover:underline">board</a>, and new sessions in it search and
        create issues there by default. Everything is read live from Linear, so teammates with their own key see the same board.
      </p>

      {link?.broken && (
        <p role="alert" className="text-cc-error">The Linear connection of this link was removed: pick another one, or unlink.</p>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={ids.conn} className="w-40 shrink-0">Workspace (connection)</label>
          <select
            id={ids.conn}
            value={connectionId}
            disabled={saving}
            onChange={(e) => { setConnectionId(e.target.value); setTeamId(""); setProjectId(WHOLE_TEAM); resetRules(); }}
            className={selectClass}
          >
            {!connectionId && <option value="">Choose…</option>}
            {connections.map((c) => (
              <option key={c.id} value={c.id}>{c.workspaceName ? `${c.name} (${c.workspaceName})` : c.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={ids.team} className="w-40 shrink-0">Team</label>
          <select
            id={ids.team}
            value={teamId}
            disabled={saving || teams.length === 0}
            onChange={(e) => { setTeamId(e.target.value); setProjectId(WHOLE_TEAM); resetRules(); }}
            className={selectClass}
          >
            <option value="">{loading === "teams" ? "Loading teams…" : "Choose a team…"}</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.key} · {t.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={ids.project} className="w-40 shrink-0">Project</label>
          <select id={ids.project} value={projectId} disabled={saving || !teamId} onChange={(e) => setProjectId(e.target.value)} className={selectClass}>
            <option value={WHOLE_TEAM}>Whole team</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <fieldset className="space-y-2 rounded-lg border border-cc-border p-2.5">
        <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Rules for this domain</legend>
        {ruleSelect(ids.start, "When a session starts", start, setStart, info.rules?.start)}
        {ruleSelect(ids.archive, "When a session is archived", archive, setArchive, info.rules?.archive)}
        <p className="text-[10px] text-cc-muted leading-snug">
          Moves the issue linked to a session (Claude Code or Codex) to that state. "Connection default" keeps the setting of the
          connection in <a href="#/integrations/linear" className="text-cc-primary hover:underline">Linear settings</a>.
        </p>
      </fieldset>

      {error && <p role="alert" className="text-cc-error">{error}</p>}
      {saved && !error && <p role="status" className="text-cc-success">Saved.</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !connectionId || !teamId}
          className="px-3 py-1.5 rounded-md bg-cc-primary text-white disabled:opacity-50 cursor-pointer"
        >
          {saving ? "Saving…" : link ? "Save" : "Link domain"}
        </button>
        {link && (
          <button type="button" onClick={() => void unlink()} disabled={saving} className="px-3 py-1.5 rounded-md text-cc-muted hover:bg-cc-hover cursor-pointer">
            Unlink
          </button>
        )}
      </div>
    </section>
  );
}
