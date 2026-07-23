/**
 * Qoder Protocol — deep module public interface.
 *
 * Production callers (executor, models, usage) use this surface only.
 * Cosy/encode/body/SSE helpers: sibling files or test-utils.js.
 *
 * Profile selects intl (production). CN_WORK_PROFILE is data/stub only
 * until a later wire-in task; do not register a CN provider here.
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
  CN_WORK_PROFILE,
  DEFAULT_PROFILE,
  PROFILES,
  resolveProfile,
} from "./profile.js";

export {
  INTL_PROFILE,
  CN_WORK_PROFILE,
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
