import { useId, useState } from "react";
import type { DomainPatch, DomainSummary, SkillGroupInfo } from "../api.js";
import { Toggle } from "./DomainToggle.js";

const CODEX_NOTE: Record<SkillGroupInfo["codex"], string> = {
  linked: "Codex too",
  toggled: "Codex too",
  unsupported: "Claude only",
};

/**
 * The skills view of one domain. The domain's own skills (its folder's
 * skills/) can be created and removed here (removal moves the folder aside).
 * The skills installed outside the domain are grouped (yours, claude.ai,
 * design): a group switch turns the whole group on or off (mixed when only
 * some are on), and each skill has its own switch, which wins over the
 * group's; a single choice can be reset to the group's/GLOBAL's. One of your
 * skills can be kept for this domain only ("Only here": off in GLOBAL, on
 * here). Claude gets per-skill overrides; Codex gets your skills linked one
 * by one and the design skills turned off one by one; claude.ai skills are
 * Claude-only.
 */
export function DomainSkills({
  domain,
  groups,
  busy,
  onPatch,
  onCreateSkill,
  onRemoveSkill,
}: {
  domain: DomainSummary;
  groups: SkillGroupInfo[];
  busy: boolean;
  onPatch: (slug: string, patch: DomainPatch) => void;
  /** Resolves true when the skill was created. */
  onCreateSkill: (slug: string, name: string, description: string) => Promise<boolean>;
  onRemoveSkill: (slug: string, name: string) => Promise<boolean>;
}) {
  return (
    <div className="space-y-4">
      <OwnSkills domain={domain} busy={busy} onCreateSkill={onCreateSkill} onRemoveSkill={onRemoveSkill} />
      {groups.map((g) => <SkillGroupBlock key={g.id} group={g} domain={domain} busy={busy} onPatch={onPatch} />)}
      <p className="text-[11px] text-cc-muted">Changes apply when a session of the domain starts or reloads.</p>
    </div>
  );
}

function OwnSkills({
  domain,
  busy,
  onCreateSkill,
  onRemoveSkill,
}: {
  domain: DomainSummary;
  busy: boolean;
  onCreateSkill: (slug: string, name: string, description: string) => Promise<boolean>;
  onRemoveSkill: (slug: string, name: string) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameId = useId();
  const descId = useId();
  const own = domain.ownSkills ?? [];
  return (
    <section aria-label="Skills of this domain">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">
        {domain.slug === "global" ? "GLOBAL's skills" : "This domain's skills"} <span className="font-normal">({own.length})</span>
      </h3>
      {own.length === 0 && <p className="text-[11px] text-cc-muted">None yet. They live in {domain.path}/skills and reach Codex too.</p>}
      <ul className="mt-1 divide-y divide-cc-separator">
        {own.map((s) => (
          <li key={s.name} className="py-1.5 flex items-center gap-2 text-[12px] min-w-0">
            <div className="flex-1 min-w-0">
              <span className="font-medium">{s.name}</span>
              {s.description && <span className="block text-[10px] text-cc-muted truncate">{s.description}</span>}
            </div>
            {confirm === s.name ? (
              <span className="shrink-0 flex items-center gap-1 text-[11px]">
                <button
                  type="button"
                  onClick={() => void onRemoveSkill(domain.slug, s.name).then(() => setConfirm(null))}
                  className="px-2 py-0.5 rounded bg-cc-error/15 text-cc-error hover:bg-cc-error/25 cursor-pointer"
                >
                  Remove
                </button>
                <button type="button" onClick={() => setConfirm(null)} className="px-2 py-0.5 rounded text-cc-muted hover:bg-cc-hover cursor-pointer">
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirm(s.name)}
                disabled={busy}
                aria-label={`Remove skill ${s.name}`}
                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded text-cc-muted hover:text-cc-error hover:bg-cc-error/10 cursor-pointer disabled:opacity-40"
              >
                Remove…
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          aria-label="New skill"
          className="mt-2 p-3 rounded-lg border border-cc-border space-y-2 text-[11px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !description.trim()) return;
            void onCreateSkill(domain.slug, name.trim(), description.trim()).then((ok) => {
              if (ok) { setAdding(false); setName(""); setDescription(""); }
            });
          }}
        >
          <div>
            <label htmlFor={nameId} className="block text-cc-muted">Name (lowercase, digits, "-")</label>
            <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy-check" className="w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border font-mono-code text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary" />
          </div>
          <div>
            <label htmlFor={descId} className="block text-cc-muted">When the model should use it</label>
            <input id={descId} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary" />
          </div>
          <p className="text-cc-muted">Creates SKILL.md with this description: write the instructions in it afterwards.</p>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !name.trim() || !description.trim()} className="px-2.5 py-1 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed">
              Create
            </button>
            <button type="button" onClick={() => setAdding(false)} className="px-2.5 py-1 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} disabled={busy} className="mt-1 px-3 py-1.5 rounded-lg text-[12px] border border-cc-border hover:bg-cc-hover cursor-pointer disabled:opacity-40">
          New skill
        </button>
      )}
    </section>
  );
}

function SkillGroupBlock({
  group: g,
  domain,
  busy,
  onPatch,
}: {
  group: SkillGroupInfo;
  domain: DomainSummary;
  busy: boolean;
  onPatch: (slug: string, patch: DomainPatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmGroup, setConfirmGroup] = useState<boolean | null>(null);
  const [onlyHere, setOnlyHere] = useState<string | null>(null);
  const isGlobal = domain.slug === "global";
  const state = domain.skillGroupStates[g.id] ?? { on: true, own: false, onCount: g.skills.length };
  const total = g.skills.length;
  const allOn = state.onCount === total;
  const mixed = state.onCount > 0 && state.onCount < total;
  const key = (name: string) => `${g.id}:${name}`;
  const ownKeys = g.skills.map(key).filter((k) => domain.skillStates[k]?.own);

  const setGroup = (on: boolean) => {
    if (ownKeys.length > 0 && confirmGroup === null) { setConfirmGroup(on); return; }
    setConfirmGroup(null);
    onPatch(domain.slug, { skillGroups: { [g.id]: on }, ...(ownKeys.length > 0 ? { skillChoices: Object.fromEntries(ownKeys.map((k) => [k, null])) } : {}) });
  };

  return (
    <section aria-label={g.label}>
      <div className="flex items-center gap-2">
        <Toggle label={`Skill group ${g.label}`} checked={allOn} mixed={mixed} disabled={busy || total === 0} onChange={setGroup} />
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex-1 min-w-0 text-left cursor-pointer">
          <span className="text-[13px] font-medium">{g.label}</span>
          <span className="ml-1.5 text-[10px] text-cc-muted">
            {state.onCount}/{total} on · {CODEX_NOTE[g.codex]}{!isGlobal && !state.own ? " · as in GLOBAL" : ""}
          </span>
          <span className="block text-[10px] text-cc-muted truncate">{g.description}</span>
        </button>
      </div>
      {confirmGroup !== null && (
        <div className="mt-1 pl-11 flex items-center gap-2 text-[11px]">
          <span>Turn every skill {confirmGroup ? "on" : "off"} and drop {ownKeys.length} single choice{ownKeys.length === 1 ? "" : "s"}?</span>
          <button type="button" onClick={() => setGroup(confirmGroup)} className="px-2 py-0.5 rounded bg-cc-primary text-white cursor-pointer">Yes</button>
          <button type="button" onClick={() => setConfirmGroup(null)} className="px-2 py-0.5 rounded text-cc-muted hover:bg-cc-hover cursor-pointer">Cancel</button>
        </div>
      )}
      {open && (
        <ul className="mt-1 pl-11 divide-y divide-cc-separator">
          {g.skills.map((name) => {
            const st = domain.skillStates[key(name)] ?? { on: state.on, own: false };
            return (
              <li key={name} className="py-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Toggle label={`Skill ${name}`} checked={st.on} disabled={busy} onChange={(on) => onPatch(domain.slug, { skillChoices: { [key(name)]: on } })} />
                  <div className="flex-1 min-w-0">
                    <span className="text-[12px] font-medium">{name}</span>
                    {g.descriptions?.[name] && <span className="block text-[10px] text-cc-muted truncate">{g.descriptions[name]}</span>}
                  </div>
                  {st.own ? (
                    <button
                      type="button"
                      onClick={() => onPatch(domain.slug, { skillChoices: { [key(name)]: null } })}
                      disabled={busy}
                      aria-label={`Reset skill ${name}`}
                      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded text-cc-primary hover:bg-cc-primary/10 cursor-pointer disabled:opacity-40"
                    >
                      Reset
                    </button>
                  ) : g.id === "user" && !isGlobal ? (
                    <button
                      type="button"
                      onClick={() => setOnlyHere(name)}
                      disabled={busy}
                      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer disabled:opacity-40"
                    >
                      Only here
                    </button>
                  ) : null}
                </div>
                {onlyHere === name && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    <span>Turn {name} off in GLOBAL (every domain without its own choice) and on here?</span>
                    <button
                      type="button"
                      onClick={() => {
                        setOnlyHere(null);
                        onPatch("global", { skillChoices: { [key(name)]: false } });
                        onPatch(domain.slug, { skillChoices: { [key(name)]: true } });
                      }}
                      className="px-2 py-0.5 rounded bg-cc-primary text-white cursor-pointer"
                    >
                      Only here
                    </button>
                    <button type="button" onClick={() => setOnlyHere(null)} className="px-2 py-0.5 rounded text-cc-muted hover:bg-cc-hover cursor-pointer">Cancel</button>
                  </div>
                )}
              </li>
            );
          })}
          {total === 0 && <li className="py-1 text-[11px] text-cc-muted">No skills in this group.</li>}
        </ul>
      )}
    </section>
  );
}
