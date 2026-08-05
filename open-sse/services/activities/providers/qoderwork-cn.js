/**
 * QoderWork CN activity provider (daily check-in).
 */

import { proxyAwareFetch } from "../../../utils/proxyFetch.js";
import { CN_WORK_PROFILE } from "../../../protocol/qoder/profile.js";

const { statusUrl: STATUS_URL, claimUrl: CLAIM_URL, userAgent: CHECKIN_USER_AGENT } =
  CN_WORK_PROFILE.checkin;

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": CHECKIN_USER_AGENT,
  };
}

async function request(method, url, token, proxyOptions, body = null) {
  const opts = { method, headers: buildHeaders(token) };
  if (body) opts.body = JSON.stringify(body);
  const response = await proxyAwareFetch(url, opts, proxyOptions);
  let data = null;
  try { data = await response.json(); } catch { /* ignore */ }
  return { status: response.status, data, ok: response.ok };
}

/**
 * Raw daily-check-in status for the profile-refresh route, which maps the
 * unmodified sash body into connection badge fields via mapQoderworkCheckinStatus.
 * Returns { ok, data } (data = raw JSON body); does not normalize.
 * @param {string} token
 * @param {object|null} proxyOptions
 * @returns {Promise<{ ok: boolean, data: object|null }>}
 */
export async function getQoderworkCheckinStatus(token, proxyOptions = null) {
  if (!token) return { ok: false, data: null };
  try {
    const { data, ok } = await request("GET", STATUS_URL, token, proxyOptions);
    return { ok: ok && data?.success !== false, data };
  } catch {
    return { ok: false, data: null };
  }
}

export const qoderworkCnProvider = {
  providerId: "qoderwork-cn",
  timezone: "Asia/Shanghai",

  checkin: {
    resolveAuth(conn) {
      const token = conn.accessToken || conn.token;
      if (!token) return null;
      return { token, meta: {} };
    },

    async checkStatus(conn, proxyOptions = null) {
      const auth = this.resolveAuth(conn);
      if (!auth) return { done: false, ok: false, message: "missing token" };
      try {
        const { status, data } = await request("GET", STATUS_URL, auth.token, proxyOptions);
        if (status === 401 || status === 403) {
          return { done: false, ok: false, message: data?.message || "auth failed" };
        }
        if (!data || data.success === false) {
          return { done: false, ok: false, message: data?.message || `HTTP ${status}` };
        }
        const payload = data.data || data;
        const state = String(payload.status || payload.state || "").toUpperCase();
        const done = state === "CLAIMED" || state === "DONE" || payload.claimed === true;
        return {
          done,
          ok: true,
          message: done
            ? (payload.rewardCredits != null ? `已签到 +${payload.rewardCredits}` : "已签到")
            : "未签到",
          credits: payload.rewardCredits ?? payload.credit ?? null,
        };
      } catch (e) {
        return { done: false, ok: false, message: e.message };
      }
    },

    async claim(conn, proxyOptions = null) {
      const auth = this.resolveAuth(conn);
      if (!auth) return { ok: false, message: "missing token" };
      try {
        const { status, data } = await request("POST", CLAIM_URL, auth.token, proxyOptions, {});
        if (status === 401 || status === 403) {
          return { ok: false, message: data?.message || "auth failed" };
        }
        const payload = data?.data || data || {};
        // Already claimed
        const state = String(payload.status || payload.state || "").toUpperCase();
        if (state === "ALREADY_CLAIMED" || payload.already === true) {
          return { ok: true, already: true, message: "已签到", credits: payload.rewardCredits ?? null };
        }
        if (!data || data.success === false) {
          return { ok: false, message: data?.message || `HTTP ${status}` };
        }
        return {
          ok: true,
          already: false,
          message: payload.rewardCredits != null ? `签到成功 +${payload.rewardCredits}` : "签到成功",
          credits: payload.rewardCredits ?? null,
        };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },
  },
};
