import { describe, it, expect, vi, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import {
  getQoderworkCheckinStatus,
  qoderworkCnProvider,
} from "../../open-sse/services/activities/providers/qoderwork-cn.js";
import { CN_WORK_PROFILE } from "../../open-sse/protocol/qoder/profile.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("qoderwork-cn activity provider", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it("fetches raw status with profile-owned URL and QoderWork identity", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { status: "CLAIMED" } }));

    const result = await getQoderworkCheckinStatus("tok");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      CN_WORK_PROFILE.checkin.statusUrl,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          "User-Agent": "QoderWork",
        }),
      }),
      null,
    );
  });

  it("maps adapter status through the ActivityProvider interface", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { status: "CLAIMED", rewardCredits: 80 } }),
    );

    const result = await qoderworkCnProvider.checkin.checkStatus({ accessToken: "tok" });

    expect(result).toMatchObject({ done: true, ok: true, credits: 80 });
  });

  it("claims through the profile-owned URL with QoderWork identity", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { status: "CLAIMED", rewardCredits: 50 } }),
    );

    const result = await qoderworkCnProvider.checkin.claim({ accessToken: "tok" });

    expect(result).toMatchObject({ ok: true, already: false, credits: 50 });
    expect(fetchMock).toHaveBeenCalledWith(
      CN_WORK_PROFILE.checkin.claimUrl,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "User-Agent": "QoderWork" }),
      }),
      null,
    );
  });

  it("returns the raw-status helper contract when token is missing", async () => {
    await expect(getQoderworkCheckinStatus("")).resolves.toEqual({ ok: false, data: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
