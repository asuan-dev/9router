import { ACCIO_CONFIG } from "../constants/oauth.js";

/**
 * Accio Work — authorization code + PKCE against the Phoenix gateway.
 *
 * The desktop client drives the same flow with an `accio://` deeplink; the
 * login page equally accepts an http callback (its own "http_callback" mode),
 * so the framework's loopback redirect URI works unchanged.
 *
 * Region-specific wiring lives in the protocol Profile ("prod"); this file
 * only adapts the flow to the OAuth provider contract.
 */
const accio = {
  config: ACCIO_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    // Built here rather than in the service so the provider contract stays
    // synchronous; the service owns every call that touches the network.
    const params = new URLSearchParams({
      // Accio names this `return_url`; a `redirect_uri` param is ignored.
      return_url: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      client_id: config.clientId,
    });
    return `${config.loginUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const { AccioService } = await import("@/lib/oauth/services/accio");
    const svc = new AccioService({ profile: config.protocolProfile });
    const tokens = await svc.exchangeCode({ code, codeVerifier, redirectUri });
    const userInfo = await svc.fetchUserInfo(tokens.accessToken);
    return { ...tokens, _accioUser: userInfo };
  },
  mapTokens: (tokens) => {
    const user = tokens._accioUser || {};
    const userId = user.userId || "";
    // Dedup needs a non-empty email; Accio accounts can be phone-only, so
    // fall back to a stable synthetic id keyed on userId.
    const email = (user.email || "").trim() || (userId ? `accio-user-${userId}` : null);
    // expiresAt is Unix ms from AccioService.parseExpiry (already defaults to
    // +24h when the gateway omits it). Floor at 1h so a skewed clock cannot
    // truncate the stored token into uselessness.
    const minSeconds = 60 * 60;
    const remainingSeconds = Math.floor((tokens.expiresAt - Date.now()) / 1000);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: Math.max(minSeconds, remainingSeconds),
      email,
      displayName: (user.name || "").trim() || null,
      providerSpecificData: {
        userId,
        ...(user.userLevel ? { userLevel: user.userLevel } : {}),
      },
    };
  },
};

export default accio;
