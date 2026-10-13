import { useId, useState } from "react";
import type { BrainInfo, BrainInput } from "../api.js";

type SkillSource = BrainInfo["skill"]["source"];

const PREVIEW = "max-h-64 overflow-auto rounded-md border border-cc-border bg-cc-code-bg p-2 text-[11px] font-mono-code whitespace-pre-wrap";

/** "Fetched 13 Oct, 20:00 · server 0.2.0 · follows the wiki (abc123)". */
function serverMeta(brain: BrainInfo): string {
  const s = brain.skill.server;
  if (!s) return "";
  return [
    `Fetched ${new Date(s.fetchedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
    s.serverVersion ? `server ${s.serverVersion}` : "",
    s.contentHash ? `follows the wiki (${s.contentHash.slice(0, 12)}): fetched again when it changes` : "does not depend on the wiki content",
  ].filter(Boolean).join(" · ");
}

/**
 * The skill sessions get with a brain (`<slug>-brain`): Claude through the
 * brain's plugin, Codex as a linked skill. "From the server" is the skill the
 * brain server publishes at `<base>/skill` (fetched by Companion's server,
 * refreshed on demand and when the wiki version changes); "Generated" is
 * built from the brain's name and about text (Companion never reads the
 * wiki); "Custom" is the user's text: a SKILL.md body, or a whole SKILL.md
 * with frontmatter. A skill from a server is untrusted text: it is shown in a
 * <pre> as plain text, never rendered.
 */
export function BrainSkill({
  brain,
  busy,
  onSave,
  onRefresh,
}: {
  brain: BrainInfo;
  busy: boolean;
  onSave: (skill: NonNullable<BrainInput["skill"]>) => Promise<unknown>;
  /** Fetch the server's skill again ("Refresh skill"). */
  onRefresh: () => Promise<unknown>;
}) {
  const [source, setSource] = useState<SkillSource>(brain.skill.source);
  const [text, setText] = useState(brain.skill.custom ?? "");
  const [refreshing, setRefreshing] = useState(false);
  const textId = useId();
  const current = brain.skill.source;
  const dirty = source !== current || (source === "custom" && text.trim() !== (brain.skill.custom ?? "").trim());

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const option = (value: SkillSource, label: string) => (
    <label className="flex items-center gap-1.5 cursor-pointer">
      <input type="radio" name={`skill-${brain.slug}`} checked={source === value} onChange={() => setSource(value)} />
      {label}
    </label>
  );

  return (
    <section aria-label="Skill" className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Skill · {brain.serverName}</h3>
      <fieldset className="flex flex-wrap gap-3 text-[12px]">
        <legend className="sr-only">Skill source</legend>
        {option("server", "From the server")}
        {option("generated", "Generated from the about text")}
        {option("custom", "Custom text")}
      </fieldset>
      {brain.skill.note && (
        <p role="status" className="text-[11px] text-cc-warning">{brain.skill.note}</p>
      )}
      {source === "server" && (current === "server" ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-cc-muted">
            From <span className="font-mono-code break-all">{brain.urls.skillUrl}</span>. {serverMeta(brain)}
          </p>
          <pre aria-label="Skill from the server" className={PREVIEW}>{brain.skillText}</pre>
          <button
            type="button"
            disabled={busy || refreshing}
            onClick={() => void refresh()}
            className="px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-wait"
          >
            {refreshing ? "Refreshing…" : "Refresh skill"}
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-cc-muted">
          Save to fetch the skill the brain publishes at <span className="font-mono-code break-all">{brain.urls.skillUrl}</span>. If it
          publishes none, the current skill stays and a note says why.
        </p>
      ))}
      {source === "generated" && (current === "generated" ? (
        <pre aria-label="Generated skill" className={PREVIEW}>{brain.skillText}</pre>
      ) : (
        <p className="text-[11px] text-cc-muted">Save to switch back to the generated skill; it follows the brain's name and about text.</p>
      ))}
      {source === "custom" && (
        <div>
          <label htmlFor={textId} className="block text-[11px] text-cc-muted">
            SKILL.md body, or a whole SKILL.md (with a <span className="font-mono-code">description</span> in its frontmatter)
          </label>
          <textarea
            id={textId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            className="w-full px-2 py-1.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
          />
        </div>
      )}
      {dirty && (
        <button
          type="button"
          disabled={busy || (source === "custom" && !text.trim())}
          onClick={() => void onSave(source === "custom" ? { source, custom: text } : { source })}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          Save skill
        </button>
      )}
      <p className="text-[10px] text-cc-muted">Applies when a session of a domain using the brain starts or reloads.</p>
    </section>
  );
}
