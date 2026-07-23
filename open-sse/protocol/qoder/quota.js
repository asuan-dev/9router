/**
 * Qoder quota/usage (Bearer, not Cosy).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { resolveProfile } from "./profile.js";

/**
 * @param {string} accessToken
 * @param {object} [options]
 * @param {any} [options.proxyOptions]
 * @param {any} [options.profile]
 */
export async function getQuota(accessToken, options = {}) {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  const profile = resolveProfile(options.profile);
  try {
    const response = await proxyAwareFetch(
      profile.quotaUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      options.proxyOptions ?? null,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}
