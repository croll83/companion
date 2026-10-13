import { useId, useState } from "react";
import type { BrainInfo, BrainInput } from "../api.js";

/**
 * The skill sessions get with a brain (`<slug>-brain`): Claude through the
 * brain's plugin, Codex as a linked skill. "Generated" is built from the
 * brain's name and about text (Companion never reads the wiki); "Custom" is
 * the user's text: a SKILL.md body, or a whole SKILL.md with frontmatter.
 */
export function BrainSkill({
  brain,
  busy,
  onSave,
}: {
  brain: BrainInfo;
  busy: boolean;
  onSave: (skill: NonNullable<BrainInput["skill"]>) => Promise<unknown>;
}) {
  const [source, setSource] = useState(brain.skill.source);
  const [text, setText] = useState(brain.skill.custom ?? "");
  const textId = useId();
  const dirty = source !== brain.skill.source || (source === "custom" && text.trim() !== (brain.skill.custom ?? "").trim());

  return (
    <section aria-label="Skill" className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Skill · {brain.serverName}</h3>
      <fieldset className="flex flex-wrap gap-3 text-[12px]">
        <legend className="sr-only">Skill source</legend>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" name={`skill-${brain.slug}`} checked={source === "generated"} onChange={() => setSource("generated")} />
          Generated from the about text
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" name={`skill-${brain.slug}`} checked={source === "custom"} onChange={() => setSource("custom")} />
          Custom text
        </label>
      </fieldset>
      {source === "generated" ? (
        brain.skill.source === "generated" ? (
          <pre aria-label="Generated skill" className="max-h-64 overflow-auto rounded-md border border-cc-border bg-cc-code-bg p-2 text-[11px] font-mono-code whitespace-pre-wrap">
            {brain.skillText}
          </pre>
        ) : (
          <p className="text-[11px] text-cc-muted">Save to switch back to the generated skill; it follows the brain's name and about text.</p>
        )
      ) : (
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
          onClick={() => void onSave(source === "custom" ? { source, custom: text } : { source: "generated" })}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          Save skill
        </button>
      )}
      <p className="text-[10px] text-cc-muted">Applies when a session of a domain using the brain starts or reloads.</p>
    </section>
  );
}
