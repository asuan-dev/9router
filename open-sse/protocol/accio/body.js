/**
 * OpenAI Chat Completions → Accio (Gemini-shaped) request payload.
 *
 * Accio's gateway speaks Gemini natively: `contents` + `parts`, a hoisted
 * `systemInstruction`, `functionDeclarations` for tools, and camelCase
 * generation knobs. Format translation happens here; the client sends the
 * same shape for every upstream model (GPT / Claude / Qwen / Gemini) and the
 * gateway fans out to the real provider.
 *
 * Evidence: out/main/index.js — messagesToAccioRequest / buildGeminiContents.
 */

import { randomUUID } from "crypto";
import { resolveProfile } from "./profile.js";
import { decodeToolCallId } from "./toolSignature.js";

/** Roles Gemini accepts on a content entry. */
const ROLE_USER = "user";
const ROLE_MODEL = "model";

/**
 * OpenAI content → Gemini parts.
 *
 * String content becomes one text part. Array content maps per item:
 * `text` → `{text}`, `image_url` → `{inlineData}` for data URLs or
 * `{fileData}` for remote URLs (the gateway resolves both).
 *
 * @param {string|object[]|null|undefined} content
 * @returns {object[]}
 */
function contentToParts(content) {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "text" && typeof item.text === "string") {
      if (item.text) parts.push({ text: item.text });
      continue;
    }

    if (item.type === "image_url") {
      const url = item.image_url?.url;
      if (typeof url !== "string" || !url) continue;
      const inline = parseDataUrl(url);
      parts.push(inline ? { inlineData: inline } : { fileData: { fileUri: url, mimeType: guessMime(url) } });
    }
  }
  return parts;
}

/**
 * Split a `data:` URL into Gemini `inlineData`.
 * @param {string} url
 * @returns {{ mimeType: string, data: string } | null}
 */
function parseDataUrl(url) {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const data = url.slice(comma + 1);
  if (!header.endsWith(";base64")) return null;
  const mimeType = header.slice(0, -";base64".length) || "image/png";
  return { mimeType, data };
}

/**
 * @param {string} url
 * @returns {string}
 */
function guessMime(url) {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

/** Plain text out of any content shape (used for the system hoist). */
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Parse an OpenAI tool-call argument string. Malformed JSON degrades to an
 * empty object rather than failing the whole turn.
 * @param {string|object|undefined} args
 * @returns {object}
 */
function parseArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string" || !args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Assistant message → Gemini model content.
 *
 * `thoughtSignature` round-trips verbatim: the gateway rejects a follow-up
 * turn whose functionCall dropped the signature it issued.
 *
 * @param {object} msg
 * @returns {object}
 */
function assistantContent(msg) {
  const parts = [];
  const text = extractText(msg.content);
  if (text) parts.push({ text });

  for (const call of msg.tool_calls || []) {
    if (!call || call.type !== "function" || !call.function?.name) continue;
    // The id we handed the client packs the gateway's thoughtSignature; split
    // it back so the upstream call keeps its original id and signature.
    const { callId, signature } = decodeToolCallId(call.id);
    const functionCall = {
      id: callId || undefined,
      name: call.function.name,
      args: parseArgs(call.function.arguments),
    };
    const part = { functionCall };
    const resolved = signature || call.thoughtSignature || "";
    if (resolved) part.thoughtSignature = resolved;
    parts.push(part);
  }

  // Gemini rejects an empty parts array; a placeholder keeps history valid.
  if (parts.length === 0) parts.push({ text: "" });
  return { role: ROLE_MODEL, parts };
}

/**
 * Tool result message → Gemini functionResponse content.
 * @param {object} msg
 * @param {Map<string, string>} callNames - tool_call_id → function name
 * @returns {object}
 */
function toolContent(msg, callNames) {
  const { callId } = decodeToolCallId(msg.tool_call_id);
  const name = callNames.get(msg.tool_call_id) || msg.name || "tool";
  const text = extractText(msg.content);
  let response;
  try {
    const parsed = JSON.parse(text);
    response = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { result: parsed };
  } catch {
    response = { result: text };
  }
  return {
    role: ROLE_USER,
    parts: [{ functionResponse: { id: callId || undefined, name, response } }],
  };
}

/**
 * OpenAI messages → { contents, systemInstruction }.
 *
 * System messages are hoisted out of the turn list and joined with blank
 * lines, matching the desktop client. Consecutive same-role contents are
 * left as-is: the gateway tolerates them and merging would lose part
 * boundaries that matter for tool calls.
 *
 * @param {object[]} messages
 * @returns {{ contents: object[], systemInstruction: string }}
 */
export function buildContents(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemChunks = [];
  const contents = [];

  // Tool results reference calls by id; Gemini needs the function name.
  const callNames = new Map();
  for (const msg of list) {
    for (const call of msg?.tool_calls || []) {
      if (call?.id && call.function?.name) callNames.set(call.id, call.function.name);
    }
  }

  for (const msg of list) {
    if (!msg || typeof msg !== "object") continue;

    switch (msg.role) {
      case "system":
      case "developer": {
        const text = extractText(msg.content);
        if (text) systemChunks.push(text);
        break;
      }
      case "assistant":
        contents.push(assistantContent(msg));
        break;
      case "tool":
      case "function":
        contents.push(toolContent(msg, callNames));
        break;
      default: {
        const parts = contentToParts(msg.content);
        if (parts.length > 0) contents.push({ role: ROLE_USER, parts });
        break;
      }
    }
  }

  return { contents, systemInstruction: systemChunks.join("\n\n") };
}

/**
 * OpenAI tools → Gemini functionDeclarations.
 *
 * Returns null when there is nothing to declare so the caller can omit the
 * field entirely (an empty `tools` array makes the gateway reject the call).
 *
 * @param {object[]|undefined} tools
 * @returns {object[]|null}
 */
export function buildTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const declarations = [];
  for (const tool of tools) {
    const fn = tool?.function;
    if (!fn?.name) continue;
    const declaration = { name: fn.name };
    if (fn.description) declaration.description = fn.description;
    if (fn.parameters && typeof fn.parameters === "object") {
      declaration.parameters = fn.parameters;
    }
    declarations.push(declaration);
  }

  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : null;
}

/**
 * OpenAI tool_choice → Gemini toolConfig.
 * @param {string|object|undefined} toolChoice
 * @returns {object|null}
 */
export function buildToolConfig(toolChoice) {
  if (!toolChoice) return null;
  if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
  const name = toolChoice?.function?.name;
  if (name) {
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
  }
  return null;
}

/**
 * Build the full Accio `request` envelope for one chat call.
 *
 * The gateway wraps this as `{ accessToken, request }`; chat.js adds the
 * token so this stays credential-free and unit-testable.
 *
 * @param {object} opts
 * @param {string} opts.model - Accio modelCode
 * @param {object} opts.body - OpenAI chat body
 * @param {object} [opts.credentials]
 * @param {any} [opts.profile]
 * @returns {object}
 */
export function buildAccioRequest({ model, body, credentials = null, profile = null }) {
  const p = resolveProfile(profile);
  const src = body && typeof body === "object" ? body : {};
  const { contents, systemInstruction } = buildContents(src.messages);

  if (contents.length === 0) {
    throw new Error("accio: request has no usable messages");
  }

  const request = {
    model,
    contents,
    systemInstruction,
    iaiTag: p.iaiTag,
    requestId: randomUUID(),
    messageId: randomUUID(),
    // Gateway normalises provider-specific error/usage frames when asked.
    properties: { normalized_response: "true" },
  };

  const maxTokens = Number(src.max_completion_tokens ?? src.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) request.maxOutputTokens = maxTokens;

  const temperature = Number(src.temperature);
  if (Number.isFinite(temperature)) request.temperature = temperature;

  const tools = buildTools(src.tools);
  if (tools) request.tools = tools;

  const toolConfig = buildToolConfig(src.tool_choice);
  if (toolConfig) request.toolConfig = toolConfig;

  const userId = credentials?.providerSpecificData?.userId;
  if (userId) request.sessionKey = String(userId);

  return request;
}
