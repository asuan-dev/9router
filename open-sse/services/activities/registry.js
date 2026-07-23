/**
 * Activity provider registry.
 *
 * Each provider file exports a standard interface:
 * {
 *   providerId: string,
 *   timezone: string,              // IANA tz for "day boundary" (e.g. "Asia/Shanghai")
 *   checkin: {
 *     checkStatus(conn, proxyOptions) → { done: boolean, message: string, credits?: number }
 *     claim(conn, proxyOptions)       → { ok: boolean, already?: boolean, message: string, credits?: number }
 *     resolveAuth(conn)               → { token: string, meta?: object } | null
 *   }
 * }
 *
 * Adding a new provider: create a file in ./providers/, import it here.
 */

import { codebuddyCnProvider } from "./providers/codebuddy-cn.js";
import { qoderworkCnProvider } from "./providers/qoderwork-cn.js";

/** @type {Map<string, import("./types.js").ActivityProvider>} */
const REGISTRY = new Map();

function register(provider) {
  REGISTRY.set(provider.providerId, provider);
}

register(codebuddyCnProvider);
register(qoderworkCnProvider);

/** Get a provider by id, or null. */
export function getActivityProvider(providerId) {
  return REGISTRY.get(providerId) || null;
}

/** All registered provider ids that support check-in. */
export function getCheckinProviderIds() {
  return [...REGISTRY.values()]
    .filter((p) => p.checkin)
    .map((p) => p.providerId);
}

/** All registered providers. */
export function getAllActivityProviders() {
  return [...REGISTRY.values()];
}
