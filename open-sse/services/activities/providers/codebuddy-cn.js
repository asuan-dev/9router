/** CodeBuddy CN / WorkBuddy daily check-in adapter. */

import { proxyAwareFetch } from "../../../utils/proxyFetch.js";
import { PROVIDERS } from "../../../providers/index.js";
import { extractCodebuddyProfileFromToken } from "../../../../src/shared/utils/codebuddyProfile.js";

const PROVIDER_ID = "codebuddy-cn";

const CHECKIN_ALREADY_CODE = 10001;

function buildHeaders(config, token, uid) {
  const headers = {
    ...(config?.headers || {}),
    Authorization: `Bearer ${token}`,
  };
  if (uid) headers["X-User-Id"] = String(uid);
  return headers;
}

async function postJson(endpointKey, token, uid, proxyOptions) {
  const config = PROVIDERS[PROVIDER_ID]?.activity;
  const url = config?.[endpointKey];
  if (!url) throw new Error("CodeBuddy CN activity endpoint not configured");
  const response = await proxyAwareFetch(
    url,
    { method: "POST", headers: buildHeaders(config, token, uid), body: "{}" },
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
  providerId: PROVIDER_ID,
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
        const { status, body } = await postJson("statusUrl", auth.token, auth.meta.uid, proxyOptions);
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
        const { status, body } = await postJson("claimUrl", auth.token, auth.meta.uid, proxyOptions);
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
