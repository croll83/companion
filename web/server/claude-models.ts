/**
 * The Claude model catalog: the models the pickers offer. Kept in server/
 * (and re-exported by src/utils/backends.ts, like effort.ts) because the
 * server needs it too: a brain's consolidation runs on "the latest Sonnet"
 * of this list, resolved at every run (latestSonnet). Pure data, importable
 * from the browser bundle.
 */

export interface ClaudeModelOption {
  value: string;
  label: string;
  icon: string;
}

export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { value: "claude-fable-5-1", label: "Fable 5.1", icon: "" },
  { value: "claude-opus-5-5", label: "Opus 5.5", icon: "" },
  { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
  { value: "claude-opus-4-6", label: "Opus 4.6", icon: "" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", icon: "" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", icon: "" },
];

/** `claude-sonnet-5-5` → [5, 5]; null for ids that are not a Sonnet. */
function sonnetVersion(id: string): number[] | null {
  const m = /^claude-sonnet-(\d+(?:-\d+)*)(?:-\d{8})?$/.exec(id);
  if (!m) return null;
  return m[1].split("-").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The newest Sonnet in the catalog (highest version number, whatever the
 * list order), or undefined when the catalog has none. Brains consolidate on
 * it by default: a new Sonnet in the catalog is picked up at the next run.
 */
export function latestSonnet(models: readonly { value: string }[] = CLAUDE_MODELS): string | undefined {
  let best: { id: string; v: number[] } | undefined;
  for (const m of models) {
    const v = sonnetVersion(m.value);
    if (v && (!best || compareVersions(v, best.v) > 0)) best = { id: m.value, v };
  }
  return best?.id;
}
