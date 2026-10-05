import { useStore } from "../store.js";

/**
 * Names of the env profiles applied to a session's CLI at its last spawn
 * (global, folder-matched and the explicitly picked one), in application
 * order. Values are never sent to the browser for this. Works the same for
 * Claude Code and Codex sessions; renders nothing when no profile applies.
 */
export function SessionEnvProfiles({ sessionId }: { sessionId: string }) {
  const names = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId)?.envProfiles);
  if (!names || names.length === 0) return null;

  return (
    <section aria-label="Environment profiles" className="shrink-0 px-4 py-2.5 border-b border-cc-separator">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Environment</h3>
      <ol
        className="mt-1.5 flex flex-wrap gap-1.5"
        title="Applied in this order: later profiles override earlier ones"
      >
        {names.map((name) => (
          <li
            key={name}
            className="text-[11px] px-2 py-0.5 rounded-full bg-cc-primary/10 text-cc-primary font-medium"
          >
            {name}
          </li>
        ))}
      </ol>
    </section>
  );
}
