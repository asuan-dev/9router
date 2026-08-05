/**
 * AccioExecutor — thin adapter over open-sse/protocol/accio.
 *
 * Identity refresh: gateway /api/auth/refresh_token via tokenRefresh handlers.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { chat as accioChat } from "../protocol/accio/index.js";
import { refreshAccioToken } from "../services/tokenRefresh/providers.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";

export class AccioExecutor extends BaseExecutor {
  constructor(providerId = "accio", config = null) {
    super(providerId, config || PROVIDERS[providerId] || PROVIDERS.accio);
  }

  /** @returns {string} profile id for protocol.resolveProfile */
  getProtocolProfile() {
    return this.config.protocolProfile;
  }

  buildUrl() {
    return this.config?.baseUrl || "";
  }

  async execute({ model, body, credentials, signal, log, proxyOptions = null }) {
    const timeoutMs = this.config?.timeoutMs || null;
    return accioChat({
      model,
      body,
      credentials,
      signal,
      log,
      proxyOptions,
      timeoutMs,
      profile: this.getProtocolProfile(),
    });
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshAccioToken(
      credentials.refreshToken,
      this.getProtocolProfile(),
      log,
      credentials.accessToken || "",
    );
  }
}
