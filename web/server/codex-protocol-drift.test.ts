import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_SERVER_NOTIFICATIONS, CODEX_SERVER_REQUESTS } from "./protocol/codex-known-methods.generated.js";

function readFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

function extractMethods(tsSource: string): Set<string> {
  return new Set([...tsSource.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]));
}

function extractCaseMethods(source: string, start: string, end: string): Set<string> {
  const afterStart = source.split(start)[1];
  if (!afterStart) return new Set();
  const block = afterStart.split(end)[0] || "";
  return new Set([...block.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
}

describe("Codex adapter method drift vs upstream protocol snapshot", () => {
  it("keeps handled methods aligned with the upstream protocol (or explicit legacy allowlist)", () => {
    const adapter = readFile("server/codex-adapter.ts");

    const handledNotifications = extractCaseMethods(
      adapter,
      "private handleNotification(method: string, params: Record<string, unknown>): void {",
      "private handleRequest(method: string, id: number, params: Record<string, unknown>): void {",
    );

    const handledRequests = extractCaseMethods(
      adapter,
      "private handleRequest(method: string, id: number, params: Record<string, unknown>): void {",
      "private handleCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {",
    );

    const calledClientMethods = new Set(
      [...adapter.matchAll(/this\.transport\.(?:call|notify)\("([^"]+)"/g)].map((m) => m[1]),
    );

    const upstreamServerNotifications = extractMethods(readFile("server/protocol/codex-upstream/ServerNotification.ts.txt"));
    const upstreamServerRequests = extractMethods(readFile("server/protocol/codex-upstream/ServerRequest.ts.txt"));
    const upstreamClientRequests = extractMethods(readFile("server/protocol/codex-upstream/ClientRequest.ts.txt"));
    const upstreamClientNotifications = extractMethods(readFile("server/protocol/codex-upstream/ClientNotification.ts.txt"));

    // What remains here is genuinely NOT in the current protocol:
    //  - the pre-v2 `codex/event/*` taxonomy, still handled for back-compat;
    //  - two v1 aliases the newer schema renamed;
    //  - one notification Companion itself injects.
    // Everything else that used to live here (thread/settings/updated,
    // remoteControl/status/changed, thread/goal/*, configWarning, …) is covered
    // by the generated list now, so this set stops growing every time Codex
    // adds a notification.
    const legacyNotifications = new Set([
      // v1 aliases: the current schema models these as item/reasoning/textDelta
      // and item/updated respectively.
      "item/updated",
      "item/reasoning/delta",
      // Pre-v2 event taxonomy, still accepted so older CLIs keep working.
      "codex/event/stream_error",
      "codex/event/error",
      "codex/event/token_count",
      "codex/event/agent_message_delta",
      "codex/event/agent_message_content_delta",
      "codex/event/reasoning_content_delta",
      "codex/event/agent_message",
      "codex/event/item_started",
      "codex/event/item_completed",
      "codex/event/exec_command_begin",
      "codex/event/exec_command_output_delta",
      "codex/event/exec_command_end",
      "codex/event/turn_diff",
      "codex/event/terminal_interaction",
      "codex/event/patch_apply_begin",
      "codex/event/patch_apply_end",
      "codex/event/user_message",
      "codex/event/task_started",
      "codex/event/task_complete",
      "codex/event/mcp_startup_complete",
      "codex/event/context_compacted",
      "codex/event/agent_reasoning",
      "codex/event/agent_reasoning_delta",
      "codex/event/agent_reasoning_section_break",
      "codex/event/deprecation_notice",
      "codex/event/mcp_startup_update",
      "codex/event/turn_aborted",
      "codex/event/view_image_tool_call",
      "codex/event/web_search_begin",
      "codex/event/web_search_end",
      // Emitted by codex-ws-proxy.cjs on WebSocket reconnect — ours, not Codex's.
      "companion/wsReconnected",
    ]);

    const legacyServerRequests = new Set([
      "item/mcpToolCall/requestApproval",
    ]);

    const knownNotifications = new Set(CODEX_SERVER_NOTIFICATIONS);
    const knownRequests = new Set(CODEX_SERVER_REQUESTS);

    for (const method of handledNotifications) {
      expect(
        upstreamServerNotifications.has(method)
          || knownNotifications.has(method)
          || legacyNotifications.has(method),
        `Handled notification is in neither the pinned snapshot, the generated method list, nor the legacy allowlist: ${method}`,
      ).toBe(true);
    }

    for (const method of handledRequests) {
      expect(
        upstreamServerRequests.has(method)
          || knownRequests.has(method)
          || legacyServerRequests.has(method),
        `Handled request is in neither the pinned snapshot, the generated method list, nor the legacy allowlist: ${method}`,
      ).toBe(true);
    }

    for (const method of calledClientMethods) {
      expect(
        upstreamClientRequests.has(method) || upstreamClientNotifications.has(method),
        `Unhandled by upstream snapshot (client method): ${method}`,
      ).toBe(true);
    }
  });
});
