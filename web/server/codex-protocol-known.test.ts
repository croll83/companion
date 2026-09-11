import { describe, it, expect } from "vitest";
import {
  isKnownServerNotification,
  isKnownServerRequest,
  knownMethodCounts,
} from "./codex-protocol-known.js";

// The point of this module is to stop treating "a notification we don't act on"
// as "Codex changed the protocol". Only the latter should ever reach the user.
describe("codex known-method lists", () => {
  it("recognises the notifications that used to raise a false drift banner", () => {
    for (const m of [
      "thread/goal/updated",      // the one Marco hit on 2026-09-11
      "thread/goal/cleared",
      "thread/settings/updated",
      "remoteControl/status/changed",
    ]) {
      expect(isKnownServerNotification(m), m).toBe(true);
    }
  });

  it("recognises notifications we do handle, and server requests", () => {
    expect(isKnownServerNotification("turn/completed")).toBe(true);
    expect(isKnownServerNotification("item/started")).toBe(true);
    expect(isKnownServerRequest("applyPatchApproval")).toBe(true);
    expect(isKnownServerRequest("execCommandApproval")).toBe(true);
  });

  it("does NOT recognise something outside the protocol (that is real drift)", () => {
    expect(isKnownServerNotification("thread/teleport/engaged")).toBe(false);
    expect(isKnownServerRequest("thread/teleport/engaged")).toBe(false);
    expect(isKnownServerNotification("")).toBe(false);
  });

  it("keeps notifications and requests in separate namespaces", () => {
    // A request must not silently pass as a notification: requests block and
    // must keep their louder handling.
    expect(isKnownServerNotification("applyPatchApproval")).toBe(false);
    expect(isKnownServerRequest("turn/completed")).toBe(false);
  });

  it("fails loudly if the generated file was truncated or emptied", () => {
    // A broken regeneration would silence EVERY drift, which is worse than the
    // noise it replaced — so assert the lists are substantial.
    const { notifications, requests } = knownMethodCounts();
    expect(notifications).toBeGreaterThan(50);
    expect(requests).toBeGreaterThan(5);
  });
});
