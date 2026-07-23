/**
 * Unwrap Qoder {statusCodeValue, body} SSE into plain OpenAI SSE.
 */

import { SSE_DONE } from "../../utils/sseConstants.js";

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

function wrapQoderSSE(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;

  // Process one already-extracted SSE line (no trailing newline). Returns
  // false when the line indicated end-of-stream so the caller can stop
  // forwarding any remaining chunks after [DONE].
  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted) return; // never forward chunks past stream end

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    // Inner is an OpenAI-shaped chunk. Strip any embedded newlines so the
    // SSE frame stays a single event (a literal "\n" inside `inner` would
    // otherwise split the frame across multiple data: lines and downstream
    // parsers would reassemble them as separate events).
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
      // Finalize the decoder so any pending multi-byte sequence is
      // released into `buffer` instead of being silently dropped.
      buffer += decoder.decode();
      // Drain any trailing line that arrived without a terminating newline
      // (e.g. upstream closed the socket immediately after the last write,
      // or a CDN stripped the final CRLF). Without this, the chunk that
      // carries finish_reason is silently lost.
      if (buffer.length > 0) {
        processLine(buffer, controller);
        buffer = "";
      }
      if (!doneEmitted) {
        controller.enqueue(encoder.encode(SSE_DONE));
        doneEmitted = true;
      }
    },
  });

  const transformed = response.body.pipeThrough(transform);
  // Build a Response with passable headers; the streaming handler reads
  // `.body` as a ReadableStream regardless of Content-Type.
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}


export { wrapQoderSSE };
