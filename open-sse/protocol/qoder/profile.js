/**
 * Qoder protocol profiles.
 *
 * Production: INTL_PROFILE only (wired by qoder adapter).
 * CN_WORK_PROFILE is a lab-backed data stub for composition tests /
 * future wire-in — not registered as a provider in this task.
 *
 * Chat/Cosy/catalog/quota/OAuth must read hosts + fingerprints from the
 * resolved profile so a later CN adapter is profile-only, not a fork.
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
  QODER_CHAT_SIG_PATH,
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
 * @property {string} [sashBase]
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
  sashBase: `${QODER_OPENAPI_BASE}/sash/api/v1`,
};

/**
 * Lab-backed CN hosts (QoderWork CN 0.6.7 inventory). Data only — not wired
 * to registry/executor/OAuth in this architecture task.
 * @type {QoderProfile}
 */
export const CN_WORK_PROFILE = {
  id: "cn-work",
  openApiBase: "https://openapi.qoder.com.cn",
  chatBase: "https://gateway.qoder.com.cn",
  centerBase: "https://gateway.qoder.com.cn",
  chatUrl: `https://gateway.qoder.com.cn/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
  modelListUrl: "https://gateway.qoder.com.cn/algo/api/v2/model/list",
  quotaUrl: "https://openapi.qoder.com.cn/api/v2/quota/usage",
  deviceTokenUrl: "https://openapi.qoder.com.cn/api/v1/deviceToken/poll",
  userInfoUrl: "https://openapi.qoder.com.cn/api/v1/userinfo",
  loginUrl: "https://qoder.com.cn/device/selectAccounts",
  refreshTokenUrl: "https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token",
  sessionType: "qoderworkcn",
  businessProduct: "qoderworkcn",
  businessVersion: "1.0.0",
  clientType: QODER_CLIENT_TYPE,
  ideVersion: QODER_IDE_VERSION,
  loginVersion: QODER_LOGIN_VERSION,
  dataPolicy: QODER_DATA_POLICY,
  machineOs: QODER_MACHINE_OS,
  machineType: QODER_MACHINE_TYPE,
  sashBase: "https://openapi.qoder.com.cn/sash/api/v1",
};

/** @type {QoderProfile} */
export const DEFAULT_PROFILE = INTL_PROFILE;

/** @type {Record<string, QoderProfile>} */
export const PROFILES = {
  intl: INTL_PROFILE,
  "cn-work": CN_WORK_PROFILE,
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
