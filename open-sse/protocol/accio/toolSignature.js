/**
 * Round-trip Gemini `thoughtSignature` through OpenAI tool-call ids.
 *
 * The gateway issues a signature alongside each functionCall and rejects a
 * follow-up turn that drops it. OpenAI's schema has no field for it, so the
 * signature rides inside `tool_calls[].id` — the one value clients echo back
 * verbatim in the matching `tool` message.
 *
 * Format: `<callId>__accio_sig__<base64url(signature)>`
 *
 * Encoding is stateless on purpose: a process-local Map would break across
 * restarts and multi-instance deployments.
 */

const SEPARATOR = "__accio_sig__";

/**
 * Ids longer than this risk upstream validation, so the signature is dropped
 * rather than sent truncated (a corrupt signature fails the whole turn; a
 * missing one only loses thinking continuity).
 */
const MAX_ID_LENGTH = 1024;

function toBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Pack a call id and its signature into a single OpenAI tool-call id.
 *
 * @param {string} callId - upstream functionCall.id (may be empty)
 * @param {string} [signature]
 * @returns {string}
 */
export function encodeToolCallId(callId, signature = "") {
  const base = callId || `call_${Math.random().toString(36).slice(2, 10)}`;
  if (!signature) return base;

  const encoded = `${base}${SEPARATOR}${toBase64Url(signature)}`;
  return encoded.length > MAX_ID_LENGTH ? base : encoded;
}

/**
 * Split a packed id back into its parts. Ids we never touched come back with
 * an empty signature.
 *
 * @param {string} toolCallId
 * @returns {{ callId: string, signature: string }}
 */
export function decodeToolCallId(toolCallId) {
  if (typeof toolCallId !== "string" || !toolCallId) {
    return { callId: "", signature: "" };
  }
  const at = toolCallId.indexOf(SEPARATOR);
  if (at < 0) return { callId: toolCallId, signature: "" };

  return {
    callId: toolCallId.slice(0, at),
    signature: fromBase64Url(toolCallId.slice(at + SEPARATOR.length)),
  };
}
