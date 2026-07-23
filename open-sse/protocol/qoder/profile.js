/**
 * Qoder protocol profiles (intl now; cn-work later).
 * Hosts + product fields live here so chat implementation stays profile-agnostic.
 */

import {
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_LIST_URL,
  QODER_QUOTA_USAGE_URL,
  QODER_OPENAPI_BASE,
  QODER_CHAT_BASE,
} from "./constants.js";

/** @typedef {{ id: string, chatUrl: string, modelListUrl: string, quotaUrl: string, openApiBase: string, chatBase: string, sessionType: string, businessProduct: string, businessVersion: string }} QoderProfile */

/** @type {QoderProfile} */
export const INTL_PROFILE = {
  id: "intl",
  chatUrl: QODER_CHAT_URL_ENCODED,
  modelListUrl: QODER_MODEL_LIST_URL,
  quotaUrl: QODER_QUOTA_USAGE_URL,
  openApiBase: QODER_OPENAPI_BASE,
  chatBase: QODER_CHAT_BASE,
  sessionType: "qodercli",
  businessProduct: "cli",
  businessVersion: "1.0.0",
};

/** @type {QoderProfile} */
export const DEFAULT_PROFILE = INTL_PROFILE;

/**
 * @param {string | QoderProfile | null | undefined} profileOrId
 * @returns {QoderProfile}
 */
export function resolveProfile(profileOrId) {
  if (!profileOrId) return DEFAULT_PROFILE;
  if (typeof profileOrId === "object" && profileOrId.chatUrl) return profileOrId;
  if (profileOrId === "intl") return INTL_PROFILE;
  return DEFAULT_PROFILE;
}
