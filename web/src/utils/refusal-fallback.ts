// Which model to try next when the current one refuses.
//
// A refusal is a policy decision by one model, and models differ in where they
// draw the line — later ones tend to decline more. So the fallback walks
// towards older models one step at a time, rather than jumping straight to one
// fixed model: each step keeps as much capability as it can while still having
// a chance of answering.

/** The chain, most capable first. Each refusal moves one step to the right. */
export const REFUSAL_CHAIN = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
] as const;

/** Models outside the chain enter it here; the last resort is also the safest. */
const OFF_CHAIN_FALLBACK = REFUSAL_CHAIN[REFUSAL_CHAIN.length - 1];

/** Older revisions of a chain model take the same next step as the current one. */
const CHAIN_ALIASES: Record<string, (typeof REFUSAL_CHAIN)[number]> = {
  "claude-fable-5": "claude-fable-5-1",
};

const LABELS: Record<string, string> = {
  "claude-fable-5-1": "Fable 5.1",
  "claude-opus-5-5": "Opus 5.5",
  "claude-opus-5": "Opus 5",
  "claude-opus-4-8": "Opus 4.8",
};

export function refusalFallbackLabel(model: string): string {
  return LABELS[model] ?? model;
}

/**
 * The model to offer after `refusedBy` declined, or null when the chain is
 * exhausted (the last resort itself refused — rephrasing is the only way on).
 *
 * An unknown refusing model (Sonnet, Haiku, an older Opus) enters the chain at
 * its last resort, which is what the banner offered before the chain existed.
 */
/**
 * Reduce a model id as reported by a response to its bare family id.
 *
 * Responses can carry a context-variant tag (`claude-opus-5-5[1m]`) or a dated
 * snapshot (`claude-opus-4-8-20260115`). Prefix matching is not an option:
 * `claude-opus-5` is a prefix of `claude-opus-5-5`, so a 5.5 refusal would be
 * read as a 5 refusal and the chain would skip a step.
 */
export function normalizeModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

export function nextRefusalFallback(refusedBy: string | undefined | null): string | null {
  if (!refusedBy) return OFF_CHAIN_FALLBACK;
  const bare = normalizeModelId(refusedBy);
  const model = CHAIN_ALIASES[bare] ?? bare;
  const index = (REFUSAL_CHAIN as readonly string[]).indexOf(model);
  if (index === -1) return model === OFF_CHAIN_FALLBACK ? null : OFF_CHAIN_FALLBACK;
  return REFUSAL_CHAIN[index + 1] ?? null;
}
