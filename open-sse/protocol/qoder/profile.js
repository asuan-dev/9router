/**
 * Qoder protocol profiles.
 *
 * Production: INTL_PROFILE only (wired by qoder adapter).
 * Region/product knobs live here so chat stays profile-agnostic.
 * CN profile is added later when wiring qoderwork-cn — not stubbed here.
 */

import {
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_LIST_URL,
  QODER_QUOTA_USAGE_URL,
  QODER_OPENAPI_BASE,
  QODER_CHAT_BASE,
  QODER_CENTER_BASE,
  QODER_LOGIN_URL,
  QODER_DEVICE_TOKEN_URL,
  QODER_USERINFO_URL,
  QODER_REFRESH_TOKEN_URL,
  QODER_IDE_VERSION,
  QODER_CLIENT_TYPE,
  QODER_DATA_POLICY,
  QODER_LOGIN_VERSION,
  QODER_MACHINE_OS,
  QODER_MACHINE_TYPE,
} from "./constants.js";

/**
 * @typedef {object} QoderProfile
 * @property {string} id
 * @property {string} openApiBase
 * @property {string} chatBase
 * @property {string} [centerBase]
 * @property {string} chatUrl
 * @property {string} modelListUrl
 * @property {string} quotaUrl
 * @property {string} deviceTokenUrl
 * @property {string} userInfoUrl
 * @property {string} loginUrl
 * @property {string} [refreshTokenUrl]
 * @property {string} sessionType
 * @property {string} businessProduct
 * @property {string} businessVersion
 * @property {string} clientType
 * @property {string} ideVersion
 * @property {string} loginVersion
 * @property {string} dataPolicy
 * @property {string} machineOs
 * @property {string} machineType
 */

/** @type {QoderProfile} */
export const INTL_PROFILE = {
  id: "intl",
  openApiBase: QODER_OPENAPI_BASE,
  chatBase: QODER_CHAT_BASE,
  centerBase: QODER_CENTER_BASE,
  chatUrl: QODER_CHAT_URL_ENCODED,
  modelListUrl: QODER_MODEL_LIST_URL,
  quotaUrl: QODER_QUOTA_USAGE_URL,
  deviceTokenUrl: QODER_DEVICE_TOKEN_URL,
  userInfoUrl: QODER_USERINFO_URL,
  loginUrl: QODER_LOGIN_URL,
  refreshTokenUrl: QODER_REFRESH_TOKEN_URL,
  sessionType: "qodercli",
  businessProduct: "cli",
  businessVersion: "1.0.0",
  clientType: QODER_CLIENT_TYPE,
  ideVersion: QODER_IDE_VERSION,
  loginVersion: QODER_LOGIN_VERSION,
  dataPolicy: QODER_DATA_POLICY,
  machineOs: QODER_MACHINE_OS,
  machineType: QODER_MACHINE_TYPE,
};

/** @type {QoderProfile} */
export const DEFAULT_PROFILE = INTL_PROFILE;

/** @type {Record<string, QoderProfile>} */
export const PROFILES = {
  intl: INTL_PROFILE,
};

/**
 * @param {string | QoderProfile | null | undefined} profileOrId
 * @returns {QoderProfile}
 */
export function resolveProfile(profileOrId) {
  if (profileOrId == null || profileOrId === "") return DEFAULT_PROFILE;
  if (typeof profileOrId === "object") {
    if (!profileOrId.chatUrl) {
      throw new Error("qoder profile object requires chatUrl");
    }
    return profileOrId;
  }
  if (typeof profileOrId === "string") {
    const found = PROFILES[profileOrId];
    if (found) return found;
    throw new Error(`qoder: unknown protocol profile "${profileOrId}"`);
  }
  throw new Error("qoder: invalid protocol profile");
}
