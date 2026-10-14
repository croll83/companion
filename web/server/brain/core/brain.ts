// The brain: the current wiki snapshot and its search index, the inbox, the
// audit log and the skill. The HTTP layer (http.ts) asks it for a fresh
// McpServer per request: the transport is stateless, so a restart of the
// process is invisible to clients (identity comes from the token, not from
// an MCP session).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { loadWiki, type WikiSnapshot } from "./wiki.js";
import { SearchIndex } from "./search.js";
import { Inbox, ROLE_USER } from "./inbox.js";
import { Audit, stdoutSink } from "./audit.js";
import { buildInstructions, type Persona } from "./instructions.js";
import { registerAll, type Identity } from "./tools.js";
import { buildSkill, type SkillDoc } from "./skill.js";
import type { TokenClaims } from "./token.js";
import { VERSION } from "./version.js";

/** What http.ts puts in the MCP request's authInfo.extra for a valid `brn_` token. */
export interface BrainAuthExtra {
  claims: TokenClaims;
}

export class Brain {
  cfg: Config;
  audit: Audit;
  inbox: Inbox;
  private snapshot: WikiSnapshot;
  private idx: SearchIndex;
  private skillCache?: { key: string; doc: SkillDoc };

  constructor(cfg: Config, audit = new Audit(stdoutSink(), undefined, cfg.name)) {
    this.cfg = cfg;
    this.audit = audit;
    this.snapshot = loadWiki(cfg.wikiDir);
    this.idx = SearchIndex.build(this.snapshot, cfg.language);
    this.inbox = new Inbox(cfg.dataDir, undefined, { allowedEmailDomains: cfg.allowedEmailDomains, maxNotesPerHour: cfg.maxNotesPerHour });
    this.logLoaded(this.snapshot);
  }

  private logLoaded(w: WikiSnapshot): void {
    this.audit.log({ event: "wiki_loaded", detail: `${w.commit} content=${w.contentHash} pages=${w.pages.size} raw=${w.raw.size} ignored=${w.ignored.length}` });
  }

  persona(): Persona {
    return { title: this.cfg.title, owner: this.cfg.owner, about: this.cfg.about };
  }

  wiki(): WikiSnapshot {
    return this.snapshot;
  }

  index(): SearchIndex {
    return this.idx;
  }

  /** Re-read the wiki folder; swap the snapshot when its content or commit changed (or always, when forced). */
  refresh(force = false): boolean {
    try {
      const next = loadWiki(this.cfg.wikiDir);
      if (!force && next.contentHash === this.snapshot.contentHash && next.commit === this.snapshot.commit) return false;
      const idx = SearchIndex.build(next, this.cfg.language);
      this.snapshot = next;
      this.idx = idx;
      this.logLoaded(next);
      return true;
    } catch (e) {
      // Keep serving the last good snapshot.
      this.audit.log({ event: "wiki_reload_failed", detail: (e as Error).message });
      return false;
    }
  }

  /** The public skill, rebuilt only when the wiki content changes (and only if it uses wiki topics). */
  skill(): SkillDoc {
    const key = this.cfg.skillTopics === "index" ? this.snapshot.contentHash : "static";
    if (this.skillCache?.key !== key) {
      const doc = buildSkill(this.snapshot, {
        name: this.cfg.name,
        persona: this.persona(),
        topics: this.cfg.skillTopics,
        description: this.cfg.skillDescription,
        redactSecrets: this.cfg.redactSecrets,
        version: VERSION,
      });
      this.skillCache = { key, doc };
    }
    return this.skillCache.doc;
  }

  /**
   * Who is calling: the Companion session of a `brn_` token (each session has
   * its own note budget), or the owner when the server takes no tokens (a
   * stock MCP client on a single-user server).
   */
  identify(authInfo?: { extra?: Record<string, unknown> }): Identity {
    const claims = (authInfo?.extra as Partial<BrainAuthExtra> | undefined)?.claims;
    if (claims) {
      return { id: `session:${claims.domain}/${claims.sessionId}`, name: `${this.cfg.owner} (${claims.domain})`, roles: [ROLE_USER], sessionId: claims.sessionId };
    }
    return { id: `user:${this.cfg.owner}`, name: this.cfg.owner, roles: [ROLE_USER] };
  }

  newMcpServer(): McpServer {
    const server = new McpServer(
      { name: this.cfg.name, title: this.cfg.title, version: VERSION },
      { instructions: buildInstructions(this.snapshot, { ...this.persona(), redactSecrets: this.cfg.redactSecrets }), capabilities: { tools: {} } },
    );
    registerAll(server, {
      wiki: () => this.wiki(),
      index: () => this.index(),
      inbox: this.inbox,
      audit: this.audit,
      redactSecrets: this.cfg.redactSecrets,
      persona: this.persona(),
      identify: (extra) => this.identify((extra as { authInfo?: { extra?: Record<string, unknown> } }).authInfo),
      clientInfo: () => {
        const v = server.server.getClientVersion();
        return { name: v?.name ?? "unknown", version: v?.version ?? "unknown" };
      },
    });
    return server;
  }
}
