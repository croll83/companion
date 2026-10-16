import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which transition rule applies to a session's issue: the domain's own rule
 * (only for its workspace and team), else the connection's setting, else the
 * legacy settings.json fields. The fallback chain is what keeps existing
 * installs working unchanged after rules moved to domains.
 */

const h = vi.hoisted(() => ({
  conn: null as null | Record<string, unknown>,
  settings: {
    linearAutoTransition: true,
    linearAutoTransitionStateId: " st-settings ",
    linearAutoTransitionStateName: "Doing",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
  },
}));
vi.mock("./linear-connections.js", () => ({ getConnection: vi.fn(() => h.conn) }));
vi.mock("./settings-manager.js", () => ({ getSettings: () => h.settings }));

import { getConnection } from "./linear-connections.js";
import { isConfigured, linkCovers, resolveTransitionRule } from "./domain-linear.js";
import type { DomainLinearLink } from "./domain-store.js";

const link: DomainLinearLink = {
  connectionId: "conn-bskts",
  teamId: "team-bsk",
  autoTransition: { enabled: true, stateId: "st-progress", stateName: "In Progress" },
  archiveTransition: { enabled: false, stateId: "", stateName: "" },
};

beforeEach(() => {
  h.conn = {
    id: "conn-bskts",
    autoTransition: true,
    autoTransitionStateId: "st-conn-start",
    autoTransitionStateName: "Todo",
    archiveTransition: true,
    archiveTransitionStateId: "st-conn-archive",
    archiveTransitionStateName: "Backlog",
  };
  vi.mocked(getConnection).mockClear();
});

describe("linkCovers", () => {
  // A domain rule names states of ONE team: it may only apply to issues of
  // that workspace and team, never to an issue of another workspace.
  it("needs the same connection, and the same team when the team is known", () => {
    expect(linkCovers(link, "conn-bskts", "team-bsk")).toBe(true);
    expect(linkCovers(link, "conn-bskts")).toBe(true);
    expect(linkCovers(link, "conn-bskts", "team-other")).toBe(false);
    expect(linkCovers(link, "conn-croll83", "team-bsk")).toBe(false);
    expect(linkCovers(undefined, "conn-bskts")).toBe(false);
  });
});

describe("resolveTransitionRule", () => {
  it("uses the domain's own rule for its team", () => {
    expect(resolveTransitionRule("start", { link, connectionId: "conn-bskts", teamId: "team-bsk" })).toEqual({
      enabled: true, stateId: "st-progress", stateName: "In Progress", source: "domain",
    });
  });

  // An explicit "off" in the domain wins over an enabled connection rule.
  it("lets a domain turn a rule off even when the connection has it on", () => {
    const rule = resolveTransitionRule("archive", { link, connectionId: "conn-bskts", teamId: "team-bsk" });
    expect(rule).toMatchObject({ enabled: false, source: "domain" });
    expect(isConfigured(rule)).toBe(false);
  });

  // Migration: a domain without its own rule keeps today's per-connection behaviour.
  it("falls back to the connection when the domain has no rule of that kind", () => {
    const bare: DomainLinearLink = { connectionId: "conn-bskts", teamId: "team-bsk" };
    expect(resolveTransitionRule("archive", { link: bare, connectionId: "conn-bskts" })).toEqual({
      enabled: true, stateId: "st-conn-archive", stateName: "Backlog", source: "connection",
    });
    expect(resolveTransitionRule("start", { connectionId: "conn-bskts" })).toMatchObject({ stateId: "st-conn-start", source: "connection" });
  });

  it("falls back to the connection for an issue of another team", () => {
    expect(resolveTransitionRule("start", { link, connectionId: "conn-bskts", teamId: "team-other" }).source).toBe("connection");
  });

  // The legacy settings.json key ("legacy" connection) has no connection record.
  it("uses settings.json for the legacy key and for unknown connections", () => {
    const rule = resolveTransitionRule("start", { connectionId: "legacy" });
    expect(rule).toEqual({ enabled: true, stateId: "st-settings", stateName: "Doing", source: "settings" });
    expect(getConnection).not.toHaveBeenCalled();
    h.conn = null;
    expect(resolveTransitionRule("archive", { connectionId: "gone" })).toEqual({
      enabled: false, stateId: "", stateName: "", source: "settings",
    });
  });

  it("isConfigured needs both the switch and a state", () => {
    expect(isConfigured({ enabled: true, stateId: "x", stateName: "", source: "domain" })).toBe(true);
    expect(isConfigured({ enabled: true, stateId: "", stateName: "", source: "connection" })).toBe(false);
  });
});
