// Live capability overlay — server-published model metadata, highest priority.
//
// WHY THIS EXISTS: `capabilities.js` is a hand-maintained table. It is always
// stale by construction: providers add models, drop models, and silently flip
// flags (a model gains vision, a context window doubles). Hardcoding those
// facts guarantees drift, and a wrong `vision:false` is not cosmetic — it makes
// `translator/concerns/modality.js` delete the user's image before translation.
//
// So whenever a provider can *tell* us what a model supports, that answer wins.
// `services/discovery/` fetches it and calls `setLiveCapabilities`; the hand
// table below it in the chain degrades to a cold-start / offline fallback.
//
// This module is deliberately dependency-free so `capabilities.js` can import
// it without a cycle (discovery → capabilities → liveCapabilities, never back).

/**
 * provider -> Map<modelId, capsPatch>
 * @type {Map<string, Map<string, object>>}
 */
const liveByProvider = new Map();

/** provider -> metadata about the last successful discovery. */
const metaByProvider = new Map();

/** Strip a vendor prefix: "anthropic/claude-opus" -> "claude-opus". */
function baseId(model) {
  return typeof model === "string" && model.includes("/") ? model.split("/").pop() : model;
}

/**
 * Publish discovered capabilities for a provider. Replaces any previous set
 * (a model that vanished upstream must stop overriding the static table).
 *
 * @param {string} provider
 * @param {Record<string, object>|Map<string, object>} capsByModel
 * @param {object} [meta] - { connectionId, fetchedAt, source }
 */
export function setLiveCapabilities(provider, capsByModel, meta = {}) {
  if (!provider || !capsByModel) return;
  const entries = capsByModel instanceof Map ? [...capsByModel.entries()] : Object.entries(capsByModel);
  const table = new Map();
  for (const [model, caps] of entries) {
    if (!model || !caps || typeof caps !== "object") continue;
    table.set(model, caps);
    // Index the bare id too so "vendor/model" lookups hit.
    const bare = baseId(model);
    if (bare && bare !== model && !table.has(bare)) table.set(bare, caps);
  }
  if (table.size === 0) {
    liveByProvider.delete(provider);
    return;
  }
  liveByProvider.set(provider, table);
  metaByProvider.set(provider, { ...meta, fetchedAt: meta.fetchedAt || Date.now(), count: table.size });
}

/**
 * Look up a discovered capability patch. Returns null when nothing was
 * discovered for this provider/model — callers then fall through to the
 * static chain in `capabilities.js`.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object|null}
 */
export function getLiveCapability(provider, model) {
  if (!provider || !model) return null;
  const table = liveByProvider.get(provider);
  if (!table) return null;
  return table.get(model) || table.get(baseId(model)) || null;
}

/** True when this provider has any live data (used for diagnostics / UI). */
export function hasLiveCapabilities(provider) {
  return liveByProvider.has(provider);
}

/** Metadata about the last publish for a provider, or null. */
export function getLiveCapabilitiesMeta(provider) {
  return metaByProvider.get(provider) || null;
}

/** Drop one provider's overlay (e.g. connection deleted). */
export function clearLiveCapabilities(provider) {
  if (provider) {
    liveByProvider.delete(provider);
    metaByProvider.delete(provider);
    return;
  }
  liveByProvider.clear();
  metaByProvider.clear();
}

/** Snapshot for debugging / the dashboard. */
export function dumpLiveCapabilities() {
  const out = {};
  for (const [provider, table] of liveByProvider) {
    out[provider] = { meta: metaByProvider.get(provider) || null, models: [...table.keys()] };
  }
  return out;
}
