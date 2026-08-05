/**
 * Accio model catalog fetcher.
 *
 * Wire: `POST {gateway}/api/llm/config/v2` with body `{ token }` — note the
 * field is `token`, not the `accessToken` the chat envelope uses.
 *
 * The gateway serves the catalog with an ETag and its own freshness hints
 * (`ttlSeconds`, `nextChangeAt`), so the cache honours those instead of a
 * fixed local TTL, and revalidates with `If-None-Match`. A 304 refreshes the
 * existing entry's expiry without re-parsing the payload.
 *
 * `visible: false` models are dropped from the surfaced list but kept in
 * rawConfigs: chat still accepts those model codes.
 */

import { createHash } from "crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { resolveProfile } from "./profile.js";

const FETCH_TIMEOUT_MS = 10_000;

/** Used when the gateway sends neither ttlSeconds nor nextChangeAt. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Guards against a gateway ttl so short it turns into a fetch per request. */
const MIN_TTL_MS = 60 * 1000;

/**
 * @typedef {object} CatalogEntry
 * @property {number} expiresAt
 * @property {any[]} models
 * @property {Map<string, object>} rawConfigs
 * @property {string} etag
 */

/** @type {Map<string, CatalogEntry>} */
const catalogCache = new Map();

/**
 * In-flight fetches keyed by cacheKey, so concurrent first-time requests
 * share one upstream call instead of stampeding the gateway.
 * @type {Map<string, Promise<object>>}
 */
const inflight = new Map();

/** Stable per-credential key so parallel sessions for one account share state. */
function cacheKey(credentials) {
  const token = credentials?.accessToken || "";
  const userId = credentials?.providerSpecificData?.userId || "";
  return createHash("sha256").update(`${userId}:${token}`).digest("hex").slice(0, 32);
}

/** Resolve the expiry the gateway asked for. */
function resolveExpiry(body) {
  const ttlSeconds = Number(body?.ttlSeconds);
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    return Date.now() + Math.max(MIN_TTL_MS, ttlSeconds * 1000);
  }
  const nextChangeAt = Number(body?.nextChangeAt);
  if (Number.isFinite(nextChangeAt) && nextChangeAt > Date.now()) {
    return Math.max(Date.now() + MIN_TTL_MS, nextChangeAt);
  }
  return Date.now() + DEFAULT_TTL_MS;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * One gateway model entry → 9router model shape.
 * @param {object} entry
 * @param {string} providerName
 * @returns {object|null}
 */
function mapModel(entry, providerName) {
  const id = (entry.modelCode || entry.modelName || "").trim();
  if (!id) return null;

  const display = (entry.modelDisplayName || entry.modelName || id).trim();
  const reasoningEfforts = Array.isArray(entry.reasoningEfforts)
    ? entry.reasoningEfforts.filter((e) => typeof e === "string" && e)
    : [];

  // thinkLevel is number|string upstream; any set value means the model thinks.
  const isReasoning =
    reasoningEfforts.length > 0 ||
    (entry.thinkLevel != null && entry.thinkLevel !== "" && entry.thinkLevel !== 0);

  return {
    id,
    name: display,
    contextLength: firstNumber(entry.contextWindow) || 131_072,
    isVL: entry.multimodal === true,
    isReasoning,
    maxOutputTokens: 0,
    description: (entry.modelDesc || entry.hoverDesc || "").trim(),
    enabled: true,
    provider: providerName,
    isDefault: entry.isDefault === true,
    ...(reasoningEfforts.length > 0
      ? {
          reasoningEfforts,
          defaultReasoningEffort: entry.defaultReasoningEffort || reasoningEfforts[0],
        }
      : {}),
  };
}

/**
 * Parse the catalog payload into cacheable pieces.
 *
 * @param {object} body
 * @param {string} etag
 * @returns {{ models: any[], rawConfigs: Map<string, object>, etag: string, expiresAt: number } | null}
 */
function parseCatalog(body, etag) {
  const providers = Array.isArray(body?.providers) ? body.providers : null;
  if (!providers) return null;

  const models = [];
  const rawConfigs = new Map();

  for (const group of providers) {
    if (!group || typeof group !== "object") continue;
    const providerName = (group.providerDisplayName || group.provider || "").trim();
    const modelList = Array.isArray(group.modelList) ? group.modelList : [];

    for (const entry of modelList) {
      if (!entry || typeof entry !== "object") continue;
      const mapped = mapModel(entry, providerName);
      if (!mapped) continue;

      // Chat needs the raw block for every code, including hidden ones.
      rawConfigs.set(mapped.id, entry);
      if (entry.visible === false) continue;
      models.push(mapped);
    }
  }

  // Prefer the response ETag; the payload's own version is the fallback the
  // desktop client uses when the header is absent.
  const resolvedEtag = etag || (typeof body?.ext?.version === "string" ? body.ext.version : "");

  return { models, rawConfigs, etag: resolvedEtag, expiresAt: resolveExpiry(body) };
}

/**
 * Fetch the catalog for one credential.
 *
 * Returns null on any failure so callers fall back to the static registry,
 * or `{ notModified: true }` when the stored ETag still matches.
 *
 * @param {object} credentials
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - inject upstream for tests
 * @returns {Promise<object|null>}
 */
async function fetchCatalogRaw(credentials, options = {}) {
  const { signal, proxyOptions = null, profile = null, etag = "", fetchImpl = null } = options;
  const token = credentials?.accessToken;
  if (!token) return null;

  const p = resolveProfile(profile);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": p.language,
    "x-language": p.language,
    "x-app-version": p.appVersion,
    "x-package-region": p.packageRegion,
  };
  if (etag) headers["If-None-Match"] = etag;

  const controller = new AbortController();
  let timer = null;
  let abortListener = null;
  let response;
  try {
    timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
    if (signal && typeof signal.addEventListener === "function") {
      // A signal that aborted before we got here never fires again.
      if (signal.aborted) controller.abort(signal.reason);
      else {
        abortListener = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abortListener);
      }
    }
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
      signal: controller.signal,
    };
    response =
      typeof fetchImpl === "function"
        ? await fetchImpl(p.modelConfigUrl, init)
        : await proxyAwareFetch(p.modelConfigUrl, init, proxyOptions);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }

  if (response.status === 304) return { notModified: true };
  if (!response.ok) return null;

  const body = await response.json().catch(() => null);
  if (!body) return null;

  return parseCatalog(body, response.headers.get("etag") || "");
}

/** Shape returned to callers when no catalog is available. */
function emptyResult() {
  return { models: [], rawConfigs: new Map(), fetched: false };
}

/** Shape returned to callers from a cache entry. */
function entryResult(entry) {
  return { models: entry.models, rawConfigs: entry.rawConfigs, fetched: true };
}

/**
 * Resolve the live catalog for a credential, caching per the gateway's own
 * freshness hints.
 *
 * `fetched` is false only when no catalog could be obtained at all, letting
 * callers distinguish an empty catalog from a failed fetch.
 *
 * @param {object} credentials
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh]
 * @returns {Promise<{ models: any[], rawConfigs: Map<string, object>, fetched: boolean }>}
 */
export async function resolveAccioModels(credentials, options = {}) {
  if (!credentials?.accessToken) return emptyResult();

  const key = cacheKey(credentials);
  const cached = catalogCache.get(key);

  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) {
    return entryResult(cached);
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const fetchPromise = (async () => {
    const result = await fetchCatalogRaw(credentials, {
      signal: options.signal,
      proxyOptions: options.proxyOptions ?? null,
      profile: options.profile ?? null,
      // A forced refresh must not send the ETag, or the gateway replies 304.
      etag: options.forceRefresh ? "" : cached?.etag || "",
      fetchImpl: options.fetchImpl ?? null,
    });

    if (result?.notModified && cached) {
      cached.expiresAt = Date.now() + DEFAULT_TTL_MS;
      return entryResult(cached);
    }

    if (!result || result.notModified) {
      // Serve a stale entry rather than dropping every model over one blip.
      return cached ? entryResult(cached) : emptyResult();
    }

    const entry = {
      expiresAt: result.expiresAt,
      models: result.models,
      rawConfigs: result.rawConfigs,
      etag: result.etag,
    };
    catalogCache.set(key, entry);
    return entryResult(entry);
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, fetchPromise);
  return fetchPromise;
}

/**
 * Raw gateway block for one model code, or null when the catalog is
 * unavailable (callers fall back to the static registry entry).
 *
 * @param {object} credentials
 * @param {string} modelCode
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function getAccioModelConfig(credentials, modelCode, options = {}) {
  if (!modelCode) return null;
  const { rawConfigs } = await resolveAccioModels(credentials, options);
  return rawConfigs.get(modelCode) || null;
}

/**
 * Mark one credential's catalog stale (used after a token refresh).
 *
 * The entry is expired rather than dropped so the next resolve revalidates
 * with `If-None-Match`: a 304 then restores the same models for free. Dropping
 * it would discard the ETag and force a full re-download every time.
 */
export function invalidateAccioCatalog(credentials) {
  const entry = catalogCache.get(cacheKey(credentials));
  if (entry) entry.expiresAt = 0;
}

export function clearAccioCatalog() {
  catalogCache.clear();
  inflight.clear();
}

export { parseCatalog, mapModel, resolveExpiry };
