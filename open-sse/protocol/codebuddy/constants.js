/**
 * CodeBuddy CN chat wire constants.
 *
 * Upstream is OpenAI-shaped Chat Completions, but this proxy is **minimal**:
 * only fields the official CLI / common chat path need. Hub Chat baseline
 * (axonhub openai-chat-completions-protocol.md) documents the full OpenAI
 * create surface — we do **not** re-emit the full surface to CodeBuddy
 * (store/metadata/stream_options/etc. would mark us as a passthrough proxy).
 *
 * Evidence: lab/workbuddy unpack; #2071; PRD 07-24-codebuddy-cn-protocol-parity.
 */

/** Top-level fields forwarded when present. */
export const CHAT_BODY_ALLOWLIST = Object.freeze([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "n",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "user",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "seed",
  // Conditional — kept only when effort is on (see request.js).
  "reasoning_effort",
  "reasoning_summary",
]);

/** Effort values that mean "do not send reasoning params". */
export const REASONING_OFF = Object.freeze(new Set(["none", "off", ""]));
