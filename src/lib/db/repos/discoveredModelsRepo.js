import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Persisted output of `open-sse/services/discovery`.
//
// WHY PERSIST: discovery caches live in process memory, so every restart would
// drop back to the hand-written capability table until someone clicks refresh.
// That is exactly the window where a stale `vision:false` silently deletes a
// user's image. Storing the last good result lets boot re-publish real
// capabilities before the first request arrives.
//
// One row per provider (not per connection): capabilities describe the model as
// the gateway offers it, and the engine resolves caps by provider+model with no
// connection in scope.
const SCOPE = "discoveredModels";

/**
 * @typedef {object} DiscoveredCatalog
 * @property {Array<{id:string,name:string,caps:object}>} models
 * @property {Record<string,object>} caps    modelId -> capability patch
 * @property {string} fetchedAt              ISO timestamp of the upstream fetch
 * @property {string} [adapter]              adapter id that produced it
 */

/** Save one provider's discovered catalog, replacing any previous row. */
export async function saveDiscoveredCatalog(provider, catalog) {
  if (!provider || !catalog || typeof catalog !== "object") return;
  const db = await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, provider, stringifyJson({
      models: Array.isArray(catalog.models) ? catalog.models : [],
      caps: catalog.caps && typeof catalog.caps === "object" ? catalog.caps : {},
      fetchedAt: catalog.fetchedAt || new Date().toISOString(),
      adapter: catalog.adapter || provider,
    })]
  );
}

/** @returns {Promise<DiscoveredCatalog|null>} */
export async function getDiscoveredCatalog(provider) {
  if (!provider) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, provider]);
  return row ? parseJson(row.value, null) : null;
}

/** @returns {Promise<Record<string, DiscoveredCatalog>>} */
export async function getAllDiscoveredCatalogs() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) {
    const parsed = parseJson(r.value, null);
    if (parsed) out[r.key] = parsed;
  }
  return out;
}

/** Forget one provider's catalog (e.g. its last connection was removed). */
export async function clearDiscoveredCatalog(provider) {
  if (!provider) return;
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, provider]);
}
