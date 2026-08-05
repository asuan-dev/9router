export default {
  id: "accio",
  priority: 84,
  alias: "ac",
  uiAlias: "ac",
  display: {
    name: "Accio Work",
    icon: "hub",
    color: "#FF6A00",
    website: "https://www.accio.com",
    notice: {
      signupUrl: "https://www.accio.com",
    },
  },
  category: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  transport: {
    // Gateway wraps every upstream model behind one RPC endpoint.
    baseUrl: "https://phoenix-gw.alibaba.com/api/rlab/call",
    headers: {},
    timeoutMs: 120000,
    usage: {
      url: "https://phoenix-gw.alibaba.com/api/entitlement/currentSubscription",
    },
  },
  // Fallback list only. The live catalog (POST /api/llm/config/v2) is the
  // source of truth and is fetched per credential.
  models: [
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "qwen3.7-plus", name: "Qwen3.7-Plus" },
    { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
  ],
  oauth: {
    gatewayBaseUrl: "https://phoenix-gw.alibaba.com",
    loginUrl: "https://www.accio.com/login",
    tokenExchangeUrl: "https://phoenix-gw.alibaba.com/api/oauth/token",
    refreshUrl: "https://phoenix-gw.alibaba.com/api/auth/refresh_token",
    safeRefreshUrl: "https://phoenix-gw.alibaba.com/api/auth/safe/refresh_token",
    userInfoUrl: "https://phoenix-gw.alibaba.com/api/auth/userinfo",
    modelConfigUrl: "https://phoenix-gw.alibaba.com/api/llm/config/v2",
    pcTokenUrl: "https://phoenix-gw.alibaba.com/api/rc/pc/token",
    clientId: "accio-work",
    // The desktop app uses an `accio://` deeplink; the gateway's login page
    // also accepts an http callback ("http_callback" mode upstream), so the
    // framework's loopback redirect URI is passed through at runtime.
    // Stamps lastRefreshAt after every refresh so staleness is trackable.
    trackRefreshAt: true,
  },
  features: {
    usage: true,
    // Live catalog replaces the static list above once a credential exists.
    passthroughModels: true,
    // Stores userId + umid device identity alongside the tokens.
    hasProviderSpecificData: true,
    // No check-in: upstream has no daily claim, only one-shot invite rewards.
  },
  protocolProfile: "prod",
};
