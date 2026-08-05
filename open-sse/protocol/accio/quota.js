/**
 * Accio quota — one endpoint, two layers.
 *
 * Wire: `POST {gateway}/api/entitlement/currentSubscription`
 *       body `{ accessToken, subscripType: "INDIVIDUAL" }`
 *
 * Upstream also exposes billing history, usage bills, grant records and a
 * usage trend. None are wired: 9router's usage contract answers "how much is
 * left", not "where did it go".
 *
 * Response layers (per the desktop client's own reader):
 *   entitlement.daily  { total, remaining, used, nextBillingDate }
 *   top level          { total, remaining }        overall / monthly pool
 *
 * Every failure degrades to `{ message }` so a healthy connection never
 * renders as broken just because usage was unavailable.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { resolveProfile } from "./profile.js";

const FETCH_TIMEOUT_MS = 15_000;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * `nextBillingDate` arrives as Unix ms or an ISO string depending on the
 * layer; normalise both to ISO, or null when absent.
 * @param {number|string|null|undefined} value
 * @returns {string|null}
 */
function toIsoOrNull(value) {
  if (value == null || value === "") return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Build one quota row. `used` is derived when the layer omits it, which the
 * overall pool always does.
 *
 * @param {object} source
 * @param {string|null} resetAt
 * @returns {object}
 */
function layer(source, resetAt) {
  const total = toNumber(source?.total);
  const remaining = toNumber(source?.remaining);
  const used = source?.used == null ? Math.max(0, total - remaining) : toNumber(source.used);
  const remainingPercentage = total > 0 ? (remaining / total) * 100 : 0;

  return {
    total,
    used,
    remaining,
    remainingPercentage,
    unit: "credits",
    resetAt,
    unlimited: total <= 0,
  };
}

/**
 * Map the subscription payload into the shape the usage UI renders.
 *
 * Only layers the account actually has are emitted — a free plan with no
 * monthly pool should not show an empty "overall" row.
 *
 * @param {object} body
 * @returns {{ plan: string, quotas: Record<string, object> }}
 */
export function mapSubscription(body) {
  const daily = body?.entitlement?.daily ?? null;
  const monthlyReset = toIsoOrNull(body?.entitlement?.monthly?.nextBillingDate);
  const dailyReset = toIsoOrNull(daily?.nextBillingDate);

  const quotas = {};

  if (daily && toNumber(daily.total) > 0) {
    quotas.daily = layer(daily, dailyReset);
  }

  const overallTotal = toNumber(body?.total);
  if (overallTotal > 0) {
    quotas.overall = layer(
      { total: overallTotal, remaining: body?.remaining },
      monthlyReset ?? dailyReset,
    );
  }

  const rawPlan = typeof body?.type === "string" ? body.type.trim() : "";
  const plan = rawPlan
    ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1).toLowerCase()
    : "Unknown";

  return { plan, quotas };
}

/**
 * Fetch current credit balances for one credential.
 *
 * @param {string} accessToken
 * @param {object} [options]
 * @param {any} [options.proxyOptions]
 * @param {any} [options.profile]
 * @param {typeof fetch} [options.fetchImpl] - inject for tests
 * @returns {Promise<{ plan: string, quotas: object } | { message: string }>}
 */
export async function getQuota(accessToken, options = {}) {
  if (!accessToken) {
    return { message: "Accio usage unavailable: no access token" };
  }

  const p = resolveProfile(options.profile);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);

  try {
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-app-version": p.appVersion,
        "x-package-region": p.packageRegion,
      },
      body: JSON.stringify({ accessToken, subscripType: p.subscripType }),
      signal: controller.signal,
    };

    const response =
      typeof options.fetchImpl === "function"
        ? await options.fetchImpl(p.subscriptionUrl, init)
        : await proxyAwareFetch(p.subscriptionUrl, init, options.proxyOptions ?? null);

    if (response.status === 401 || response.status === 403) {
      return { message: "Accio access token invalid or expired." };
    }
    if (!response.ok) {
      return { message: `Accio connected. Usage fetch returned ${response.status}.` };
    }

    const payload = await response.json().catch(() => null);
    if (!payload) {
      return { message: "Accio connected. Usage response was not JSON." };
    }

    // The desktop client's gateway helper wraps results as { success, data }.
    const body = payload.data && typeof payload.data === "object" ? payload.data : payload;
    const { plan, quotas } = mapSubscription(body);

    if (Object.keys(quotas).length === 0) {
      return { plan, message: "Accio connected. No credit allocation reported." };
    }
    return { plan, quotas };
  } catch (error) {
    return { message: `Accio connected. Unable to fetch usage: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}
