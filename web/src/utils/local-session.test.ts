import { describe, it, expect, vi } from "vitest";

/** Labels of a local session: the badge text and the names of its reasoning levels. */
vi.mock("../store.js", () => ({ useStore: () => undefined }));
import { localEffortLabel, localSessionLabel } from "./local-session.js";

describe("local-session", () => {
  it("names the session's provider and model", () => {
    expect(localSessionLabel({ provider: "lab", model: "m", providerName: "Lab", effortLevels: [] })).toBe("Local · Lab/m");
  });

  // The proxy maps Claude Code effort values to model levels: low → "off".
  it("shows the model level's name, else the effort's own label", () => {
    expect(localEffortLabel({ low: "off" }, "low")).toBe("Off");
    expect(localEffortLabel({ low: "off" }, "xhigh")).toBe("X-High");
    expect(localEffortLabel(undefined, "high")).toBe("High");
  });
});
