/**
 * Qoder chat: build → encode → Cosy sign → fetch → unwrap SSE.
 *
 * Contract: lab/qodercli/PROTOCOL-SCHEMA.md
 * Inject: modelConfig (skip list), fetchImpl (simulate upstream).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { qoderEncodeBody } from "./encoding.js";
import { buildCosyHeaders } from "./cosy.js";
import { buildChatPayload } from "./body.js";
import { wrapQoderSSE } from "./sse.js";
import { resolveProfile } from "./profile.js";

/**
 * Execute one Qoder chat request.
 * @param {object} opts
 * @param {object} [opts.modelConfig] - injected model_config (no catalog fetch)
 * @param {typeof fetch} [opts.fetchImpl] - inject fetch for tests
 * @param {boolean} [opts.includeBusiness]
 * @returns {Promise<{ response: Response, url: string, headers: object, transformedBody: object }>}
 */
export async function chat({
  model,
  body,
  credentials,
  signal,
  log,
  proxyOptions = null,
  profile = null,
  timeoutMs = null,
  modelConfig = null,
  fetchImpl = null,
  includeBusiness = false,
}) {
  const p = resolveProfile(profile);
  const url = p.chatUrl;
  const psd = credentials?.providerSpecificData || {};

  if (!psd.userId) {
    const fakeResp = new Response(
      JSON.stringify({ error: { message: "qoder credential is missing userId; reconnect the account" } }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    return { response: fakeResp, url, headers: {}, transformedBody: body };
  }
  if (!credentials?.accessToken) {
    const fakeResp = new Response(
      JSON.stringify({ error: { message: "qoder credential is missing accessToken; reconnect the account" } }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    return { response: fakeResp, url, headers: {}, transformedBody: body };
  }

  let qoderKey;
  let payload;
  try {
    ({ qoderKey, payload } = await buildChatPayload({
      model,
      body,
      credentials,
      log,
      proxyOptions,
      signal,
      profile: p,
      modelConfig,
      includeBusiness,
    }));
  } catch (err) {
    const fakeResp = new Response(
      JSON.stringify({ error: { message: err.message } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    return { response: fakeResp, url, headers: {}, transformedBody: body };
  }

  const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
  const encodedBodyStr = qoderEncodeBody(plainBody);
  const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

  let cosyHeaders;
  try {
    cosyHeaders = buildCosyHeaders(
      encodedBodyBuf,
      url,
      {
        userId: psd.userId,
        authToken: credentials.accessToken,
        name: credentials.displayName || "",
        email: credentials.email || "",
        machineId: psd.machineId || "",
      },
      p,
    );
  } catch (err) {
    const fakeResp = new Response(
      JSON.stringify({ error: { message: `qoder cosy signing failed: ${err.message}` } }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    return { response: fakeResp, url, headers: {}, transformedBody: body };
  }

  const modelSource = (payload.model_config && payload.model_config.source) || "system";
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Model-Key": qoderKey,
    "X-Model-Source": modelSource,
    "Accept-Encoding": "identity",
    ...cosyHeaders,
  };

  const connectTimeout = timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(
    () => connectCtrl.abort(new Error("fetch connect timeout")),
    connectTimeout,
  );
  const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

  let response;
  try {
    const init = { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal };
    if (typeof fetchImpl === "function") {
      response = await fetchImpl(url, init);
    } else {
      response = await proxyAwareFetch(url, init, proxyOptions);
    }
  } finally {
    clearTimeout(connectTimer);
  }

  if (!response.ok) {
    return { response, url, headers, transformedBody: payload };
  }

  const wrapped = wrapQoderSSE(response, `qoder/${qoderKey}`);
  return { response: wrapped, url, headers, transformedBody: payload };
}
