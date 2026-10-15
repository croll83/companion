import { useEffect, useState } from "react";
import { api, type BackendModelInfo } from "../api.js";

/**
 * Codex's model catalogue as /backends/codex/models lists it (picker order,
 * each model with its effort levels and default), fetched while `enabled`.
 * Null until it arrives, and when the server has no catalogue (Codex never ran
 * on this machine): callers fall back to the static model list and treat the
 * effort levels as unknown.
 */
export function useCodexModels(enabled: boolean): BackendModelInfo[] | null {
  const [models, setModels] = useState<BackendModelInfo[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.getBackendModels("codex")
      .then((m) => { if (live && m.length > 0) setModels(m); })
      .catch(() => { /* no catalogue: keep null */ });
    return () => { live = false; };
  }, [enabled]);
  return models;
}
