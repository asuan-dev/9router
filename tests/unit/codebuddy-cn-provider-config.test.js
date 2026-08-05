import { afterEach, describe, expect, it, vi } from "vitest";

const proxyFetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

import { PROVIDERS } from "../../open-sse/providers/index.js";
import { resolveCodebuddyCnModels } from "../../open-sse/services/codebuddyCnModels.js";
import { codebuddyCnProvider } from "../../open-sse/services/activities/providers/codebuddy-cn.js";

const originalFetch = global.fetch;
const config = PROVIDERS["codebuddy-cn"];

afterEach(() => {
  global.fetch = originalFetch;
  proxyFetchMock.mockReset();
});

describe("CodeBuddy CN provider-owned service transport", () => {
  it("uses registry model-discovery endpoint and headers", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            models: [{ id: "glm-5.2", name: "GLM-5.2", supportsReasoning: true }],
            agents: [{ name: "cli", models: ["glm-5.2"] }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      resolveCodebuddyCnModels({
        accessToken: "model-token",
        providerSpecificData: { enterpriseId: "enterprise-1" },
      }),
    ).resolves.toMatchObject({ models: [{ id: "glm-5.2", name: "GLM-5.2" }] });

    expect(global.fetch).toHaveBeenCalledWith(
      config.modelDiscovery.urlTemplate.replace("{enterpriseId}", "enterprise-1"),
      expect.objectContaining({
        method: "GET",
        headers: {
          ...config.modelDiscovery.headers,
          Authorization: "Bearer model-token",
        },
      }),
    );
  });

  it("uses registry activity endpoint and headers", async () => {
    proxyFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { today_checked_in: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      codebuddyCnProvider.checkin.checkStatus({
        accessToken: "activity-token",
        providerSpecificData: { uid: "user-1" },
      }),
    ).resolves.toMatchObject({ ok: true, done: false });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      config.activity.statusUrl,
      {
        method: "POST",
        headers: {
          ...config.activity.headers,
          Authorization: "Bearer activity-token",
          "X-User-Id": "user-1",
        },
        body: "{}",
      },
      null,
    );
  });
});
