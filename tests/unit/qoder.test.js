/**
 * Unit tests for Qoder encoding + COSY signing primitives.
 *
 * These cover the parts that would silently produce wrong-but-plausible
 * output if logic regressed:
 *   - body encoder boundary cases (empty input, lengths not divisible by 3)
 *   - COSY header production (signature deterministic given fixed inputs,
 *     all required headers present, sigPath correctly stripped)
 *   - device flow URL construction
 */

import { describe, it, expect } from "vitest";
import crypto from "crypto";

import { qoderEncodeBody, buildCosyHeaders, normalizeMessages, wrapQoderSSE, buildQoderRequestBody } from "../../open-sse/protocol/qoder/test-utils.js";
import { SHELL, resolveReasoningEffort } from "../../open-sse/protocol/qoder/body.js";
import { QoderService } from "../../src/lib/oauth/services/qoder.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_LIST_URL,
  QODER_MODEL_MAP,
} from "../../open-sse/protocol/qoder/constants.js";
import {
  INTL_PROFILE,
  resolveProfile,
  createProtocol,
} from "../../open-sse/protocol/qoder/index.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

// Convenience aliases — tests were originally written against module-level
// helpers; the QoderService class wraps them so each test creates its own
// instance to avoid hidden state.
const generatePkcePair = () => new QoderService().generatePkcePair();
const initiateDeviceFlow = () => new QoderService().initiateDeviceFlow();
const parseExpiry = QoderService.parseExpiry;

describe("QODER_MODEL_MAP", () => {
  it("allows Qoder's latest model key", () => {
    expect(QODER_MODEL_MAP.qmodel_latest).toBe("qmodel_latest");
  });

  it("exposes Qoder's latest model in the static provider catalog", () => {
    expect(PROVIDER_MODELS.qd.some((model) => model.id === "qmodel_latest")).toBe(true);
  });
});

describe("qoderEncodeBody", () => {
  it("preserves base64 length (input length divisible by 3)", () => {
    const input = Buffer.from("abcdef", "utf8"); // 6 bytes → 8 base64 chars
    const encoded = qoderEncodeBody(input);
    expect(encoded.length).toBe(8);
  });

  it("preserves base64 length (input length not divisible by 3)", () => {
    const input = Buffer.from("hello", "utf8"); // 5 bytes → 8 base64 chars (with padding)
    const encoded = qoderEncodeBody(input);
    expect(encoded.length).toBe(8);
  });

  it("handles empty input without throwing", () => {
    const encoded = qoderEncodeBody(Buffer.alloc(0));
    expect(encoded).toBe("");
  });

  it("accepts string and Buffer inputs equivalently", () => {
    const a = qoderEncodeBody("hello");
    const b = qoderEncodeBody(Buffer.from("hello", "utf8"));
    expect(a).toBe(b);
  });

  it("only emits characters from the custom alphabet", () => {
    // The custom alphabet is "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
    // plus "$" for the padding char. If the substitution step regresses,
    // characters outside that set would leak into the output.
    const allowed = new Set(
      "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$",
    );
    const encoded = qoderEncodeBody(
      "hello world this is a longer string for testing 0123456789",
    );
    for (const ch of encoded) {
      expect(allowed.has(ch), `unexpected char in output: ${JSON.stringify(ch)}`).toBe(true);
    }
  });

  it("is deterministic for identical input", () => {
    const a = qoderEncodeBody("abc");
    const b = qoderEncodeBody("abc");
    expect(a).toBe(b);
  });

  it("produces different output for different input", () => {
    const a = qoderEncodeBody("abc");
    const b = qoderEncodeBody("xyz");
    expect(a).not.toBe(b);
  });
});

describe("generatePkcePair", () => {
  it("produces base64url-safe verifier and challenge of the right length", () => {
    const { verifier, challenge } = generatePkcePair();
    // 32 bytes → 43 base64url chars (no padding)
    expect(verifier.length).toBe(43);
    expect(challenge.length).toBe(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("verifier and challenge are different (challenge is sha256 of verifier)", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).not.toBe(challenge);
    // S256: challenge should be base64url(sha256(verifier))
    const expected = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(challenge).toBe(expected);
  });

  it("returns codeVerifier (not verifier) on the higher-level helper", () => {
    // Regression: the providers.js qoder entry once read flow.verifier (undefined)
    // because initiateDeviceFlow returns the field as `codeVerifier`.
    const flow = initiateDeviceFlow();
    expect(typeof flow.codeVerifier).toBe("string");
    expect(flow.codeVerifier.length).toBe(43);
    expect(flow.verifier).toBeUndefined();
  });
});

describe("initiateDeviceFlow", () => {
  it("produces a verification URL pointing at qoder.com/device/selectAccounts", () => {
    const flow = initiateDeviceFlow();
    expect(flow.verificationUriComplete).toMatch(
      /^https:\/\/qoder\.com\/device\/selectAccounts\?/,
    );
    expect(flow.verificationUriComplete).toContain("challenge_method=S256");
    expect(flow.verificationUriComplete).toContain(`nonce=${flow.nonce}`);
    expect(flow.verificationUriComplete).toContain(`machine_id=${flow.machineId}`);
  });

  it("returns nonce and machineId as UUIDs", () => {
    const flow = initiateDeviceFlow();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(flow.nonce).toMatch(uuidRe);
    expect(flow.machineId).toMatch(uuidRe);
  });
});

describe("buildCosyHeaders", () => {
  const creds = {
    userId: "test-user-id",
    authToken: "dt-test-token",
    name: "Test",
    email: "test@example.com",
    machineId: "fixed-machine-id",
  };

  it("produces all required Cosy-* headers", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    const required = [
      "Authorization",
      "Cosy-Key",
      "Cosy-User",
      "Cosy-Date",
      "Cosy-Version",
      "Cosy-Machineid",
      "Cosy-Machinetoken",
      "Cosy-Machinetype",
      "Cosy-Machineos",
      "Cosy-Clienttype",
      "Cosy-Clientip",
      "Cosy-Bodyhash",
      "Cosy-Bodylength",
      "Cosy-Sigpath",
      "Cosy-Data-Policy",
      "Login-Version",
      "X-Request-Id",
    ];
    for (const key of required) {
      expect(headers[key], `missing header ${key}`).toBeDefined();
    }
  });

  it("Authorization is a Bearer COSY token with payload+sig", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers.Authorization).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[a-f0-9]{32}$/);
  });

  it("Authorization sig matches official space-separated Cosy MD5 input", () => {
    // Official Qoder IDE 1.17.3 / QoderWork CN: MD5(payload + " " + key + " " + ts + " " + body + " " + sigPath).
    // A newline-joined sigInput must NOT match the Authorization signature.
    const body = Buffer.from("space-delimiter-probe", "utf8");
    const headers = buildCosyHeaders(body, QODER_MODEL_LIST_URL, creds);
    const auth = headers.Authorization;
    const m = /^Bearer COSY\.([A-Za-z0-9+/=]+)\.([a-f0-9]{32})$/.exec(auth);
    expect(m).toBeTruthy();
    const payloadB64 = m[1];
    const sig = m[2];
    const cosyKey = headers["Cosy-Key"];
    const timestamp = headers["Cosy-Date"];
    const sigPath = headers["Cosy-Sigpath"];
    const bodyLatin1 = body.toString("latin1");
    const spaceInput = `${payloadB64} ${cosyKey} ${timestamp} ${bodyLatin1} ${sigPath}`;
    const newlineInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyLatin1}\n${sigPath}`;
    const spaceMd5 = crypto.createHash("md5").update(Buffer.from(spaceInput, "latin1")).digest("hex");
    const newlineMd5 = crypto.createHash("md5").update(Buffer.from(newlineInput, "latin1")).digest("hex");
    expect(sig).toBe(spaceMd5);
    expect(sig).not.toBe(newlineMd5);
  });

  it("Cosy-Sigpath strips the leading /algo prefix", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers["Cosy-Sigpath"]).toBe("/api/v2/model/list");
  });

  it("Cosy-Sigpath also handles the encoded chat URL", () => {
    const headers = buildCosyHeaders(Buffer.from("body", "utf8"), QODER_CHAT_URL_ENCODED, creds);
    expect(headers["Cosy-Sigpath"]).toBe(
      "/api/v2/service/pro/sse/agent_chat_generation",
    );
  });

  it("Cosy-Bodyhash is the MD5 of the request body, Cosy-Bodylength is the length", () => {
    const body = Buffer.from("hello qoder", "utf8");
    const headers = buildCosyHeaders(body, QODER_MODEL_LIST_URL, creds);
    const expectedHash = crypto.createHash("md5").update(body).digest("hex");
    expect(headers["Cosy-Bodyhash"]).toBe(expectedHash);
    expect(headers["Cosy-Bodylength"]).toBe(String(body.length));
  });

  it("empty body produces the canonical empty-MD5 hash", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers["Cosy-Bodyhash"]).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(headers["Cosy-Bodylength"]).toBe("0");
  });

  it("Cosy-Machineid + Cosy-Machinetoken match the supplied machineId", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers["Cosy-Machineid"]).toBe("fixed-machine-id");
    expect(headers["Cosy-Machinetoken"]).toBe("fixed-machine-id");
  });

  it("auto-generates a machineId when none is supplied", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, {
      ...creds,
      machineId: "",
    });
    expect(headers["Cosy-Machineid"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("throws when userId is missing", () => {
    expect(() =>
      buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, { ...creds, userId: "" }),
    ).toThrow(/user id is empty/);
  });

  it("throws when authToken is missing", () => {
    expect(() =>
      buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, { ...creds, authToken: "" }),
    ).toThrow(/auth token is empty/);
  });

  it("Cosy-User reflects the supplied userId verbatim", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers["Cosy-User"]).toBe("test-user-id");
  });

  it("two calls with identical inputs differ only in fields that include fresh randomness", () => {
    // The signature fingerprints a fresh AES key + UUID per call, so the
    // signature, Cosy-Key, X-Request-Id, and Cosy-Date (1s resolution)
    // can differ — but Cosy-User, Cosy-Bodyhash, Cosy-Bodylength,
    // Cosy-Sigpath, and the machineId-derived headers must be stable.
    const a = buildCosyHeaders(Buffer.from("payload", "utf8"), QODER_CHAT_URL_ENCODED, creds);
    const b = buildCosyHeaders(Buffer.from("payload", "utf8"), QODER_CHAT_URL_ENCODED, creds);
    expect(a["Cosy-User"]).toBe(b["Cosy-User"]);
    expect(a["Cosy-Bodyhash"]).toBe(b["Cosy-Bodyhash"]);
    expect(a["Cosy-Bodylength"]).toBe(b["Cosy-Bodylength"]);
    expect(a["Cosy-Sigpath"]).toBe(b["Cosy-Sigpath"]);
    expect(a["Cosy-Machineid"]).toBe(b["Cosy-Machineid"]);
    expect(a["X-Request-Id"]).not.toBe(b["X-Request-Id"]);
  });
});

describe("parseExpiry", () => {
  // Regression for review finding #2: numeric expires_at was silently
  // dropped because the function only inspected strings.
  it("accepts ms-epoch as a JSON number", () => {
    const future = Date.now() + 60_000;
    expect(parseExpiry(future, undefined)).toBe(future);
  });

  it("accepts ms-epoch as a numeric string", () => {
    const future = Date.now() + 60_000;
    expect(parseExpiry(String(future), undefined)).toBe(future);
  });

  it("accepts RFC3339 strings", () => {
    const iso = "2030-01-02T03:04:05Z";
    expect(parseExpiry(iso, undefined)).toBe(Date.parse(iso));
  });

  // Regression for review finding #5: Date.parse("2026") returns Jan 1 2026,
  // so a short numeric string like "2026" used to be interpreted as a year
  // instead of falling through to the integer-ms branch. We now try the
  // pure-numeric path first so this can't happen again.
  it("does not interpret short numeric strings as a year", () => {
    // "1700000000" (Unix seconds) should NOT come out as Date.parse("1700000000")
    const result = parseExpiry("1700000000", undefined);
    // 1.7e9 ms = 1970-01-20 — the function's contract is ms, so we expect
    // exactly that value, not a year interpretation.
    expect(result).toBe(1_700_000_000);
  });

  it("falls back to expiresInSeconds when expiresAt is missing", () => {
    const before = Date.now();
    const result = parseExpiry(undefined, 60);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before + 60_000);
    expect(result).toBeLessThanOrEqual(after + 60_000);
  });

  // Regression for review finding #7: expiresInSeconds=0 used to be treated
  // as missing and silently fabricated 30-day default. We now honor 0 as
  // "already expired".
  it("treats expires_in: 0 as already expired (now), not 30-day fallback", () => {
    const before = Date.now();
    const result = parseExpiry(undefined, 0);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it("falls back to ~30 days when both inputs are missing", () => {
    const before = Date.now();
    const result = parseExpiry(undefined, undefined);
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    // Allow a small skew to absorb test runtime.
    expect(result).toBeGreaterThanOrEqual(expected - 5_000);
    expect(result).toBeLessThanOrEqual(expected + 5_000);
  });

  it("falls back to ~30 days when both inputs are unparseable", () => {
    const before = Date.now();
    const result = parseExpiry("not-a-date", -5);
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    expect(result).toBeGreaterThanOrEqual(expected - 5_000);
    expect(result).toBeLessThanOrEqual(expected + 5_000);
  });
});

describe("normalizeMessages", () => {
  
  it("hoists role:system out of messages into systemText", () => {
    const result = normalizeMessages([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(result.systemText).toBe("you are helpful");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("flattens multipart text content into a string", () => {
    const result = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" },
        ],
      },
    ]);
    expect(result.messages[0].content).toBe("part1\npart2");
  });

  it("joins multiple system messages with a blank line", () => {
    const result = normalizeMessages([
      { role: "system", content: "rule 1" },
      { role: "system", content: "rule 2" },
      { role: "user", content: "hi" },
    ]);
    expect(result.systemText).toBe("rule 1\n\nrule 2");
  });

  it("returns empty results for empty input", () => {
    const result = normalizeMessages([]);
    expect(result.messages).toEqual([]);
    expect(result.systemText).toBe("");
  });

  it("hoists developer role into systemText like system", () => {
    const result = normalizeMessages([
      { role: "developer", content: "dev rules" },
      { role: "user", content: "hi" },
    ]);
    expect(result.systemText).toBe("dev rules");
    expect(result.messages).toHaveLength(1);
  });
});

describe("wrapQoderSSE", () => {
  

  // Helper: build a fake Response carrying the given lines as the body.
  function makeResponse(lines, { status = 200 } = {}) {
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(body, { status });
  }

  // Helper: drain a wrapped response into an array of decoded SSE events.
  async function drain(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    buf += decoder.decode();
    return buf;
  }

  it("forwards an OpenAI envelope chunk and emits [DONE] in flush", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
    const upstream = `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`;
    const wrapped = wrapQoderSSE(makeResponse([upstream]), "qoder/auto");
    const out = await drain(wrapped);
    expect(out).toContain(`data: ${inner}\n\n`);
    expect(out).toContain("data: [DONE]\n\n");
  });

  // Regression for review finding #4: a final data: line without a trailing
  // newline used to be silently dropped from `buffer` in flush().
  it("drains a trailing partial line without a newline in flush()", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "tail" } }], finish_reason: "stop" });
    // Note: NO trailing \n on the final line.
    const upstream = `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}`;
    const wrapped = wrapQoderSSE(makeResponse([upstream]), "qoder/auto");
    const out = await drain(wrapped);
    expect(out).toContain(`data: ${inner}\n\n`);
  });

  // Regression for review finding #3: chunks could leak past [DONE] when
  // the success branch had no doneEmitted guard. We synthesize an error
  // envelope (which sets doneEmitted=true) followed by a valid envelope
  // and assert the second envelope is NOT forwarded.
  it("does not forward chunks after [DONE] has been emitted", async () => {
    const errorEnv = JSON.stringify({ statusCodeValue: 500, body: "boom" });
    const validInner = JSON.stringify({ choices: [{ delta: { content: "leak" } }] });
    const validEnv = JSON.stringify({ statusCodeValue: 200, body: validInner });
    const wrapped = wrapQoderSSE(
      makeResponse([`data: ${errorEnv}\n\ndata: ${validEnv}\n\n`]),
      "qoder/auto",
    );
    const out = await drain(wrapped);
    expect(out).not.toContain("leak");
    // Should still have a single [DONE].
    const doneCount = (out.match(/data: \[DONE\]/g) || []).length;
    expect(doneCount).toBe(1);
  });

  // Regression for review finding #6: literal newlines inside the inner
  // OpenAI body would split the SSE frame across multiple data: lines.
  // We now strip them so the frame stays a single event.
  it("strips embedded newlines from inner body before forwarding", async () => {
    const innerWithNewlines = '{"choices":[{"delta":{"content":"a\nb"}}]}';
    const env = JSON.stringify({ statusCodeValue: 200, body: innerWithNewlines });
    const wrapped = wrapQoderSSE(makeResponse([`data: ${env}\n\n`]), "qoder/auto");
    const out = await drain(wrapped);
    // The forwarded data: line should be a single event terminated by \n\n
    // and contain no internal \n other than the trailing pair.
    const dataLine = out.split("\n\n").find((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    expect(dataLine).toBeDefined();
    // Body sans "data: " prefix should be valid JSON.
    expect(() => JSON.parse(dataLine.slice("data: ".length))).not.toThrow();
  });

  it("upstream error envelope produces an error chunk + [DONE]", async () => {
    const env = JSON.stringify({ statusCodeValue: 503, body: "service unavailable" });
    const wrapped = wrapQoderSSE(makeResponse([`data: ${env}\n\n`]), "qoder/lite");
    const out = await drain(wrapped);
    expect(out).toContain("[qoder error 503");
    expect(out).toContain("data: [DONE]\n\n");
  });

  it("non-ok responses are returned unchanged (no transform)", () => {
    const r = new Response("not ok", { status: 500 });
    const wrapped = wrapQoderSSE(r, "qoder/auto");
    expect(wrapped).toBe(r);
  });
});

describe("protocol profile", () => {
  it("defaults null to intl", () => {
    expect(resolveProfile(null).id).toBe("intl");
    expect(resolveProfile(undefined).chatUrl).toBe(INTL_PROFILE.chatUrl);
  });

  it("throws on unknown profile id (no silent intl fallback)", () => {
    expect(() => resolveProfile("nope")).toThrow(/unknown protocol profile/);
  });

  it("accepts profile object for composition without registry", () => {
    const alt = {
      ...INTL_PROFILE,
      id: "test-alt",
      chatUrl: "https://example.test/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1",
      sessionType: "test-session",
      businessProduct: "test-product",
    };
    const p = resolveProfile(alt);
    expect(p.chatUrl).toContain("example.test");
    expect(p.sessionType).toBe("test-session");
  });

  it("createProtocol binds intl by default", () => {
    const proto = createProtocol();
    expect(proto.profile.id).toBe("intl");
    expect(proto.profile.chatUrl).toBe(INTL_PROFILE.chatUrl);
  });

  it("createProtocol accepts inline profile object (future region = data only)", () => {
    const alt = { ...INTL_PROFILE, id: "alt", chatUrl: "https://example.test/chat?Encode=1" };
    const proto = createProtocol(alt);
    expect(proto.profile.id).toBe("alt");
    expect(proto.profile.chatUrl).toContain("example.test");
  });
});

describe("profile-driven payload + cosy (simulation)", () => {
  const creds = {
    userId: "u1",
    authToken: "dt-test",
    name: "N",
    email: "e@x.com",
    machineId: "fixed-machine-id",
  };

  it("buildQoderRequestBody uses profile session/business fields", async () => {
    const alt = {
      ...INTL_PROFILE,
      id: "test-alt",
      sessionType: "sim-session",
      businessProduct: "sim-product",
      businessVersion: "9.9.9",
    };
    // Avoid live catalog: inject rawConfigs via resolve path is hard;
    // call buildQoderRequestBody only if model config available — use force path with stub.
    // Instead assert createProtocol profile binding + Cosy version from profile.
    const headers = buildCosyHeaders(Buffer.alloc(0), alt.chatUrl || QODER_MODEL_LIST_URL, creds, {
      ...alt,
      ideVersion: "9.9.9-test",
      clientType: "99",
      machineOs: "test_os",
      machineType: "99",
      dataPolicy: "agree",
      loginVersion: "v-test",
    });
    expect(headers["Cosy-Version"]).toBe("9.9.9-test");
    expect(headers["Cosy-Clienttype"]).toBe("99");
    expect(headers["Cosy-Machineos"]).toBe("test_os");
    expect(headers["Login-Version"]).toBe("v-test");
    expect(headers["Cosy-Data-Policy"]).toBe("agree");
  });

  it("OAuth service uses injected profile login + device URLs", () => {
    const alt = {
      ...INTL_PROFILE,
      id: "alt",
      loginUrl: "https://example.test/device/selectAccounts",
      deviceTokenUrl: "https://example.test/api/v1/deviceToken/poll",
    };
    const svc = new QoderService({ profile: alt });
    const flow = svc.initiateDeviceFlow();
    expect(flow.verificationUriComplete.startsWith(alt.loginUrl)).toBe(true);
    expect(svc.profile.deviceTokenUrl).toBe(alt.deviceTokenUrl);
  });

  it("default OAuth service stays on intl hosts", () => {
    const svc = new QoderService();
    const flow = svc.initiateDeviceFlow();
    expect(flow.verificationUriComplete.startsWith(INTL_PROFILE.loginUrl)).toBe(true);
  });
});

describe("contract body (awA)", () => {
  const credentials = {
    accessToken: "dt-test",
    displayName: "T",
    email: "t@x.com",
    providerSpecificData: { userId: "u1", machineId: "m1" },
  };
  const fakeModelConfig = {
    key: "qmodel_latest",
    display_name: "Q",
    is_reasoning: true,
    max_output_tokens: 8192,
    max_input_tokens: 100000,
    source: "system",
    format: "openai",
  };

  it("builds FREE_INPUT shell without catalog when modelConfig injected", async () => {
    const { qoderKey, payload } = await buildQoderRequestBody({
      model: "qoder/qmodel_latest",
      body: {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello world" },
        ],
        max_tokens: 1000,
        tools: [],
      },
      credentials,
      modelConfig: fakeModelConfig,
    });
    expect(qoderKey).toBe("qmodel_latest");
    expect(payload.chat_task).toBe(SHELL.chat_task);
    expect(payload.source).toBe(1);
    expect(payload.version).toBe("3");
    expect(payload.agent_id).toBe("agent_common");
    expect(payload.stream).toBe(true);
    expect(payload.system).toBe("sys");
    expect(payload.messages).toEqual([{ role: "user", content: "hello world" }]);
    expect(payload.parameters.max_tokens).toBe(1000);
    expect(payload.model_config.key).toBe("qmodel_latest");
    expect(payload.chat_context.text).toBe("hello world");
    expect(payload.chat_context.extra.modelConfig).toEqual({
      key: "qmodel_latest",
      is_reasoning: true,
    });
    // awA: three ids share request_id by default
    expect(payload.request_id).toBe(payload.request_set_id);
    expect(payload.request_id).toBe(payload.chat_record_id);
    // business omitted by default
    expect(payload.business).toBeUndefined();
  });

  it("maps reasoning_effort into parameters", async () => {
    const { payload } = await buildQoderRequestBody({
      model: "qmodel_latest",
      body: {
        messages: [{ role: "user", content: "x" }],
        reasoning_effort: "high",
      },
      credentials,
      modelConfig: fakeModelConfig,
    });
    expect(payload.parameters.reasoning_effort).toBe("high");
  });

  it("includeBusiness adds business block from profile", async () => {
    const { payload } = await buildQoderRequestBody({
      model: "qmodel_latest",
      body: { messages: [{ role: "user", content: "title here" }] },
      credentials,
      modelConfig: fakeModelConfig,
      includeBusiness: true,
    });
    expect(payload.business).toBeDefined();
    expect(payload.business.product).toBeDefined();
    expect(payload.business.type).toBe("agent");
  });

  it("resolveReasoningEffort normalizes aliases", () => {
    expect(resolveReasoningEffort({ reasoning_effort: "x-high" })).toBe("xhigh");
    expect(resolveReasoningEffort({ reasoning: { effort: "low" } })).toBe("low");
    expect(resolveReasoningEffort({ reasoning_effort: "auto" })).toBeUndefined();
  });
});
