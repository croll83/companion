import { useState } from "react";
import type { BrainInfo, BrainInput, BrainTestResult } from "../api.js";
import { brainsHash, domainsHash } from "../utils/routing.js";
import { BrainForm } from "./BrainForm.js";
import { HealthDot, healthText, type BrainHealthState } from "./BrainList.js";
import { BrainSkill } from "./BrainSkill.js";
import { BrainRuntime } from "./BrainRuntime.js";
import { EmbeddedBrainForm } from "./EmbeddedBrainForm.js";
import { BrainLoginChips } from "./BrainLoginChips.js";
import { BrainPages } from "./BrainPages.js";
import { BrainInbox } from "./BrainInbox.js";
import { WikiCheck } from "./WikiCheck.js";
import { BrainConsolidation } from "./BrainConsolidation.js";

export interface BrainActions {
  onUpdate: (slug: string, input: BrainInput) => Promise<boolean>;
  onDelete: (slug: string) => Promise<boolean>;
  onAdopt: (slug: string, pluginId: string) => Promise<boolean>;
  /** Health plus an MCP initialize; null when the request itself failed (error shown by the page). */
  onTest: (slug: string) => Promise<BrainTestResult | null>;
  onCheckHealth: (slug: string) => void;
  /** Fetch the brain's skill from its server again. */
  onRefreshSkill: (slug: string) => Promise<boolean>;
  /** Embedded brains: start, stop or restart the brain's process. */
  onProcess: (slug: string, action: "start" | "stop" | "restart") => Promise<boolean>;
  /** Embedded brains: the last lines of its log; null when they could not be read. */
  onLoadLogs: (slug: string) => Promise<string[] | null>;
}

/** "None", "Bearer token (set)", "OAuth · client <id> · callback port 8765". */
function authText(brain: BrainInfo): string {
  if (brain.kind === "embedded") return "A token per session, minted by Companion";
  const auth = brain.remote?.auth;
  if (auth?.mode === "bearer") return `Bearer token (${brain.hasToken ? "set" : "missing"})`;
  if (auth?.mode === "oauth") return `OAuth · client ${auth.clientId}${auth.callbackPort ? ` · callback port ${auth.callbackPort}` : ""}`;
  return "None";
}

/**
 * OAuth brains: Companion holds no token. Each CLI (Claude Code, Codex) signs
 * in once, from any session of a domain that uses the brain, through the
 * session's MCP panel; the tokens stay in that CLI's own store and serve all
 * its sessions. The chips show each CLI's state from its active sessions.
 */
function OAuthSignIn({ brain }: { brain: BrainInfo }) {
  const domain = brain.domains.find((d) => d.slug !== "global") ?? brain.domains[0];
  return (
    <section aria-label="Sign-in" className="p-2.5 rounded-lg border border-cc-border text-[12px] space-y-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Sign-in</h3>
      <BrainLoginChips brain={brain} />
      <p>
        Sign in once per CLI (Claude Code and Codex each keep their own tokens, shared by all their sessions): open a session of a
        domain that uses this brain, then its MCP panel → <strong>{brain.serverName}</strong> → <strong>Sign in</strong>. Companion never
        sees the tokens.
      </p>
      {domain ? (
        <p>
          For example from <a href={domainsHash(domain.slug)} className="text-cc-primary hover:underline">{domain.slug === "global" ? "GLOBAL" : domain.name}</a>.
        </p>
      ) : (
        <p className="text-cc-muted">Choose this brain in a domain first: its sessions get the server and the Sign in button.</p>
      )}
    </section>
  );
}

function TestResult({ result }: { result: BrainTestResult }) {
  const { mcp } = result;
  return (
    <div role="status" className="mt-2 rounded-md border border-cc-border p-2 text-[11px] space-y-0.5">
      <p>Health: {healthText(result.health)}</p>
      <p className={mcp.ok || mcp.signInRequired ? "text-cc-success" : "text-cc-error"}>
        MCP: {mcp.ok
          ? `connected to ${mcp.serverName ?? "the server"}${mcp.serverVersion ? ` ${mcp.serverVersion}` : ""} (${mcp.transport === "sse" ? "SSE" : "JSON"}, protocol ${mcp.protocolVersion ?? "?"})`
          : mcp.signInRequired
            ? "reachable, sign-in required (sign in from a session's MCP panel)"
            : mcp.error ?? "failed"}
      </p>
      {mcp.ok && (
        <p className="text-cc-muted">
          {mcp.hasInstructions ? "It sends instructions (Claude Code shows them; Codex gets the skill and an AGENTS.md line)." : "It sends no instructions: the skill tells the model how to use it."}
          {mcp.sessionClosed === false ? " The test session could not be closed." : ""}
        </p>
      )}
    </div>
  );
}

type Tab = "overview" | "pages" | "inbox" | "consolidation";

/**
 * One brain: where it points, its health and a connection test, which
 * domains use it (brains are assigned from each domain's page, one brain per
 * domain), plugins serving the same URL with "Adopt plugin as brain", its
 * skill, editing and removal. An embedded brain also has the Pages tab (read
 * its wiki), the Inbox tab (notes, Dismiss, Add source) and a wiki check
 * with one-click fixes in its overview, and the Consolidation tab (its
 * agent, triggers and runs). A remote brain's overview can link the agent
 * that consolidates it, to list that agent's runs.
 */
export function BrainDetail({
  brain,
  health,
  desktop,
  busy,
  actions,
}: {
  brain: BrainInfo;
  health: BrainHealthState;
  desktop: boolean;
  busy: boolean;
  actions: BrainActions;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<BrainTestResult | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const collisions = brain.collisions.filter((c) => c.domains.length > 0);
  const embedded = brain.kind === "embedded";
  const waiting = health && health !== "checking" ? health.inbox?.pending ?? 0 : 0;
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "pages", label: "Pages" },
    { id: "inbox", label: waiting ? `Inbox (${waiting})` : "Inbox" },
    { id: "consolidation", label: "Consolidation" },
  ];

  const runTest = async () => {
    setTesting(true);
    setTest(await actions.onTest(brain.slug));
    setTesting(false);
  };

  return (
    <article aria-label={`Brain ${brain.name}`} className="space-y-4">
      <header>
        {!desktop && <a href={brainsHash()} className="text-[12px] text-cc-primary hover:underline">‹ Brains</a>}
        <h2 className="mt-1 text-[16px] font-semibold">{brain.name}</h2>
        {brain.about && <p className="text-[12px] text-cc-muted whitespace-pre-wrap">{brain.about}</p>}
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11px] text-cc-muted">
          {embedded && <><dt>Wiki</dt><dd className="font-mono-code break-all">{brain.embedded?.wikiDir}</dd></>}
          <dt>MCP</dt><dd className="font-mono-code break-all">{brain.urls.mcpUrl}</dd>
          {!embedded && <><dt>Health</dt><dd className="font-mono-code break-all">{brain.urls.healthUrl}</dd></>}
          <dt>Auth</dt>
          <dd className="break-all">{authText(brain)}</dd>
        </dl>
      </header>

      {embedded && (
        <div role="tablist" aria-label="Brain views" className="flex gap-1 border-b border-cc-border">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`brain-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`brain-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 -mb-px border-b-2 text-[12px] cursor-pointer ${tab === t.id ? "border-cc-primary text-cc-fg font-medium" : "border-transparent text-cc-muted hover:text-cc-fg"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {embedded && tab === "pages" && (
        <div role="tabpanel" id="brain-panel-pages" aria-labelledby="brain-tab-pages">
          <BrainPages slug={brain.slug} />
        </div>
      )}
      {embedded && tab === "inbox" && (
        <div role="tabpanel" id="brain-panel-inbox" aria-labelledby="brain-tab-inbox">
          <BrainInbox slug={brain.slug} onChanged={() => actions.onCheckHealth(brain.slug)} />
        </div>
      )}

      {embedded && tab === "consolidation" && (
        <div role="tabpanel" id="brain-panel-consolidation" aria-labelledby="brain-tab-consolidation">
          <BrainConsolidation brain={brain} waiting={waiting} onChanged={() => actions.onCheckHealth(brain.slug)} />
        </div>
      )}

      {tab === "overview" && (
        <div className="space-y-4" {...(embedded ? { role: "tabpanel", id: "brain-panel-overview", "aria-labelledby": "brain-tab-overview" } : {})}>
        <section aria-label="Connection" className="space-y-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Connection</h3>
          <div className="flex items-center gap-2 text-[12px]">
            <HealthDot health={health} />
            <span className="min-w-0 break-words">{healthText(health)}</span>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => actions.onCheckHealth(brain.slug)} disabled={health === "checking"} className="px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer">
              Check again
            </button>
            <button type="button" onClick={() => void runTest()} disabled={testing} className="px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-wait">
              {testing ? "Testing…" : "Test connection"}
            </button>
          </div>
          {test && <TestResult result={test} />}
        </section>

        {embedded && (
          <BrainRuntime
            key={brain.runtime?.state ?? "stopped"}
            brain={brain}
            busy={busy}
            onAction={(action) => actions.onProcess(brain.slug, action)}
            loadLogs={() => actions.onLoadLogs(brain.slug)}
          />
        )}

        {embedded && <WikiCheck slug={brain.slug} onFixed={() => actions.onCheckHealth(brain.slug)} />}

        {brain.remote?.auth.mode === "oauth" && <OAuthSignIn brain={brain} />}

        {collisions.map((c) => (
          <div key={c.pluginId} role="alert" className="p-2.5 rounded-lg border border-cc-warning/40 bg-cc-warning/10 text-[12px] space-y-1.5">
            <p>
              The plugin <strong>{c.pluginName}</strong> serves the same MCP server and is on in {c.domains.map((d) => (d === "global" ? "GLOBAL" : d)).join(", ")}.
              Where the brain is on, the brain wins and the plugin is skipped. Adopting it gives those domains this brain and turns the plugin off there.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void actions.onAdopt(brain.slug, c.pluginId)}
              className="px-2.5 py-1 rounded-md text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer"
            >
              Adopt plugin as brain
            </button>
          </div>
        ))}

        <section aria-label="Domains using it">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Domains</h3>
          {brain.domains.length === 0 ? (
            <p className="text-[12px] text-cc-muted">
              On no domain. Brains are off by default: choose this one in a domain's page (one brain per domain).
            </p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {brain.domains.map((d) => (
                <li key={d.slug}>
                  <a href={domainsHash(d.slug)} className="inline-block px-2 py-0.5 rounded-md border border-cc-border text-[12px] hover:bg-cc-hover">
                    {d.slug === "global" ? "GLOBAL · default for every domain" : d.own ? d.name : `${d.name} (as in GLOBAL)`}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[10px] text-cc-muted">
            Claude Code sessions get the <span className="font-mono-code">{brain.serverName}</span> tools and the skill; Codex sessions get the
            same tools, the skill, and a line in their AGENTS.md. Changes apply when a session starts or reloads.
          </p>
        </section>

        {/* A remote brain is consolidated on its own server: only its owners may run that from Companion, so it hides under Advanced. */}
        {!embedded && (
          <details aria-label="Consolidation agent" className="space-y-1">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-cc-muted">
              Advanced: consolidation (brain owners only)
            </summary>
            <p className="text-[12px]">
              A remote brain is normally consolidated on its own server, by whoever runs it: its users need nothing here. If you own this
              brain and consolidate it from Companion, first create an agent of your own with access to the brain&apos;s wiki and the right to
              commit and push to it (its prompt, schedule and push are yours), then link it here to follow its runs.
            </p>
            <BrainConsolidation brain={brain} waiting={waiting} />
          </details>
        )}

        <BrainSkill
          key={`${brain.skill.source}:${brain.skill.custom ?? ""}:${brain.skill.server?.fetchedAt ?? ""}`}
          brain={brain}
          busy={busy}
          onSave={(skill) => actions.onUpdate(brain.slug, { skill })}
          onRefresh={() => actions.onRefreshSkill(brain.slug)}
        />

        <section aria-label="Settings" className="space-y-2">
          {editing && embedded ? (
            <EmbeddedBrainForm
              brain={brain}
              busy={busy}
              onCancel={() => setEditing(false)}
              onSubmit={(input) => actions.onUpdate(brain.slug, input as BrainInput).then((ok) => { if (ok) setEditing(false); })}
            />
          ) : editing ? (
            <BrainForm
              brain={brain}
              busy={busy}
              onCancel={() => setEditing(false)}
              onSubmit={(input) => actions.onUpdate(brain.slug, input).then((ok) => { if (ok) setEditing(false); })}
            />
          ) : (
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(true)} className="px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active cursor-pointer">
                Edit brain
              </button>
              <button type="button" onClick={() => setConfirmDelete(true)} className="px-2.5 py-1 rounded-md text-[12px] text-cc-error hover:bg-cc-error/10 cursor-pointer">
                Remove brain…
              </button>
            </div>
          )}
          {confirmDelete && (
            <div role="alert" className="p-2 rounded-lg border border-cc-error/30 text-[12px] space-y-1.5">
              <p>
                Remove <strong>{brain.name}</strong>? {brain.domains.length > 0 ? `${brain.domains.length} domain(s) stop using it. ` : ""}
                {embedded
                  ? "Companion stops it and deletes its settings, inbox and log; the wiki folder is not touched."
                  : "Companion forgets its settings and token; the brain itself (its server and wiki) is not touched."}
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void actions.onDelete(brain.slug)} className="px-2.5 py-1 rounded-md bg-cc-error/15 text-cc-error hover:bg-cc-error/25 cursor-pointer">
                  Remove brain
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="px-2.5 py-1 rounded-md text-cc-muted hover:bg-cc-hover cursor-pointer">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
        </div>
      )}
    </article>
  );
}
