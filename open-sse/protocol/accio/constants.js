/**
 * Accio (Alibaba Phoenix) API constants — prod defaults.
 *
 * Hosts live on Profile for multi-environment; these feed PROD_PROFILE.
 * Model ids come from live /api/llm/config/v2, not a frozen map.
 *
 * Evidence: Accio desktop app.asar → out/main/index.js
 *   gatewayBaseUrl  https://phoenix-gw.alibaba.com
 *   loginBaseUrl    https://www.accio.com
 */

export const ACCIO_GATEWAY_BASE = "https://phoenix-gw.alibaba.com";
export const ACCIO_LOGIN_BASE = "https://www.accio.com";

// Inference. Gateway wraps the upstream model behind one RPC endpoint.
export const ACCIO_CHAT_PATH = "/api/rlab/call";

// Model catalog (POST, etag-aware).
export const ACCIO_MODEL_CONFIG_PATH = "/api/llm/config/v2";

// Identity.
export const ACCIO_USERINFO_PATH = "/api/auth/userinfo";
export const ACCIO_REFRESH_PATH = "/api/auth/refresh_token";
export const ACCIO_TOKEN_EXCHANGE_PATH = "/api/oauth/token";

/** Browser login page. Takes `return_url`, not `redirect_uri`. */
export const ACCIO_LOGIN_PATH = "/login";

/** OAuth client the desktop app registers as. */
export const ACCIO_CLIENT_ID = "accio-work";

// Quota. currentSubscription is the only endpoint we need: it carries the
// plan type plus the daily and overall credit layers. The billing/usage/grant
// history endpoints are deliberately not wired — 9router shows balances, not
// ledgers.
export const ACCIO_SUBSCRIPTION_PATH = "/api/entitlement/currentSubscription";

// Client identity headers the gateway expects.
export const ACCIO_APP_VERSION = "0.27.3";

/**
 * Trace tag the gateway stamps on every LLM call. Upstream default is
 * `phoenix-desktop` with an ADK_IAI_TAG override.
 */
export const ACCIO_IAI_TAG = "phoenix-desktop";
export const ACCIO_PACKAGE_REGION = "non_cn";

/** Catalog requests are language-scoped; display names come back localised. */
export const ACCIO_LANGUAGE = "en";

/** Gateway rejects catalog requests without an app version. */
export const ACCIO_USER_AGENT = `Accio/${ACCIO_APP_VERSION}`;
