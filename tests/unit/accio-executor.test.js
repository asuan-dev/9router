/**
 * Unit tests for the Accio executor refresh path.
 *
 * The gateway's refresh endpoint wants the current (possibly expired) access
 * token alongside the refresh token — the one Accio quirk that differs from
 * every other provider's refresh flow. These tests pin that contract on the
 * executor, so a future refactor cannot silently drop the old access token.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { refreshFetchMock } = vi.hoisted(() => ({ refreshFetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => refreshFetchMock(...args),
}));

import { AccioExecutor } from "../../open-sse/executors/accio.js";
import { PROVIDER_OAUTH } from "../../open-sse/providers/index.js";

describe("AccioExecutor refresh", () => {
  beforeEach(() => {
    refreshFetchMock.mockReset();
  });

  it("sends the current access token alongside the refresh token", async () => {
    refreshFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "new-at",
          refreshToken: "new-rt",
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        }),
        { status: 200 },
      ),
    );

    const executor = new AccioExecutor();
    const result = await executor.refreshCredentials(
      { accessToken: "old-at", refreshToken: "old-rt" },
      null,
    );

    const [url, init] = refreshFetchMock.mock.calls[0];
    const body = JSON.parse(init.body);

    // The gateway rejects refreshes that only carry the refresh token.
    expect(body).toEqual({ accessToken: "old-at", refreshToken: "old-rt" });
    expect(url).toContain("/api/auth/refresh_token");

    expect(result.accessToken).toBe("new-at");
    expect(result.refreshToken).toBe("new-rt");
    expect(result.expiresIn).toBeGreaterThan(0);
  });

  it("returns null without a refresh token", async () => {
    const executor = new AccioExecutor();
    await expect(executor.refreshCredentials({ accessToken: "at" }, null)).resolves.toBeNull();
    expect(refreshFetchMock).not.toHaveBeenCalled();
  });

  it("reports invalid_grant on 401 so re-auth can be offered", async () => {
    refreshFetchMock.mockResolvedValue(new Response("{}", { status: 401 }));

    const executor = new AccioExecutor();
    const result = await executor.refreshCredentials(
      { accessToken: "at", refreshToken: "rt" },
      null,
    );

    expect(result).toMatchObject({ error: "invalid_grant" });
  });
});

describe("Accio registry refresh knobs", () => {
  it("declares trackRefreshAt inside the oauth block (where it is read)", () => {
    // oauthCredentialManager reads PROVIDER_OAUTH[provider].trackRefreshAt.
    // A features-block placement would be silently ignored.
    expect(PROVIDER_OAUTH.accio.trackRefreshAt).toBe(true);
  });

  it("points refresh at the gateway endpoint", () => {
    expect(PROVIDER_OAUTH.accio.refreshUrl).toBe(
      "https://phoenix-gw.alibaba.com/api/auth/refresh_token",
    );
  });
});
