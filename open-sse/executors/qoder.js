/**
 * QoderExecutor — thin adapter over open-sse/protocol/qoder.
 *
 * Protocol owns Cosy sign, encode, body shape, SSE unwrap, catalog, quota.
 * Token refresh: not supported for device tokens (upstream 403); re-login required.
 * Profile: from provider config protocolProfile (default intl).
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { chat as qoderChat } from "../protocol/qoder/index.js";

export class QoderExecutor extends BaseExecutor {
  constructor(providerId = "qoder", config = null) {
    super(providerId, config || PROVIDERS.qoder || PROVIDERS[providerId]);
  }

  /** @returns {string} */
  getProtocolProfile() {
    return (
      this.config?.protocolProfile ||
      this.config?.protocol?.profile ||
      "intl"
    );
  }

  buildUrl() {
    // Real URL comes from profile inside protocol.chat; keep registry base for BaseExecutor fallbacks.
    return this.config?.baseUrl || "";
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const timeoutMs = this.config?.timeoutMs || null;
    return qoderChat({
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

  /** Device tokens do not refresh; callers must re-auth on 401. */
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderExecutor;
