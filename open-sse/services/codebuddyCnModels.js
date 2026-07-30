// CodeBuddy CN (WorkBuddy) model discovery + capability extraction.
//
// WHY A SERVICE MODULE: the API route (models/route.js) used to inline the
// fetch, UA, CLI-agent filter, and caps mapping. That puts endpoint protocol
// in the Next route layer and forces every new provider to edit the route.
// This module owns the upstream contract; the route just calls it.
//
// Upstream shape (unpacked from WorkBuddy client 5.3.3 initialize.js getModels):
//   GET https://copilot.tencent.com/console/enterprises/{eid}/models
//   Bearer auth, UA "CodeBuddy/5.3.3" required (else code 12403).
//   data.data.models[] with supportsImages / supportsToolCall /
//   supportsReasoning / maxInputTokens / maxOutputTokens.
//
// `publishDiscoveredCaps` in the route publishes these to the live overlay +
// persists them for boot re-hydration.

const CODEBUDDY_MODELS_BASE = "https://copilot.tencent.com";
const CODEBUDDY_UA = "CodeBuddy/5.3.3";

/**
 * Map one raw CodeBuddy model into a capability patch.
 * Exported so the route can pass it straight to publishDiscoveredCaps without
 * duplicating field names across providers.
 */
export function mapCodebuddyCnCaps(m) {
  const caps = {};
  if (typeof m.supportsImages === "boolean") caps.vision = m.supportsImages;
  if (typeof m.supportsToolCall === "boolean") caps.tools = m.supportsToolCall;
  if (typeof m.supportsReasoning === "boolean") caps.reasoning = m.supportsReasoning;
  if (m.maxInputTokens) caps.contextWindow = m.maxInputTokens;
  if (m.maxOutputTokens) caps.maxOutput = m.maxOutputTokens;
  return caps;
}

/**
 * Fetch the live model list + raw models (for cap publishing).
 * @returns {Promise<{models?: Array<{id,name}>, rawModels?: object[], error?: string, status?: number}>}
 */
export async function resolveCodebuddyCnModels(connection) {
  const token = connection.accessToken;
  if (!token) return { error: "No access token", status: 401 };

  const eid = connection.providerSpecificData?.enterpriseId || "personal";
  const url = `${CODEBUDDY_MODELS_BASE}/console/enterprises/${eid}/models`;

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": CODEBUDDY_UA,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
  } catch (e) {
    return { error: `Fetch failed: ${e.message}`, status: 502 };
  }

  if (!response.ok) {
    return { error: `Upstream ${response.status}`, status: response.status };
  }

  const data = await response.json();
  const allModels = (data?.data?.models || []).filter(Boolean);

  // Client filters to models the "cli" agent is allowed to use; surface only
  // those — otherwise we'd show image-only models (hunyuan-image etc.).
  const cliAgent = (data?.data?.agents || []).find((a) => a.name === "cli");
  const cliIds = cliAgent?.models ?? [];
  const rawModels = cliIds.length ? allModels.filter((m) => cliIds.includes(m.id)) : allModels;

  const models = rawModels.filter((m) => m?.id).map((m) => ({ id: m.id, name: m.name || m.id }));
  return { models, rawModels };
}
