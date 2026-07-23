/**
 * QoderWork CN sash activities (credits growth card).
 * Evidence: lab/qoderwork-cn/references/wire-profile-cn.md
 *
 * Not part of protocol/qoder chat convert.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { CN_WORK_PROFILE } from "../../protocol/qoder/profile.js";

const OPENAPI = CN_WORK_PROFILE.openApiBase;
const SASH = `${OPENAPI}/sash/api/v1/me`;

export const PATHS = {
  checkinStatus: `${SASH}/daily-check-in/status`,
  checkinClaim: `${SASH}/daily-check-in/claim`,
  proEligibility: `${SASH}/pro-upgrade/eligibility`,
  proClaim: `${SASH}/pro-upgrade/claim`,
  invitationCode: `${SASH}/invitationCode`,
  invitationRewards: `${SASH}/invitationRewards`,
};

function buildHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "QoderWork",
  };
}

async function sashRequest(method, url, accessToken, proxyOptions = null, body = null) {
  if (!accessToken) {
    return { ok: false, error: "missing_token", message: "No access token" };
  }
  try {
    const init = {
      method,
      headers: buildHeaders(accessToken),
    };
    if (body != null) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const response = await proxyAwareFetch(url, init, proxyOptions);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: "auth",
        httpStatus: response.status,
        message: data?.message || data?.error || "auth failed",
        body: data,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: "api",
        httpStatus: response.status,
        message: data?.message || data?.error || `HTTP ${response.status}`,
        body: data,
      };
    }
    return { ok: true, httpStatus: response.status, data, body: data };
  } catch (e) {
    return { ok: false, error: "network", message: e.message };
  }
}

export function getQoderworkCheckinStatus(accessToken, proxyOptions = null) {
  return sashRequest("GET", PATHS.checkinStatus, accessToken, proxyOptions);
}

export function claimQoderworkDailyCheckin(accessToken, proxyOptions = null) {
  return sashRequest("POST", PATHS.checkinClaim, accessToken, proxyOptions, {});
}

export function getQoderworkProEligibility(accessToken, proxyOptions = null) {
  return sashRequest("GET", PATHS.proEligibility, accessToken, proxyOptions);
}

export function claimQoderworkProUpgrade(accessToken, proxyOptions = null) {
  return sashRequest("POST", PATHS.proClaim, accessToken, proxyOptions, {});
}

export function getQoderworkInvitationCode(accessToken, proxyOptions = null) {
  return sashRequest("GET", PATHS.invitationCode, accessToken, proxyOptions);
}

export function getQoderworkInvitationRewards(accessToken, proxyOptions = null) {
  return sashRequest("GET", PATHS.invitationRewards, accessToken, proxyOptions);
}

/**
 * @param {"checkin-status"|"checkin-claim"|"pro-eligibility"|"pro-claim"|"invitation-code"|"invitation-rewards"} action
 */
export async function runQoderworkActivity(action, accessToken, proxyOptions = null) {
  switch (action) {
    case "checkin-status":
      return getQoderworkCheckinStatus(accessToken, proxyOptions);
    case "checkin-claim":
      return claimQoderworkDailyCheckin(accessToken, proxyOptions);
    case "pro-eligibility":
      return getQoderworkProEligibility(accessToken, proxyOptions);
    case "pro-claim":
      return claimQoderworkProUpgrade(accessToken, proxyOptions);
    case "invitation-code":
      return getQoderworkInvitationCode(accessToken, proxyOptions);
    case "invitation-rewards":
      return getQoderworkInvitationRewards(accessToken, proxyOptions);
    default:
      return { ok: false, error: "unknown_action", message: `Unknown action: ${action}` };
  }
}
