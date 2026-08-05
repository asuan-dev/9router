/**
 * Accio chat: build → POST → unwrap SSE.
 *
 * Wire: `POST {gateway}/api/rlab/call`
 *       body `{ accessToken, request: { contents, systemInstruction, ... } }`
 *
 * No per-request signing. The desktop client gates SecurityGuard signing of
 * LLM calls behind the `sg_sign_llm` feature flag, which ships disabled
 * ("security-guard UMID init skipped (gray sg_sign_llm off)"), so a valid
 * accessToken is the whole auth story here.
 *
 * Failures return a constructed Response rather than throwing, matching the
 * qoder protocol so the executor has one code path.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAccioRequest } from "./body.js";
import { wrapAccioSSE } from "./sse.js";
import { resolveProfile } from "./profile.js";

/** Build an OpenAI-shaped error Response without touching the network. */
function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Execute one Accio chat request.
 *
 * @param {object} opts
 * @param {string} opts.model - Accio modelCode
 * @param {object} opts.body - OpenAI chat body
 * @param {object} opts.credentials
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.log]
 * @param {any} [opts.proxyOptions]
 * @param {any} [opts.profile]
 * @param {number|null} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl] - inject upstream for tests
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
  fetchImpl = null,
}) {
  const p = resolveProfile(profile);
  const url = p.chatUrl;

  const accessToken = credentials?.accessToken;
  if (!accessToken) {
    return {
      response: errorResponse(
        "accio credential is missing accessToken; reconnect the account",
        401,
      ),
      url,
      headers: {},
      transformedBody: body,
    };
  }

  let request;
  try {
    request = buildAccioRequest({ model, body, credentials, profile: p });
  } catch (err) {
    return {
      response: errorResponse(err.message, 400),
      url,
      headers: {},
      transformedBody: body,
    };
  }

  const payload = { accessToken, request };

  const headers = {
    "Content-Type": "application/json",
    // The gateway picks SSE or JSON from this header; both are accepted and
    // wrapAccioSSE passes non-stream responses through untouched.
    Accept: "application/json, text/event-stream",
    "Cache-Control": "no-cache",
    "x-app-version": p.appVersion,
    "x-package-region": p.packageRegion,
  };

  const connectTimeout = timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(
    () => connectCtrl.abort(new Error("fetch connect timeout")),
    connectTimeout,
  );
  const mergedSignal = signal
    ? AbortSignal.any([signal, connectCtrl.signal])
    : connectCtrl.signal;

  let response;
  try {
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: mergedSignal,
    };
    response =
      typeof fetchImpl === "function"
        ? await fetchImpl(url, init)
        : await proxyAwareFetch(url, init, proxyOptions);
  } catch (err) {
    log?.error?.("ACCIO", `chat request failed: ${err.message}`);
    return {
      response: errorResponse(`accio upstream request failed: ${err.message}`, 502),
      url,
      headers,
      transformedBody: payload,
    };
  } finally {
    clearTimeout(connectTimer);
  }

  if (!response.ok) {
    return { response, url, headers, transformedBody: payload };
  }

  return {
    response: wrapAccioSSE(response, model),
    url,
    headers,
    transformedBody: payload,
  };
}
