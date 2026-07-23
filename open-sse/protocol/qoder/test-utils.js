/**
 * Test-only surface for Qoder protocol primitives.
 * Production code should use chat/catalog/getQuota from index.js.
 */

export { qoderEncodeBody } from "./encoding.js";
export { buildCosyHeaders, generateMachineId } from "./cosy.js";
export { wrapQoderSSE } from "./sse.js";
export {
  normalizeMessages,
  buildQoderRequestBody,
  buildChatPayload,
} from "./body.js";
export {
  QODER_OPENAPI_BASE,
  QODER_CENTER_BASE,
  QODER_CHAT_BASE,
  QODER_LOGIN_URL,
  QODER_DEVICE_TOKEN_URL,
  QODER_USERINFO_URL,
  QODER_QUOTA_USAGE_URL,
  QODER_REFRESH_TOKEN_URL,
  QODER_CHAT_SIG_PATH,
  QODER_CHAT_URL,
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_LIST_URL,
  QODER_IDE_VERSION,
  QODER_CLIENT_TYPE,
  QODER_DATA_POLICY,
  QODER_LOGIN_VERSION,
  QODER_MACHINE_OS,
  QODER_MACHINE_TYPE,
  QODER_MODEL_MAP,
  QODER_RSA_PUBLIC_KEY,
} from "./constants.js";
