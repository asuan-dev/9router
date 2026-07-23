/**
 * OpenAI Chat Completions → Qoder private request payload.
 *
 * Contract (authoritative, not legacy 9r guesses):
 *   lab/qodercli/PROTOCOL-SCHEMA.md
 *   lab/qodercli/1.1.3/awA-return-object.js.txt
 *   lab/qodercli/docs/field-matrix-core.md
 *
 * Classification:
 *   DIRECT  — messages (non-system), tools, stream
 *   RENAME  — model→model_config; system msgs→system; max_tokens→parameters.max_tokens
 *   ADD     — FREE_INPUT shell, ids, chat_context, session_type, optional business
 *   DROP    — temperature/top_p/seed/… (minimal path)
 */

import { createHash, randomUUID } from "crypto";
import { getQoderModelConfig, resolveQoderModels } from "./catalog.js";
import { resolveProfile } from "./profile.js";

/** Official free-chat shell (awA). */
const SHELL = {
  chat_task: "FREE_INPUT",
  stream: true,
  is_reply: true,
  is_retry: false,
  source: 1,
  version: "3",
  agent_id: "agent_common",
  task_id: "common",
  code_language: "",
  chat_prompt: "",
  image_urls: null,
  aliyun_user_type: "",
};

const EFFORT_SET = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const text = extractText(msg.content);
    // Chat: system + developer both become Qoder top-level system (RENAME).
    if (msg.role === "system" || msg.role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = text;
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Resolve Chat reasoning_effort → Qoder parameters.reasoning_effort.
 * @returns {string|undefined}
 */
function resolveReasoningEffort(body) {
  if (!body || typeof body !== "object") return undefined;
  let raw = body.reasoning_effort;
  if (raw == null && body.reasoning && typeof body.reasoning === "object") {
    raw = body.reasoning.effort;
  }
  if (raw == null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (!v) return undefined;
  if (EFFORT_SET.has(v)) return v;
  // Common aliases
  if (v === "x-high") return "xhigh";
  if (v === "auto") return undefined;
  return undefined;
}

/**
 * Build chat_context (official GhI shape).
 */
function buildChatContext(lastUser, qoderKey, isReasoning) {
  return {
    text: lastUser,
    features: [],
    extra: {
      context: [],
      modelConfig: { key: qoderKey, is_reasoning: !!isReasoning },
      originalContent: lastUser,
    },
    chatPrompt: "",
    imageUrls: null,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.model
 * @param {object} opts.body - OpenAI chat body
 * @param {object} opts.credentials
 * @param {object|null} [opts.modelConfig] - inject: skip catalog when set
 * @param {boolean} [opts.includeBusiness=false] - awA treats business as optional
 * @param {any} [opts.profile]
 */
async function buildQoderRequestBody({
  model,
  body,
  credentials,
  log,
  proxyOptions,
  signal,
  profile = null,
  modelConfig: modelConfigInject = null,
  includeBusiness = false,
}) {
  const p = resolveProfile(profile);
  const qoderKey = String(model || "").replace(/^qoder\//, "");

  let modelConfig = modelConfigInject;
  if (!modelConfig) {
    modelConfig = await getQoderModelConfig(credentials, qoderKey, {
      log,
      proxyOptions,
      signal,
      profile: p,
    });
    if (!modelConfig) {
      const refreshed = await resolveQoderModels(credentials, {
        forceRefresh: true,
        log,
        proxyOptions,
        signal,
        profile: p,
      });
      const retried = refreshed?.rawConfigs.get(qoderKey);
      if (!retried) {
        throw new Error(
          `qoder: model_config for "${qoderKey}" not yet known (inject modelConfig or fetch model list)`,
        );
      }
      modelConfig = { ...retried, key: qoderKey };
    }
  } else if (!modelConfig.key) {
    modelConfig = { ...modelConfig, key: qoderKey };
  }

  const { messages, systemText } = normalizeMessages(body?.messages || []);
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body?.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (
    typeof body?.max_completion_tokens === "number" &&
    body.max_completion_tokens > 0 &&
    body.max_completion_tokens < maxTokens
  ) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials?.providerSpecificData || {};
  // awA: request_id / request_set_id / chat_record_id share one id by default.
  const requestId = randomUUID();
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);

  const parameters = { max_tokens: maxTokens };
  const effort = resolveReasoningEffort(body);
  if (effort !== undefined) parameters.reasoning_effort = effort;
  if (typeof body?.tool_choice !== "undefined") parameters.tool_choice = body.tool_choice;
  // Optional context window (official: parameters.context_length from contextWindow).
  if (typeof body?.context_length === "number" && body.context_length > 0) {
    parameters.context_length = body.context_length;
  } else if (typeof body?.contextWindow === "number" && body.contextWindow > 0) {
    parameters.context_length = body.contextWindow;
  }

  const payload = {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: sessionId,
    ...SHELL,
    session_type: p.sessionType,
    model_config: modelConfig,
    system: systemText,
    messages,
    tools,
    parameters,
    chat_context: buildChatContext(lastUser, qoderKey, isReasoning),
  };

  // awA spreads business only when present — default omit (ADD optional).
  if (includeBusiness || p.includeBusiness) {
    payload.business = {
      product: p.businessProduct,
      version: p.businessVersion,
      type: "agent",
      stage: "start",
      id: randomUUID(),
      name: truncate(lastUser, 30),
      begin_at: Date.now(),
    };
  }

  return { qoderKey, payload, modelConfig };
}

/**
 * @param {object} opts
 */
export async function buildChatPayload(opts) {
  return buildQoderRequestBody(opts);
}

export { normalizeMessages, buildQoderRequestBody, resolveReasoningEffort, buildChatContext, SHELL };
