import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCheckinProviderIds } from "../../open-sse/services/activities/registry.js";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("provider activity feature metadata", () => {
  it("matches every registered check-in adapter in registry and UI views", () => {
    const checkinIds = [...getCheckinProviderIds()].sort();
    const featureIds = REGISTRY
      .filter((entry) => entry.features?.checkin === true)
      .map((entry) => entry.id)
      .sort();

    expect(featureIds).toEqual(checkinIds);
    for (const providerId of checkinIds) {
      expect(AI_PROVIDERS[providerId]?.features?.checkin).toBe(true);
    }
  });
});
