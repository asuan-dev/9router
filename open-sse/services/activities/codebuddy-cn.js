/**
 * CodeBuddy CN / WorkBuddy daily check-in (Buddy 加油站).
 * Protocol: lab/workbuddy/references/activities-daily-claim.md
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS } from "../../providers/index.js";

const PROVIDER_ID = "codebuddy-cn";
const BASE = "https://copilot.tencent.com";
const STATUS_URL = `${BASE}/v2/billing/meter/checkin-activity-status`;
const CLAIM_URL = `${BASE}/v2/billing/meter/daily-checkin`;

/** Business code: already checked in today */
export const CODEBUDDY_CHECKIN_ALREADY = 10001;

function buildHeaders(accessToken, uid, extra = {}) {
  const headers = {
    ...(PROVIDERS[PROVIDER_ID]?.headers || {}),
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  };
  if (uid) headers["X-User-Id"] = String(uid);
  return headers;
}

async function postJson(url, accessToken, uid, proxyOptions = null) {
  const response = await proxyAwareFetch(
    url,
    {
      method: "POST",
      headers: buildHeaders(accessToken, uid),
      body: "{}",
    },
    proxyOptions,
  );
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, ok: response.ok };
}

/**
 * @param {string} accessToken
 * @param {{ uid?: string }} meta
 * @param {object|null} proxyOptions
 */
export async function getCodebuddyCheckinStatus(accessToken, meta = {}, proxyOptions = null) {
  if (!accessToken) {
    return { ok: false, error: "missing_token", message: "No access token" };
  }
  const uid = meta.uid || null;
  if (!uid) {
    return { ok: false, error: "missing_uid", message: "X-User-Id (JWT sub) required" };
  }
  try {
    const { status, body } = await postJson(STATUS_URL, accessToken, uid, proxyOptions);
    if (status === 401 || status === 403) {
      return { ok: false, error: "auth", httpStatus: status, message: body?.msg || "auth failed", body };
    }
    if (!body || body.code !== 0) {
      return {
        ok: false,
        error: "api",
        httpStatus: status,
        code: body?.code,
        message: body?.msg || `status HTTP ${status}`,
        body,
      };
    }
    return { ok: true, httpStatus: status, data: body.data, body };
  } catch (e) {
    return { ok: false, error: "network", message: e.message };
  }
}

/**
 * @param {string} accessToken
 * @param {{ uid?: string }} meta
 * @param {object|null} proxyOptions
 */
export async function claimCodebuddyDailyCheckin(accessToken, meta = {}, proxyOptions = null) {
  if (!accessToken) {
    return { ok: false, error: "missing_token", message: "No access token" };
  }
  const uid = meta.uid || null;
  if (!uid) {
    return { ok: false, error: "missing_uid", message: "X-User-Id (JWT sub) required" };
  }
  try {
    const { status, body } = await postJson(CLAIM_URL, accessToken, uid, proxyOptions);
    // Already claimed today — treat as successful skip
    if (body?.code === CODEBUDDY_CHECKIN_ALREADY) {
      return {
        ok: true,
        already: true,
        httpStatus: status,
        code: CODEBUDDY_CHECKIN_ALREADY,
        message: body?.msg || "already checked in",
        body,
      };
    }
    if (status === 401 || status === 403) {
      return { ok: false, error: "auth", httpStatus: status, message: body?.msg || "auth failed", body };
    }
    if (!body || body.code !== 0) {
      return {
        ok: false,
        error: "api",
        httpStatus: status,
        code: body?.code,
        message: body?.msg || `claim HTTP ${status}`,
        body,
      };
    }
    return {
      ok: true,
      already: false,
      httpStatus: status,
      data: body.data,
      credit: body.data?.credit,
      streakDays: body.data?.streak_days,
      body,
    };
  } catch (e) {
    return { ok: false, error: "network", message: e.message };
  }
}
