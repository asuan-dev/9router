import { describe, it, expect, beforeEach } from "vitest";
import {
  setLiveCapabilities,
  getLiveCapability,
  hasLiveCapabilities,
  clearLiveCapabilities,
  getLiveCapabilitiesMeta,
  dumpLiveCapabilities,
} from "../../open-sse/providers/liveCapabilities.js";

describe("liveCapabilities overlay", () => {
  beforeEach(() => {
    clearLiveCapabilities("test");
    clearLiveCapabilities("prefixed");
  });

  it("publishes and looks up by exact id", () => {
    setLiveCapabilities("test", { "glm-4.7": { vision: false, reasoning: true } });
    expect(getLiveCapability("test", "glm-4.7")).toEqual({ vision: false, reasoning: true });
  });

  it("looks up by base id when given a vendor-prefixed model", () => {
    setLiveCapabilities("test", { "claude-sonnet-4.6": { vision: true } });
    expect(getLiveCapability("test", "anthropic/claude-sonnet-4.6")).toEqual({ vision: true });
  });

  it("returns null for unknown provider or model", () => {
    setLiveCapabilities("test", { "glm-4.7": { vision: false } });
    expect(getLiveCapability("other", "glm-4.7")).toBeNull();
    expect(getLiveCapability("test", "unknown")).toBeNull();
  });

  it("hasLiveCapabilities reflects publish / clear", () => {
    expect(hasLiveCapabilities("test")).toBe(false);
    setLiveCapabilities("test", { "glm-4.7": { vision: false } });
    expect(hasLiveCapabilities("test")).toBe(true);
    clearLiveCapabilities("test");
    expect(hasLiveCapabilities("test")).toBe(false);
  });

  it("stores metadata from the publish call", () => {
    setLiveCapabilities("test", { "glm-4.7": {} }, { fetchedAt: "2026-07-29T10:00:00Z", source: "live" });
    const meta = getLiveCapabilitiesMeta("test");
    expect(meta.fetchedAt).toBe("2026-07-29T10:00:00Z");
    expect(meta.source).toBe("live");
  });

  it("replaces previous set on re-publish (not merge)", () => {
    setLiveCapabilities("test", { "a": { vision: true }, "b": { vision: false } });
    setLiveCapabilities("test", { "c": { vision: true } });
    expect(getLiveCapability("test", "a")).toBeNull();
    expect(getLiveCapability("test", "b")).toBeNull();
    expect(getLiveCapability("test", "c")).toEqual({ vision: true });
  });

  it("dump returns a snapshot keyed by provider", () => {
    setLiveCapabilities("test", { "glm-4.7": { vision: false } });
    const dump = dumpLiveCapabilities();
    expect(dump).toHaveProperty("test");
  });
});
