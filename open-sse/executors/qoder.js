/**
 * QoderExecutor — thin adapter over open-sse/protocol/qoder.
 *
 * Protocol owns Cosy sign, encode, body shape, SSE unwrap, catalog, quota.
 * Token refresh: not supported for device tokens (upstream 403); re-login required.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  chat as qoderChat,
  wrapQoderSSE,
  normalizeMessages,
  buildQoderRequestBody,
  QODER_CHAT_URL_ENCODED,
} from "../protocol/qoder/index.js";

export class QoderExecutor extends BaseExecutor {
  constructor() {
    super("qoder", PROVIDERS.qoder);
  }

  buildUrl() {
    return QODER_CHAT_URL_ENCODED;
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

/** @deprecated Prefer protocol/qoder exports; kept for unit tests during transition. */
export const __test__ = {
  normalizeMessages,
  wrapQoderSSE,
  buildQoderRequestBody,
};
