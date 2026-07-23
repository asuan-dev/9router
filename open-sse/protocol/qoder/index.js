/**
 * Qoder Protocol — deep module public interface (minimal reverse-proxy core).
 *
 * Production callers: chat / catalog / getQuota / resolveProfile / createProtocol.
 * Internals: encoding, cosy, body, sse (test-utils or sibling files).
 *
 * One production profile today: intl. Additional regions (e.g. CN) are added
 * later as Profile data + thin adapter — not forked protocol code.
 */

import { chat } from "./chat.js";
import {
  getQoderModelConfig,
  resolveQoderModels,
  invalidateQoderCatalog,
  clearQoderCatalog,
} from "./catalog.js";
import { getQuota } from "./quota.js";
import {
  INTL_PROFILE,
  DEFAULT_PROFILE,
  PROFILES,
  resolveProfile,
} from "./profile.js";

export {
  INTL_PROFILE,
  DEFAULT_PROFILE,
  PROFILES,
  resolveProfile,
  chat,
  getQoderModelConfig,
  resolveQoderModels,
  invalidateQoderCatalog,
  clearQoderCatalog,
  getQuota,
};

/**
 * Bind a profile once for chat/catalog/quota.
 * @param {string | import("./profile.js").QoderProfile | null | undefined} profileOrId
 */
export function createProtocol(profileOrId = null) {
  const profile = resolveProfile(profileOrId);
  return {
    profile,
    chat: (opts) => chat({ ...opts, profile }),
    getQuota: (accessToken, options = {}) =>
      getQuota(accessToken, { ...options, profile }),
    resolveModels: (credentials, options = {}) =>
      resolveQoderModels(credentials, { ...options, profile }),
    getModelConfig: (credentials, modelKey, options = {}) =>
      getQoderModelConfig(credentials, modelKey, { ...options, profile }),
  };
}
