/**
 * Unit tests for the Accio protocol layer.
 *
 * Focus is on logic that would produce wrong-but-plausible output if it
 * regressed — the format translation in both directions:
 *   - OpenAI messages → Gemini contents (system hoist, tool round-trip)
 *   - thoughtSignature packed through an OpenAI tool_call id
 *   - Accio SSE frames → OpenAI chunks (text, tools, errors, usage)
 *   - catalog parsing (visible filter, caps, etag/ttl)
 *   - quota mapping (two layers, derived `used`, graceful degradation)
 */

import { describe, it, expect, vi } from "vitest";

import {
  buildContents,
  buildTools,
  buildToolConfig,
  buildAccioRequest,
} from "../../open-sse/protocol/accio/body.js";
import { encodeToolCallId, decodeToolCallId } from "../../open-sse/protocol/accio/toolSignature.js";
import { readFrame, wrapAccioSSE } from "../../open-sse/protocol/accio/sse.js";
import {
  parseCatalog,
  mapModel,
  resolveExpiry,
  resolveAccioModels,
  invalidateAccioCatalog,
  clearAccioCatalog,
} from "../../open-sse/protocol/accio/catalog.js";
import { mapSubscription, getQuota } from "../../open-sse/protocol/accio/quota.js";
import { PROD_PROFILE, resolveProfile, createProtocol } from "../../open-sse/protocol/accio/index.js";
import { chat } from "../../open-sse/protocol/accio/chat.js";

/** Collect an SSE Response body into the list of parsed `data:` payloads. */
async function drainSSE(response) {
  const text = await response.text();
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      out.push("[DONE]");
      continue;
    }
    out.push(JSON.parse(data));
  }
  return out;
}

/** Build a streaming Response out of pre-baked SSE frames. */
function sseResponse(frames) {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("accio profile", () => {
  it("defaults to prod and rejects unknown ids", () => {
    expect(resolveProfile(null)).toBe(PROD_PROFILE);
    expect(resolveProfile("")).toBe(PROD_PROFILE);
    expect(resolveProfile("prod")).toBe(PROD_PROFILE);
    expect(() => resolveProfile("staging")).toThrow(/unknown protocol profile/);
  });

  it("requires chatUrl on an inline profile object", () => {
    expect(() => resolveProfile({ id: "custom" })).toThrow(/requires chatUrl/);
    const custom = { ...PROD_PROFILE, id: "custom" };
    expect(resolveProfile(custom)).toBe(custom);
  });

  it("points chat at the gateway RPC endpoint", () => {
    expect(PROD_PROFILE.chatUrl).toBe("https://phoenix-gw.alibaba.com/api/rlab/call");
    expect(PROD_PROFILE.subscriptionUrl).toContain("/api/entitlement/currentSubscription");
  });
});

describe("accio body — contents", () => {
  it("hoists system messages and joins them with blank lines", () => {
    const { contents, systemInstruction } = buildContents([
      { role: "system", content: "first" },
      { role: "user", content: "hello" },
      { role: "system", content: "second" },
    ]);
    expect(systemInstruction).toBe("first\n\nsecond");
    // System messages must not remain in the turn list.
    expect(contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
  });

  it("treats developer role as system", () => {
    const { systemInstruction } = buildContents([
      { role: "developer", content: "dev rule" },
      { role: "user", content: "hi" },
    ]);
    expect(systemInstruction).toBe("dev rule");
  });

  it("maps assistant turns to the model role", () => {
    const { contents } = buildContents([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "a" }] });
  });

  it("keeps an empty assistant turn valid instead of emitting empty parts", () => {
    const { contents } = buildContents([
      { role: "user", content: "q" },
      { role: "assistant", content: "" },
    ]);
    // Gemini rejects parts: []; a placeholder keeps the history well-formed.
    expect(contents[1].parts).toEqual([{ text: "" }]);
  });

  it("splits data URLs into inlineData and remote URLs into fileData", () => {
    const { contents } = buildContents([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/webp;base64,QUJD" } },
          { type: "image_url", image_url: { url: "https://example.com/a.png?v=2" } },
        ],
      },
    ]);
    expect(contents[0].parts).toEqual([
      { text: "look" },
      { inlineData: { mimeType: "image/webp", data: "QUJD" } },
      { fileData: { fileUri: "https://example.com/a.png?v=2", mimeType: "image/png" } },
    ]);
  });

  it("drops messages that carry no usable parts", () => {
    const { contents } = buildContents([
      { role: "user", content: "" },
      { role: "user", content: "real" },
    ]);
    expect(contents).toHaveLength(1);
  });

  it("throws rather than sending an empty conversation", () => {
    expect(() => buildAccioRequest({ model: "m", body: { messages: [] } })).toThrow(
      /no usable messages/,
    );
  });
});

describe("accio body — tool round-trip", () => {
  it("converts assistant tool_calls into functionCall parts", () => {
    const { contents } = buildContents([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SH"}' },
          },
        ],
      },
    ]);
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { id: "call_1", name: "get_weather", args: { city: "SH" } } }],
    });
  });

  it("degrades malformed tool arguments to an empty object", () => {
    const { contents } = buildContents([
      { role: "user", content: "x" },
      {
        role: "assistant",
        tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{oops" } }],
      },
    ]);
    expect(contents[1].parts[0].functionCall.args).toEqual({});
  });

  it("maps tool results to functionResponse under the user role", () => {
    const { contents } = buildContents([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temp":20}' },
    ]);
    // Gemini has no tool role; results ride as a user-side functionResponse.
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { id: "call_1", name: "get_weather", response: { temp: 20 } } },
      ],
    });
  });

  it("wraps non-JSON tool output in a result envelope", () => {
    const { contents } = buildContents([
      { role: "user", content: "x" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "plain text" },
    ]);
    expect(contents[2].parts[0].functionResponse.response).toEqual({ result: "plain text" });
  });

  it("restores the upstream call id and signature from a packed id", () => {
    const packed = encodeToolCallId("call_9", "sig-abc");
    const { contents } = buildContents([
      { role: "user", content: "x" },
      {
        role: "assistant",
        tool_calls: [{ id: packed, type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: packed, content: "{}" },
    ]);
    // The gateway must see its own id back, plus the signature it issued.
    expect(contents[1].parts[0].functionCall.id).toBe("call_9");
    expect(contents[1].parts[0].thoughtSignature).toBe("sig-abc");
    expect(contents[2].parts[0].functionResponse.id).toBe("call_9");
  });
});

describe("accio tool signature codec", () => {
  it("round-trips a signature", () => {
    const packed = encodeToolCallId("call_1", "abc/def+ghi==");
    expect(decodeToolCallId(packed)).toEqual({ callId: "call_1", signature: "abc/def+ghi==" });
  });

  it("leaves ids without a signature untouched", () => {
    expect(encodeToolCallId("call_1")).toBe("call_1");
    expect(decodeToolCallId("call_1")).toEqual({ callId: "call_1", signature: "" });
  });

  it("synthesises an id when upstream sends none", () => {
    expect(encodeToolCallId("")).toMatch(/^call_/);
  });

  it("drops the signature rather than emit an over-long id", () => {
    const packed = encodeToolCallId("call_1", "x".repeat(4000));
    // A truncated signature fails the turn; a missing one only loses context.
    expect(packed).toBe("call_1");
  });

  it("survives a corrupt payload", () => {
    expect(decodeToolCallId("call_1__accio_sig__!!!").callId).toBe("call_1");
    expect(decodeToolCallId(undefined)).toEqual({ callId: "", signature: "" });
  });
});

describe("accio body — tools and params", () => {
  it("wraps OpenAI tools as functionDeclarations", () => {
    const tools = buildTools([
      {
        type: "function",
        function: {
          name: "f",
          description: "d",
          parameters: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    ]);
    expect(tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "f",
            description: "d",
            parameters: { type: "object", properties: { a: { type: "string" } } },
          },
        ],
      },
    ]);
  });

  it("returns null when nothing is declarable", () => {
    // An empty tools array makes the gateway reject the request outright.
    expect(buildTools([])).toBeNull();
    expect(buildTools(undefined)).toBeNull();
    expect(buildTools([{ type: "function", function: {} }])).toBeNull();
  });

  it("maps tool_choice to a functionCallingConfig mode", () => {
    expect(buildToolConfig("none")).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(buildToolConfig("auto")).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(buildToolConfig("required")).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(buildToolConfig({ type: "function", function: { name: "f" } })).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] },
    });
    expect(buildToolConfig(undefined)).toBeNull();
  });

  it("renames generation params to their Gemini spellings", () => {
    const request = buildAccioRequest({
      model: "qwen3.7-plus",
      body: {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 512,
        temperature: 0.3,
      },
    });
    expect(request.maxOutputTokens).toBe(512);
    expect(request.temperature).toBe(0.3);
    expect(request.model).toBe("qwen3.7-plus");
    expect(request.properties).toEqual({ normalized_response: "true" });
    expect(request.iaiTag).toBe(PROD_PROFILE.iaiTag);
  });

  it("prefers max_completion_tokens over max_tokens", () => {
    const request = buildAccioRequest({
      model: "m",
      body: {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        max_completion_tokens: 200,
      },
    });
    expect(request.maxOutputTokens).toBe(200);
  });

  it("omits tools and toolConfig when absent", () => {
    const request = buildAccioRequest({
      model: "m",
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("toolConfig");
  });

  it("carries userId through as the session key", () => {
    const request = buildAccioRequest({
      model: "m",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { providerSpecificData: { userId: "u-1" } },
    });
    expect(request.sessionKey).toBe("u-1");
  });
});

describe("accio sse — frame reader", () => {
  it("separates visible text from thinking", () => {
    const frame = {
      content: {
        parts: [
          { text: "thinking...", thought: true },
          { text: "answer" },
        ],
      },
    };
    expect(readFrame(frame)).toMatchObject({ text: "answer", reasoning: "thinking..." });
  });

  it("parses functionCall argsJson and keeps the signature", () => {
    const frame = {
      content: {
        parts: [
          {
            functionCall: { id: "c1", name: "f", argsJson: '{"a":1}' },
            thoughtSignature: "sig",
          },
        ],
      },
    };
    const { toolCalls } = readFrame(frame);
    expect(toolCalls).toEqual([
      { id: "c1", name: "f", arguments: { a: 1 }, thoughtSignature: "sig" },
    ]);
  });

  it("maps Gemini token counts onto OpenAI usage", () => {
    const { usage } = readFrame({
      turnComplete: true,
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
        totalTokenCount: 18,
      },
    });
    expect(usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 18,
      completion_tokens_details: { reasoning_tokens: 3 },
    });
  });

  it("reads usage nested in rawResponseJson", () => {
    const { usage } = readFrame({
      rawResponseJson: JSON.stringify({ usageMetadata: { promptTokenCount: 7 } }),
    });
    expect(usage.prompt_tokens).toBe(7);
  });

  it("derives total tokens when the gateway omits them", () => {
    const { usage } = readFrame({
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
    });
    expect(usage.total_tokens).toBe(10);
  });
});

describe("accio sse — stream shaping", () => {
  it("emits content chunks and terminates on turnComplete", async () => {
    const response = wrapAccioSSE(
      sseResponse([
        { content: { parts: [{ text: "He" }] } },
        { content: { parts: [{ text: "llo" }] } },
        { turnComplete: true },
      ]),
      "test-model",
    );
    const events = await drainSSE(response);

    expect(events.at(-1)).toBe("[DONE]");
    expect(events[0].choices[0].delta).toEqual({ role: "assistant", content: "He" });
    // role is announced once, not on every chunk.
    expect(events[1].choices[0].delta).toEqual({ content: "llo" });
    expect(events[2].choices[0].finish_reason).toBe("stop");
    expect(events[0].model).toBe("test-model");
  });

  it("finishes with tool_calls once a tool was emitted", async () => {
    const response = wrapAccioSSE(
      sseResponse([
        {
          content: {
            parts: [{ functionCall: { id: "c1", name: "f", argsJson: "{}" }, thoughtSignature: "s" }],
          },
        },
        { turnComplete: true },
      ]),
      "m",
    );
    const events = await drainSSE(response);
    const call = events[0].choices[0].delta.tool_calls[0];

    expect(call.index).toBe(0);
    expect(call.type).toBe("function");
    expect(call.function).toEqual({ name: "f", arguments: "{}" });
    // The signature must survive to the client so the next turn can return it.
    expect(decodeToolCallId(call.id)).toEqual({ callId: "c1", signature: "s" });
    expect(events[1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("indexes tool calls across successive frames", async () => {
    const response = wrapAccioSSE(
      sseResponse([
        { content: { parts: [{ functionCall: { id: "a", name: "f1", argsJson: "{}" } }] } },
        { content: { parts: [{ functionCall: { id: "b", name: "f2", argsJson: "{}" } }] } },
        { turnComplete: true },
      ]),
      "m",
    );
    const events = await drainSSE(response);
    expect(events[0].choices[0].delta.tool_calls[0].index).toBe(0);
    expect(events[1].choices[0].delta.tool_calls[0].index).toBe(1);
  });

  it("surfaces thinking as reasoning_content", async () => {
    const response = wrapAccioSSE(
      sseResponse([
        { content: { parts: [{ text: "hmm", thought: true }] } },
        { turnComplete: true },
      ]),
      "m",
    );
    const events = await drainSSE(response);
    expect(events[0].choices[0].delta.reasoning_content).toBe("hmm");
  });

  it("classifies an auth error code as 401 token_expired", async () => {
    const response = wrapAccioSSE(
      sseResponse([{ error_code: "401", error_message: "login expired" }]),
      "m",
    );
    const events = await drainSSE(response);
    expect(events[0].error).toMatchObject({
      type: "authentication_error",
      code: "token_expired",
    });
  });

  it("classifies a retryable code as a rate-limit error", async () => {
    const response = wrapAccioSSE(sseResponse([{ error_code: "429" }]), "m");
    const events = await drainSSE(response);
    expect(events[0].error.type).toBe("rate_limit_error");
  });

  it("reports an empty stream as an error, not a silent stop", async () => {
    const response = wrapAccioSSE(new Response("", { status: 200 }), "m");
    const events = await drainSSE(response);
    expect(events[0].error).toMatchObject({ type: "empty_response", code: "empty_response" });
  });

  it("passes non-OK responses through untouched", () => {
    const failed = new Response("nope", { status: 500 });
    expect(wrapAccioSSE(failed, "m")).toBe(failed);
  });

  it("ignores unparseable data lines", async () => {
    const body = 'data: {oops\n\ndata: {"content":{"parts":[{"text":"ok"}]},"turnComplete":true}\n\n';
    const response = wrapAccioSSE(
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      "m",
    );
    const events = await drainSSE(response);
    expect(events[0].choices[0].delta.content).toBe("ok");
  });
});

describe("accio catalog", () => {
  const entry = {
    modelCode: "gpt-5",
    modelName: "gpt5",
    modelDisplayName: "GPT-5",
    modelDesc: "smart",
    multimodal: true,
    contextWindow: 200000,
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    isDefault: true,
  };

  it("maps a gateway entry onto the router model shape", () => {
    expect(mapModel(entry, "openai")).toEqual({
      id: "gpt-5",
      name: "GPT-5",
      contextLength: 200000,
      isVL: true,
      isReasoning: true,
      maxOutputTokens: 0,
      description: "smart",
      enabled: true,
      provider: "openai",
      isDefault: true,
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    });
  });

  it("treats thinkLevel alone as reasoning support", () => {
    expect(mapModel({ modelCode: "a", thinkLevel: 2 }, "p").isReasoning).toBe(true);
    expect(mapModel({ modelCode: "a", thinkLevel: 0 }, "p").isReasoning).toBe(false);
    expect(mapModel({ modelCode: "a" }, "p").isReasoning).toBe(false);
  });

  it("requires an id and falls back through the name fields", () => {
    expect(mapModel({ modelName: "only-name" }, "p").id).toBe("only-name");
    expect(mapModel({}, "p")).toBeNull();
  });

  it("hides invisible models but keeps them callable", () => {
    const parsed = parseCatalog(
      {
        providers: [
          {
            provider: "openai",
            modelList: [entry, { modelCode: "hidden-1", visible: false }],
          },
        ],
      },
      "etag-1",
    );
    expect(parsed.models.map((m) => m.id)).toEqual(["gpt-5"]);
    // chat still needs the raw block for hidden codes.
    expect([...parsed.rawConfigs.keys()]).toEqual(["gpt-5", "hidden-1"]);
    expect(parsed.etag).toBe("etag-1");
  });

  it("falls back to ext.version when no ETag header is present", () => {
    const parsed = parseCatalog(
      { providers: [{ provider: "p", modelList: [entry] }], ext: { version: "v9" } },
      "",
    );
    expect(parsed.etag).toBe("v9");
  });

  it("rejects a payload without a providers array", () => {
    expect(parseCatalog({}, "")).toBeNull();
    expect(parseCatalog(null, "")).toBeNull();
  });

  it("honours ttlSeconds, then nextChangeAt, then a default", () => {
    const now = Date.now();
    expect(resolveExpiry({ ttlSeconds: 7200 })).toBeGreaterThan(now + 7_000_000);
    // A too-short ttl is floored so it cannot cause a fetch per request.
    expect(resolveExpiry({ ttlSeconds: 1 })).toBeGreaterThanOrEqual(now + 60_000);
    expect(resolveExpiry({ nextChangeAt: now + 10 * 60 * 1000 })).toBeGreaterThan(now + 60_000);
    // A stale nextChangeAt must not produce an already-expired entry.
    expect(resolveExpiry({ nextChangeAt: now - 1000 })).toBeGreaterThan(now);
    expect(resolveExpiry({})).toBeGreaterThan(now + 3_500_000);
  });

  describe("cache and revalidation", () => {
    const credentials = { accessToken: "at-1", providerSpecificData: { userId: "u-1" } };
    const payload = {
      ttlSeconds: 900,
      providers: [{ provider: "google", modelList: [entry] }],
    };

    /** Serves the catalog once, then 304s — mirrors a real ETag exchange. */
    function etagFetch() {
      const fn = vi.fn(async () => {
        if (fn.mock.calls.length === 1) {
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: 'W/"abc123"' },
          });
        }
        return new Response("", { status: 304 });
      });
      return fn;
    }

    it("serves a warm cache without a second fetch", async () => {
      clearAccioCatalog();
      const fetchImpl = etagFetch();

      const first = await resolveAccioModels(credentials, { fetchImpl });
      const second = await resolveAccioModels(credentials, { fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(first.fetched).toBe(true);
      expect(second.models).toEqual(first.models);
    });

    it("sends the token in the body and identifies the client", async () => {
      clearAccioCatalog();
      const fetchImpl = etagFetch();
      await resolveAccioModels(credentials, { fetchImpl });

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(PROD_PROFILE.modelConfigUrl);
      // The catalog route names the credential `token`, unlike chat's `accessToken`.
      expect(JSON.parse(init.body)).toEqual({ token: "at-1" });
      expect(init.headers["x-package-region"]).toBe(PROD_PROFILE.packageRegion);
      expect(init.headers["x-app-version"]).toBe(PROD_PROFILE.appVersion);
      expect(init.headers).not.toHaveProperty("If-None-Match");
    });

    it("revalidates with the stored ETag and keeps models on 304", async () => {
      clearAccioCatalog();
      const fetchImpl = etagFetch();
      const first = await resolveAccioModels(credentials, { fetchImpl });

      // Invalidation must expire the entry, not drop it: the ETag is what makes
      // the next round trip cheap.
      invalidateAccioCatalog(credentials);
      const revalidated = await resolveAccioModels(credentials, { fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1][1].headers["If-None-Match"]).toBe('W/"abc123"');
      expect(revalidated.models).toEqual(first.models);
      expect(revalidated.fetched).toBe(true);
    });

    it("omits the ETag on a forced refresh so the gateway resends the body", async () => {
      clearAccioCatalog();
      const fetchImpl = etagFetch();
      await resolveAccioModels(credentials, { fetchImpl });
      await resolveAccioModels(credentials, { fetchImpl, forceRefresh: true });

      expect(fetchImpl.mock.calls[1][1].headers).not.toHaveProperty("If-None-Match");
    });

    it("serves stale models when a refetch fails", async () => {
      clearAccioCatalog();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockRejectedValueOnce(new Error("ECONNRESET"));

      const first = await resolveAccioModels(credentials, { fetchImpl });
      const afterFailure = await resolveAccioModels(credentials, {
        fetchImpl,
        forceRefresh: true,
      });

      // One upstream blip should not empty the model list.
      expect(afterFailure.models).toEqual(first.models);
      expect(afterFailure.fetched).toBe(true);
    });

    it("reports fetched=false when no catalog was ever obtained", async () => {
      clearAccioCatalog();
      const result = await resolveAccioModels(credentials, {
        fetchImpl: async () => new Response("nope", { status: 500 }),
      });
      expect(result).toEqual({ models: [], rawConfigs: new Map(), fetched: false });
    });

    it("shares one upstream call between concurrent resolves", async () => {
      clearAccioCatalog();
      const fetchImpl = etagFetch();

      const [a, b] = await Promise.all([
        resolveAccioModels(credentials, { fetchImpl }),
        resolveAccioModels(credentials, { fetchImpl }),
      ]);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(a.models).toEqual(b.models);
    });

    it("skips the network without an access token", async () => {
      clearAccioCatalog();
      const fetchImpl = vi.fn();
      const result = await resolveAccioModels({}, { fetchImpl });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.fetched).toBe(false);
    });
  });
});

describe("accio quota", () => {
  it("maps both credit layers", () => {
    const result = mapSubscription({
      type: "FREE",
      total: 1000,
      remaining: 400,
      entitlement: {
        daily: { total: 100, remaining: 30, used: 70, nextBillingDate: 1893456000000 },
        monthly: { nextBillingDate: 1893456000000 },
      },
    });

    expect(result.plan).toBe("Free");
    expect(result.quotas.daily).toMatchObject({ total: 100, used: 70, remaining: 30 });
    // The overall layer never reports `used`; it is derived.
    expect(result.quotas.overall).toMatchObject({ total: 1000, used: 600, remaining: 400 });
    expect(result.quotas.daily.resetAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("omits layers the account does not have", () => {
    const dailyOnly = mapSubscription({
      type: "FREE",
      entitlement: { daily: { total: 50, remaining: 50 } },
    });
    expect(Object.keys(dailyOnly.quotas)).toEqual(["daily"]);

    const overallOnly = mapSubscription({ type: "PRO", total: 500, remaining: 500 });
    expect(Object.keys(overallOnly.quotas)).toEqual(["overall"]);

    expect(mapSubscription({}).quotas).toEqual({});
  });

  it("computes the remaining percentage", () => {
    const { quotas } = mapSubscription({ total: 200, remaining: 50 });
    expect(quotas.overall.remainingPercentage).toBe(25);
  });

  it("accepts an ISO nextBillingDate", () => {
    const { quotas } = mapSubscription({
      entitlement: { daily: { total: 10, remaining: 10, nextBillingDate: "2030-06-01T00:00:00Z" } },
    });
    expect(quotas.daily.resetAt).toBe("2030-06-01T00:00:00.000Z");
  });

  it("reports a message instead of failing without a token", async () => {
    await expect(getQuota("")).resolves.toEqual({
      message: "Accio usage unavailable: no access token",
    });
  });

  it("unwraps a { success, data } envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { type: "PRO", total: 10, remaining: 4 } }), {
        status: 200,
      }),
    );
    const result = await getQuota("tok", { fetchImpl });
    expect(result.plan).toBe("Pro");
    expect(result.quotas.overall.remaining).toBe(4);

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ accessToken: "tok", subscripType: "INDIVIDUAL" });
  });

  it("degrades to a message on 401 and on transport failure", async () => {
    const unauthorized = await getQuota("tok", {
      fetchImpl: async () => new Response("{}", { status: 401 }),
    });
    expect(unauthorized).toEqual({ message: "Accio access token invalid or expired." });

    const broken = await getQuota("tok", {
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(broken.message).toContain("socket hang up");
  });

  it("reports an empty allocation without inventing quota rows", async () => {
    const result = await getQuota("tok", {
      fetchImpl: async () => new Response(JSON.stringify({ type: "FREE" }), { status: 200 }),
    });
    expect(result).toEqual({
      plan: "Free",
      message: "Accio connected. No credit allocation reported.",
    });
  });
});

describe("accio chat", () => {
  const credentials = { accessToken: "tok", providerSpecificData: { userId: "u1" } };
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("rejects a credential with no access token", async () => {
    const { response } = await chat({ model: "m", body, credentials: {} });
    expect(response.status).toBe(401);
    const payload = await response.json();
    expect(payload.error.message).toMatch(/missing accessToken/);
  });

  it("returns 400 for a request it cannot build", async () => {
    const { response } = await chat({ model: "m", body: { messages: [] }, credentials });
    expect(response.status).toBe(400);
  });

  it("wraps the request envelope with the access token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse([{ content: { parts: [{ text: "ok" }] } }, { turnComplete: true }]));

    const { url, transformedBody } = await chat({ model: "qwen3.7-plus", body, credentials, fetchImpl });

    expect(url).toBe(PROD_PROFILE.chatUrl);
    expect(transformedBody.accessToken).toBe("tok");
    expect(transformedBody.request.model).toBe("qwen3.7-plus");
    expect(transformedBody.request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers.Accept).toContain("text/event-stream");
  });

  it("converts upstream frames into OpenAI chunks", async () => {
    const fetchImpl = async () =>
      sseResponse([{ content: { parts: [{ text: "hello" }] } }, { turnComplete: true }]);
    const { response } = await chat({ model: "m", body, credentials, fetchImpl });
    const events = await drainSSE(response);
    expect(events[0].choices[0].delta.content).toBe("hello");
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("reports a transport failure as 502 rather than throwing", async () => {
    const { response } = await chat({
      model: "m",
      body,
      credentials,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(response.status).toBe(502);
  });

  it("passes an upstream error response through unwrapped", async () => {
    const upstream = new Response("bad", { status: 503 });
    const { response } = await chat({ model: "m", body, credentials, fetchImpl: async () => upstream });
    expect(response).toBe(upstream);
  });
});

describe("accio createProtocol", () => {
  it("binds the profile across the surface", () => {
    const protocol = createProtocol("prod");
    expect(protocol.profile).toBe(PROD_PROFILE);
    expect(typeof protocol.chat).toBe("function");
    expect(typeof protocol.getQuota).toBe("function");
    expect(typeof protocol.resolveModels).toBe("function");
    expect(typeof protocol.getModelConfig).toBe("function");
  });
});
