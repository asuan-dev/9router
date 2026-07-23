/**
 * Unwrap Qoder `{ statusCodeValue, body }` SSE into plain OpenAI SSE.
 *
 * Contract: lab/qodercli/1.1.3 payload-parser + official EPA special tokens:
 *   [DONE] | [NOT_EXCEED_QUOTA] | [EXCEED_QUOTA]* | [NOTIFICATIONS]*
 *
 * Non-200 envelopes become an OpenAI-shaped **error** event (not fake content).
 */

import { SSE_DONE } from "../../utils/sseConstants.js";

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/** Official special body tokens (Bun EPA). */
function isSpecialToken(data) {
  return (
    data === "[DONE]" ||
    data === "[NOT_EXCEED_QUOTA]" ||
    data.startsWith("[EXCEED_QUOTA]") ||
    data.startsWith("[NOTIFICATIONS]")
  );
}

function emitDone(controller, state) {
  if (state.doneEmitted) return;
  controller.enqueue(new TextEncoder().encode(SSE_DONE));
  state.doneEmitted = true;
}

function emitOpenAIError(controller, state, { model, message, statusVal }) {
  const errChunk = JSON.stringify({
    id: `qoder-error-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    error: {
      message: truncate(message, 500) || `qoder upstream status ${statusVal}`,
      type: "qoder_upstream_error",
      code: statusVal,
    },
  });
  controller.enqueue(new TextEncoder().encode(`data: ${errChunk}\n\n`));
  emitDone(controller, state);
}

/**
 * @param {Response} response
 * @param {string} model - label for error chunks
 */
function wrapQoderSSE(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { doneEmitted: false };

  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (state.doneEmitted) return;

    const data = trimmed.slice(5).trimStart();

    // Top-level special tokens (no JSON envelope)
    if (data === "[DONE]") {
      emitDone(controller, state);
      return;
    }
    if (data === "[NOT_EXCEED_QUOTA]" || data.startsWith("[NOTIFICATIONS]")) {
      // Control / advisory — do not forward as model content
      return;
    }
    if (data.startsWith("[EXCEED_QUOTA]")) {
      emitOpenAIError(controller, state, {
        model,
        message: data,
        statusVal: 429,
      });
      return;
    }

    let envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }

    // Non-envelope JSON: ignore (not official chat path)
    if (envelope == null || typeof envelope !== "object") return;

    const statusVal =
      typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";

    if (statusVal !== 200) {
      emitOpenAIError(controller, state, {
        model,
        message: inner || `upstream status ${statusVal}`,
        statusVal,
      });
      return;
    }

    if (!inner) return;

    if (isSpecialToken(inner)) {
      if (inner === "[DONE]") {
        emitDone(controller, state);
        return;
      }
      if (inner.startsWith("[EXCEED_QUOTA]")) {
        emitOpenAIError(controller, state, { model, message: inner, statusVal: 429 });
        return;
      }
      // NOT_EXCEED_QUOTA / NOTIFICATIONS — skip
      return;
    }

    // OpenAI-shaped chunk string — keep single SSE frame
    const sanitized = inner.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
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
      emitDone(controller, state);
    },
  });

  const transformed = response.body.pipeThrough(transform);
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export { wrapQoderSSE, isSpecialToken };
