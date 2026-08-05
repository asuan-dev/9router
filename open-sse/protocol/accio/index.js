/**
 * Accio Protocol — public surface for the reverse-proxy.
 *
 *   chat / createProtocol  — inference
 *   catalog helpers        — live model list
 *   getQuota               — credit balances
 *   resolveProfile         — environment knobs
 *
 * Internals (body, sse, toolSignature) are importable from sibling files for
 * unit tests but are not part of this surface.
 */

import { chat } from "./chat.js";
import {
  resolveAccioModels,
  getAccioModelConfig,
  invalidateAccioCatalog,
  clearAccioCatalog,
} from "./catalog.js";
import { getQuota } from "./quota.js";
import { PROD_PROFILE, resolveProfile } from "./profile.js";

export {
  PROD_PROFILE,
  resolveProfile,
  chat,
  resolveAccioModels,
  getAccioModelConfig,
  invalidateAccioCatalog,
  clearAccioCatalog,
  getQuota,
};

/**
 * Bind a profile once for chat / catalog / quota.
 * @param {string | import("./profile.js").AccioProfile | null | undefined} profileOrId
 */
export function createProtocol(profileOrId = null) {
  const profile = resolveProfile(profileOrId);
  return {
    profile,
    chat: (opts) => chat({ ...opts, profile }),
    getQuota: (accessToken, options = {}) => getQuota(accessToken, { ...options, profile }),
    resolveModels: (credentials, options = {}) =>
      resolveAccioModels(credentials, { ...options, profile }),
    getModelConfig: (credentials, modelCode, options = {}) =>
      getAccioModelConfig(credentials, modelCode, { ...options, profile }),
  };
}
