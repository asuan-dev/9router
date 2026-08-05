import { resolveProfile } from "../../../../open-sse/protocol/accio/index.js";
import { proxyAwareFetch } from "../../../../open-sse/utils/proxyFetch.js";

/**
 * Accio OAuth Service — authorization-code + PKCE against the Phoenix gateway.
 *
 * Two quirks versus a textbook code flow, both taken from the desktop client:
 *   1. The login page takes `return_url`, not `redirect_uri`.
 *   2. Every gateway call is a POST whose JSON body carries the credential
 *      (`accessToken` / `refreshToken`); there are no bearer headers.
 *
 * Token payloads are camelCase (`{ accessToken, refreshToken, expiresAt }`)
 * with `expiresAt` as Unix ms.
 */

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal }, null);
  } finally {
    clearTimeout(timer);
  }
}

/** Gateway POST with a JSON body; returns parsed body or throws. */
async function postJson(fetchImpl, url, body, label) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message =
      (parsed && (parsed.errorMessage || parsed.message || parsed.error)) ||
      `HTTP ${response.status}`;
    const err = new Error(`Accio ${label} failed: ${message}`);
    err.status = response.status;
    err.body = parsed;
    throw err;
  }

  // The gateway wraps some routes as { success, data } and returns others bare.
  if (parsed && typeof parsed === "object" && parsed.success === false) {
    const err = new Error(`Accio ${label} failed: ${parsed.error || "unknown error"}`);
    err.body = parsed;
    throw err;
  }
  return parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
}

export class AccioService {
  /**
   * @param {{ profile?: string | object | null, fetchImpl?: typeof proxyAwareFetch }} [options]
   */
  constructor(options = {}) {
    this.profile = resolveProfile(options.profile ?? null);
    this.fetchImpl = options.fetchImpl || proxyAwareFetch;
  }

  /**
   * Build the browser login URL.
   *
   * @param {{ redirectUri: string, state: string, codeChallenge: string }} params
   * @returns {string}
   */
  buildAuthUrl({ redirectUri, state, codeChallenge }) {
    const query = new URLSearchParams({
      // Accio names this `return_url`; a `redirect_uri` param is ignored.
      return_url: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      client_id: this.profile.clientId,
    });
    return `${this.profile.loginUrl}?${query.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens.
   *
   * @param {{ code: string, codeVerifier: string, redirectUri: string }} params
   * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
   */
  async exchangeCode({ code, codeVerifier, redirectUri }) {
    if (!code) throw new Error("Accio token exchange: missing authorization code");
    if (!codeVerifier) throw new Error("Accio token exchange: missing PKCE verifier");

    const data = await postJson(
      this.fetchImpl,
      this.profile.tokenExchangeUrl,
      {
        code,
        codeVerifier,
        clientId: this.profile.clientId,
        redirectUri,
      },
      "token exchange",
    );

    const accessToken = data?.accessToken;
    const refreshToken = data?.refreshToken;
    if (!accessToken || !refreshToken) {
      throw new Error("Accio token exchange returned no accessToken/refreshToken");
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: AccioService.parseExpiry(data?.expiresAt),
    };
  }

  /**
   * Refresh an access token. The gateway wants both tokens in the body.
   *
   * @param {string} refreshToken
   * @param {string} [accessToken] - current (possibly expired) token
   * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number, expiresAt: number }>}
   */
  async refreshAccessToken(refreshToken, accessToken = "") {
    if (!refreshToken) throw new Error("Accio refresh: missing refresh token");

    const data = await postJson(
      this.fetchImpl,
      this.profile.refreshUrl,
      { accessToken, refreshToken },
      "token refresh",
    );

    const nextAccess = data?.accessToken;
    if (!nextAccess) {
      throw new Error("Accio refresh returned no accessToken");
    }

    const expiresAt = AccioService.parseExpiry(data?.expiresAt);
    return {
      accessToken: nextAccess,
      refreshToken: data?.refreshToken || refreshToken,
      expiresIn: Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)),
      expiresAt,
    };
  }

  /**
   * Look up the signed-in account. Best-effort: a failure here should not
   * block a connection that already has valid tokens.
   *
   * @param {string} accessToken
   * @returns {Promise<{ userId: string, name: string, email: string, userLevel: string }>}
   */
  async fetchUserInfo(accessToken) {
    const empty = { userId: "", name: "", email: "", userLevel: "" };
    if (!accessToken) return empty;
    try {
      const data = await postJson(
        this.fetchImpl,
        this.profile.userInfoUrl,
        { accessToken },
        "userinfo",
      );
      const userId = typeof data?.userId === "string" ? data.userId.trim() : "";
      if (!userId) return empty;
      return {
        userId,
        name: (data.userName || data.accioId || "").trim(),
        email: (data.email || data.desensitizedEmail || "").trim(),
        userLevel: data.userLevel == null ? "" : String(data.userLevel),
      };
    } catch {
      return empty;
    }
  }

  /**
   * Normalise `expiresAt`. Unix ms and ISO strings both appear upstream;
   * a missing value falls back to 24h, the shortest lifetime observed.
   *
   * @param {number|string|null|undefined} expiresAt
   * @returns {number} Unix ms
   */
  static parseExpiry(expiresAt) {
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
      return expiresAt;
    }
    const trimmed = typeof expiresAt === "string" ? expiresAt.trim() : "";
    if (trimmed) {
      if (/^\d+$/.test(trimmed)) {
        const ms = Number.parseInt(trimmed, 10);
        if (Number.isFinite(ms) && ms > 0) return ms;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return Date.now() + 24 * 60 * 60 * 1000;
  }
}

export { resolveProfile };
