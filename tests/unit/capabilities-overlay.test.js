import { describe, it, expect, beforeEach } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { setLiveCapabilities, clearLiveCapabilities } from "../../open-sse/providers/liveCapabilities.js";

describe("getCapabilitiesForModel live overlay integration", () => {
  const PROVIDER = "codebuddy-cn-test";

  beforeEach(() => {
    clearLiveCapabilities(PROVIDER);
  });

  it("falls back to static chain when no live data", () => {
    const caps = getCapabilitiesForModel(PROVIDER, "some-unknown-model");
    expect(caps).toBeDefined();
    expect(typeof caps.vision).toBe("boolean");
  });

  it("live overlay overrides static vision flag", () => {
    // glm-4.7 is vision:false in the hand table.
    const before = getCapabilitiesForModel(PROVIDER, "glm-4.7");
    expect(before.vision).toBe(false);

    setLiveCapabilities(PROVIDER, { "glm-4.7": { vision: true } });
    const after = getCapabilitiesForModel(PROVIDER, "glm-4.7");
    expect(after.vision).toBe(true);
  });

  it("live data merges over static, preserving unexpressed fields", () => {
    // Set a partial live patch (only contextWindow) — reasoning from static must survive.
    setLiveCapabilities(PROVIDER, { "glm-4.7": { contextWindow: 999000 } });
    const caps = getCapabilitiesForModel(PROVIDER, "glm-4.7");
    expect(caps.contextWindow).toBe(999000);
    // Static chain still contributes whatever it had for glm-4.7
    expect(typeof caps.vision).toBe("boolean");
  });

  it("resolves vendor-prefixed model ids", () => {
    setLiveCapabilities(PROVIDER, { "hy3": { vision: true, reasoning: true } });
    const caps = getCapabilitiesForModel(PROVIDER, "codebuddy-cn/hy3");
    expect(caps.vision).toBe(true);
  });

  it("clearing the overlay reverts to static", () => {
    setLiveCapabilities(PROVIDER, { "glm-4.7": { vision: true } });
    expect(getCapabilitiesForModel(PROVIDER, "glm-4.7").vision).toBe(true);
    clearLiveCapabilities(PROVIDER);
    expect(getCapabilitiesForModel(PROVIDER, "glm-4.7").vision).toBe(false);
  });
});
