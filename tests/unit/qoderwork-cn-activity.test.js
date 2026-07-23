import { describe, it, expect, vi, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import {
  getQoderworkCheckinStatus,
  claimQoderworkDailyCheckin,
  getQoderworkProEligibility,
  runQoderworkActivity,
  PATHS,
} from "../../open-sse/services/activities/qoderwork-cn.js";

describe("qoderwork-cn activities", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it("checkin status hits sash path", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await getQoderworkCheckinStatus("tok");
    expect(r.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/sash/api/v1/me/daily-check-in/status",
    );
  });

  it("claim posts to claim path", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ claimed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await claimQoderworkDailyCheckin("tok");
    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(String(fetchMock.mock.calls[0][0])).toBe(PATHS.checkinClaim);
  });

  it("pro eligibility uses growth path", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ eligible: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await getQoderworkProEligibility("tok");
    expect(r.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("pro-upgrade/eligibility");
  });

  it("runQoderworkActivity dispatches", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await runQoderworkActivity("invitation-code", "tok");
    expect(r.ok).toBe(true);
  });

  it("missing token fails", async () => {
    const r = await getQoderworkCheckinStatus("");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing_token");
  });
});
