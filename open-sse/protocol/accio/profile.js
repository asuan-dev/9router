/**
 * Accio protocol profiles.
 *
 * Environment knobs live here so chat/catalog/quota stay profile-agnostic.
 * Production: prod. The desktop app also ships pre/offline gateways; only
 * prod is wired because that is the one real accounts authenticate against.
 */

import {
  ACCIO_GATEWAY_BASE,
  ACCIO_LOGIN_BASE,
  ACCIO_CHAT_PATH,
  ACCIO_MODEL_CONFIG_PATH,
  ACCIO_USERINFO_PATH,
  ACCIO_REFRESH_PATH,
  ACCIO_TOKEN_EXCHANGE_PATH,
  ACCIO_LOGIN_PATH,
  ACCIO_CLIENT_ID,
  ACCIO_SUBSCRIPTION_PATH,
  ACCIO_APP_VERSION,
  ACCIO_IAI_TAG,
  ACCIO_LANGUAGE,
  ACCIO_PACKAGE_REGION,
  ACCIO_USER_AGENT,
} from "./constants.js";

/**
 * @typedef {object} AccioProfile
 * @property {string} id
 * @property {string} gatewayBase
 * @property {string} loginBase
 * @property {string} chatUrl
 * @property {string} modelConfigUrl
 * @property {string} userInfoUrl
 * @property {string} refreshUrl
 * @property {string} tokenExchangeUrl
 * @property {string} loginUrl
 * @property {string} clientId
 * @property {string} subscriptionUrl
 * @property {string} appVersion
 * @property {string} packageRegion
 * @property {string} userAgent
 * @property {string} iaiTag
 * @property {string} language
 * @property {"INDIVIDUAL" | "TEAM"} subscripType
 */

/** @type {AccioProfile} */
export const PROD_PROFILE = {
  id: "prod",
  gatewayBase: ACCIO_GATEWAY_BASE,
  loginBase: ACCIO_LOGIN_BASE,
  chatUrl: `${ACCIO_GATEWAY_BASE}${ACCIO_CHAT_PATH}`,
  modelConfigUrl: `${ACCIO_GATEWAY_BASE}${ACCIO_MODEL_CONFIG_PATH}`,
  userInfoUrl: `${ACCIO_GATEWAY_BASE}${ACCIO_USERINFO_PATH}`,
  refreshUrl: `${ACCIO_GATEWAY_BASE}${ACCIO_REFRESH_PATH}`,
  tokenExchangeUrl: `${ACCIO_GATEWAY_BASE}${ACCIO_TOKEN_EXCHANGE_PATH}`,
  loginUrl: `${ACCIO_LOGIN_BASE}${ACCIO_LOGIN_PATH}`,
  clientId: ACCIO_CLIENT_ID,
  subscriptionUrl: `${ACCIO_GATEWAY_BASE}${ACCIO_SUBSCRIPTION_PATH}`,
  appVersion: ACCIO_APP_VERSION,
  packageRegion: ACCIO_PACKAGE_REGION,
  userAgent: ACCIO_USER_AGENT,
  iaiTag: ACCIO_IAI_TAG,
  language: ACCIO_LANGUAGE,
  subscripType: "INDIVIDUAL",
};

/** @type {AccioProfile} */
const DEFAULT_PROFILE = PROD_PROFILE;

/** @type {Record<string, AccioProfile>} */
const PROFILES = {
  prod: PROD_PROFILE,
};

/**
 * @param {string | AccioProfile | null | undefined} profileOrId
 * @returns {AccioProfile}
 */
export function resolveProfile(profileOrId) {
  if (profileOrId == null || profileOrId === "") return DEFAULT_PROFILE;
  if (typeof profileOrId === "object") {
    if (!profileOrId.chatUrl) {
      throw new Error("accio profile object requires chatUrl");
    }
    return profileOrId;
  }
  if (typeof profileOrId === "string") {
    const found = PROFILES[profileOrId];
    if (found) return found;
    throw new Error(`accio: unknown protocol profile "${profileOrId}"`);
  }
  throw new Error("accio: invalid protocol profile");
}
