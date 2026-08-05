/**
 * Unwrap Accio gateway SSE into plain OpenAI SSE.
 *
 * Upstream frame (normalized_response=true) is Gemini-shaped:
 *   { content: { parts: [...] }, turnComplete?, usageMetadata?, error_code? }
 *
 * A part is one of:
 *   { text, thought?, thoughtSignature? }        visible text or thinking
 *   { functionCall: { id, name, argsJson }, thoughtSignature? }
 *
 * `thought: true` parts are reasoning, surfaced as `delta.reasoning_content`.
 * Non-OK gateway frames become an OpenAI-shaped error event, never fake content.
 *
 * Evidence: out/main/index.js — yi() frame reader, ai() usage mapper.
 */

import { SSE_DONE } from "../../utils/sseConstants.js";
import { encodeToolCallId } from "./toolSignature.js";

const encoder = new TextEncoder();

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/** Gateway error codes that mean the credential needs refreshing. */
const AUTH_CODES = new Set(["401", "403", "AUTH_FAILED", "TOKEN_EXPIRED"]);
/** Gateway error codes worth retrying. */
const RETRY_CODES = new Set(["429", "500", "503", "505"]);

function emitDone(controller, state) {
  if (state.doneEmitted) return;
  controller.enqueue(encoder.encode(SSE_DONE));
  state.doneEmitted = true;
}

/**
 * Emit a top-level OpenAI error event so SDKs surface it rather than
 * silently ending the stream.
 */
function emitError(controller, state, { message, status, type, code }) {
  const payload = JSON.stringify({
    error: {
      message: truncate(message, 500) || `accio upstream status ${status}`,
      type: type || "accio_upstream_error",
      code: code ?? status,
    },
  });
  controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
  emitDone(controller, state);
}

/** Pick the first present numeric field out of several aliases. */
function pickNumber(source, keys) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Gemini usageMetadata → OpenAI usage.
 * @param {object} meta
 * @returns {object}
 */
function mapUsage(meta) {
  const promptTokens = pickNumber(meta, ["promptTokenCount", "prompt_tokens", "input_tokens"]);
  const completionTokens = pickNumber(meta, [
    "candidatesTokenCount",
    "completion_tokens",
    "output_tokens",
  ]);
  const reasoningTokens = pickNumber(meta, ["thoughtsTokenCount", "reasoning_tokens"]);
  const totalTokens =
    pickNumber(meta, ["totalTokenCount", "total_tokens"]) ||
    promptTokens + completionTokens + reasoningTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(reasoningTokens > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {}),
  };
}

/**
 * Read one gateway frame into the pieces an OpenAI chunk needs.
 *
 * @param {object} frame
 * @returns {{ text: string, reasoning: string, toolCalls: object[], turnComplete: boolean, usage: object|null }}
 */
export function readFrame(frame) {
  const parts = frame?.content?.parts ?? [];
  let text = "";
  let reasoning = "";
  const toolCalls = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;

    if (typeof part.text === "string" && part.text.length > 0) {
      if (part.thought) reasoning += part.text;
      else text += part.text;
    }

    const call = part.functionCall;
    if (call && typeof call === "object") {
      let args = {};
      if (call.argsJson) {
        try {
          const parsed = JSON.parse(call.argsJson);
          if (parsed && typeof parsed === "object") args = parsed;
        } catch {
          args = {};
        }
      } else if (call.args && typeof call.args === "object") {
        args = call.args;
      }
      toolCalls.push({
        id: call.id || "",
        name: call.name || "",
        arguments: args,
        // Signature may sit on the part or inside the call.
        thoughtSignature: part.thoughtSignature || call.thoughtSignature || "",
      });
    }
  }

  const usageMeta = frame?.usageMetadata ?? readRawUsage(frame);

  return {
    text,
    reasoning,
    toolCalls,
    turnComplete: frame?.turnComplete === true,
    usage: usageMeta ? mapUsage(usageMeta) : null,
  };
}

/** Some frames carry usage only inside rawResponseJson. */
function readRawUsage(frame) {
  const raw = frame?.rawResponseJson ?? frame?.raw_response_json;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.usageMetadata ?? parsed?.usage_metadata ?? null;
  } catch {
    return null;
  }
}

/** Extract a gateway error from a frame, or null when the frame is fine. */
function readFrameError(frame) {
  const code = frame?.error_code ?? frame?.errorCode;
  if (code == null || code === "") return null;
  const message =
    frame?.error_message ?? frame?.errorMessage ?? `accio gateway error ${code}`;
  return { code: String(code), message: String(message) };
}

/** Build one OpenAI streaming chunk. */
function buildChunk(model, state, { text, reasoning, toolCalls, finishReason, usage }) {
  const delta = {};
  if (state.roleEmitted !== true) {
    delta.role = "assistant";
    state.roleEmitted = true;
  }
  if (text) delta.content = text;
  if (reasoning) delta.reasoning_content = reasoning;

  if (toolCalls && toolCalls.length > 0) {
    delta.tool_calls = toolCalls.map((call, offset) => ({
      index: state.toolIndex + offset,
      id: encodeToolCallId(call.id, call.thoughtSignature),
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
    state.toolIndex += toolCalls.length;
  }

  const chunk = {
    id: state.chunkId,
    object: "chat.completion.chunk",
    created: state.created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function emitChunk(controller, state, chunk) {
  state.contentEmitted = true;
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk).replace(/\r?\n/g, "")}\n\n`));
}

/**
 * @param {Response} response
 * @param {string} model - label carried on emitted chunks
 * @returns {Response}
 */
export function wrapAccioSSE(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  let buffer = "";
  const state = {
    doneEmitted: false,
    contentEmitted: false,
    roleEmitted: false,
    toolIndex: 0,
    sawToolCall: false,
    chunkId: `chatcmpl-${Date.now().toString(36)}`,
    created: Math.floor(Date.now() / 1000),
  };

  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed || state.doneEmitted) return;
    if (!trimmed.startsWith("data:")) return;

    const data = trimmed.slice(5).trimStart();
    if (!data) return;
    if (data === "[DONE]") {
      emitDone(controller, state);
      return;
    }

    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame == null || typeof frame !== "object") return;

    const err = readFrameError(frame);
    if (err) {
      const isAuth = AUTH_CODES.has(err.code);
      const isRetry = RETRY_CODES.has(err.code);
      emitError(controller, state, {
        message: err.message,
        status: isAuth ? 401 : isRetry ? 429 : 502,
        type: isAuth
          ? "authentication_error"
          : isRetry
            ? "rate_limit_error"
            : "accio_upstream_error",
        code: isAuth ? "token_expired" : err.code,
      });
      return;
    }

    const { text, reasoning, toolCalls, turnComplete, usage } = readFrame(frame);
    if (toolCalls.length > 0) state.sawToolCall = true;

    const hasPayload = text || reasoning || toolCalls.length > 0;
    if (!hasPayload && !turnComplete && !usage) return;

    const finishReason = turnComplete ? (state.sawToolCall ? "tool_calls" : "stop") : null;
    emitChunk(
      controller,
      state,
      buildChunk(model, state, { text, reasoning, toolCalls, finishReason, usage }),
    );

    if (turnComplete) emitDone(controller, state);
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line, controller);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        processLine(buffer, controller);
        buffer = "";
      }
      if (!state.contentEmitted && !state.doneEmitted) {
        emitError(controller, state, {
          message: "Empty response: stream ended without any content",
          status: 502,
          type: "empty_response",
          code: "empty_response",
        });
        return;
      }
      emitDone(controller, state);
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
