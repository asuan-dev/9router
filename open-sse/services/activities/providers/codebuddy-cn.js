/**
 * CodeBuddy CN / WorkBuddy — activity provider (daily check-in).
 * Endpoint: copilot.tencent.com "Buddy 加油站"
 */

import { proxyAwareFetch } from "../../../utils/proxyFetch.js";
import { extractCodebuddyProfileFromToken } from "../../../../src/shared/utils/codebuddyProfile.js";

const BASE = "https://copilot.tencent.com";
const STATUS_URL = `${BASE}/v2/billing/meter/checkin-activity-status`;
const CLAIM_URL = `${BASE}/v2/billing/meter/daily-checkin`;

const CHECKIN_ALREADY_CODE = 10001;

function buildHeaders(token, uid) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (uid) headers["X-User-Id"] = String(uid);
  return headers;
}

async function postJson(url, token, uid, proxyOptions) {
  const response = await proxyAwareFetch(
    url,
    { method: "POST", headers: buildHeaders(token, uid), body: "{}" },
    proxyOptions,
  );
  let body = null;
  try { body = await response.json(); } catch { /* ignore */ }
  return { status: response.status, body, ok: response.ok };
}

function resolveUid(conn) {
  const fromPsd = conn.providerSpecificData?.uid;
  if (fromPsd) return String(fromPsd);
  if (!conn.accessToken) return null;
  return extractCodebuddyProfileFromToken(conn.accessToken).sub || null;
}

export const codebuddyCnProvider = {
  providerId: "codebuddy-cn",
  timezone: "Asia/Shanghai",

  checkin: {
    /** Resolve auth credentials from connection. Null = cannot authenticate. */
    resolveAuth(conn) {
      const token = conn.accessToken;
      if (!token) return null;
      const uid = resolveUid(conn);
      if (!uid) return null;
      return { token, meta: { uid } };
    },

    /** Check if already checked in today. */
    async checkStatus(conn, proxyOptions = null) {
      const auth = this.resolveAuth(conn);
      if (!auth) return { done: false, ok: false, message: "missing token or uid" };
      try {
        const { status, body } = await postJson(STATUS_URL, auth.token, auth.meta.uid, proxyOptions);
        if (status === 401 || status === 403) {
          return { done: false, ok: false, message: body?.msg || "auth failed" };
        }
        if (!body || body.code !== 0) {
          return { done: false, ok: false, message: body?.msg || `HTTP ${status}` };
        }
        const done = body.data?.today_checked_in === true;
        return {
          done,
          ok: true,
          message: done ? (body.data?.theme_name || "已签到") : "未签到",
          credits: body.data?.credit ?? null,
        };
      } catch (e) {
        return { done: false, ok: false, message: e.message };
      }
    },

    /** Claim daily check-in. */
    async claim(conn, proxyOptions = null) {
      const auth = this.resolveAuth(conn);
      if (!auth) return { ok: false, message: "missing token or uid" };
      try {
        const { status, body } = await postJson(CLAIM_URL, auth.token, auth.meta.uid, proxyOptions);
        if (body?.code === CHECKIN_ALREADY_CODE) {
          return { ok: true, already: true, message: body?.msg || "已签到", credits: null };
        }
        if (status === 401 || status === 403) {
          return { ok: false, message: body?.msg || "auth failed" };
        }
        if (!body || body.code !== 0) {
          return { ok: false, message: body?.msg || `HTTP ${status}` };
        }
        return {
          ok: true,
          already: false,
          message: body?.msg || `+${body.data?.credit ?? "?"} 积分`,
          credits: body.data?.credit ?? null,
        };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },
  },
};
