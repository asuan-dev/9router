/**
 * CodeBuddy CN protocol — public surface (minimal OpenAI Chat proxy).
 *
 *   sanitizeChatBody / normalizeChatChunk / createSseNormalizeTransform
 *
 * Executor stays thin; wire rules live here (same packaging idea as protocol/qoder,
 * different protocol family — no COSY / private shell).
 */

export { CHAT_BODY_ALLOWLIST, REASONING_OFF } from "./constants.js";
export { sanitizeChatBody } from "./request.js";
export { normalizeChatChunk, createSseNormalizeTransform } from "./response.js";
