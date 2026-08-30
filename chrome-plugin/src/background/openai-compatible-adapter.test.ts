import { describe, expect, it, vi } from "vitest";
import type { ModelProfile } from "./config-repository";
import {
  ModelRequestError,
  OpenAiCompatibleAdapter,
  type JsonSchemaSpec,
} from "./openai-compatible-adapter";
import { buildCorePrompt, buildDetailPrompt, buildRepairPrompt } from "./prompts";
import { CORE_SCHEMA_VERSION } from "../shared/versions";

const profile: ModelProfile = {
  id: "profile-1",
  name: "Compatible",
  baseUrl: "https://model.example/v1",
  apiKey: "secret",
  model: "syntax-model",
  headers: { "X-Tenant": "learning" },
  timeoutMs: 5_000,
  jsonSchemaSupport: "unknown",
};

const schema: JsonSchemaSpec = {
  name: "core_analysis",
  schema: { type: "object", required: ["sentences"] },
};
const messages = [{ role: "user" as const, content: "Analyze." }];

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function completion(content: string): Response {
  return response({ choices: [{ message: { content } }] });
}

function requestBody(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, call: number) {
  const body = fetch.mock.calls[call]![1]?.body;
  if (typeof body !== "string") throw new Error("Expected a string request body");
  return JSON.parse(body) as unknown;
}

describe("OpenAI-compatible chat completions adapter", () => {
  it("probes JSON capability with one low-cost schema request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion('{"ok":true}'));
    const persistJsonSchemaSupport = vi.fn().mockResolvedValue(undefined);
    const adapter = new OpenAiCompatibleAdapter({ fetch, persistJsonSchemaSupport });

    await expect(adapter.probeJsonCapability(profile, new AbortController().signal)).resolves.toBe(
      "supported",
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(requestBody(fetch, 0)).toMatchObject({
      model: "syntax-model",
      response_format: { type: "json_schema" },
    });
    // Reasoning models spend the token budget on hidden chain-of-thought and
    // return an empty message when capped, so the probe must not send one.
    expect(requestBody(fetch, 0)).not.toHaveProperty("max_tokens");
    expect(persistJsonSchemaSupport).toHaveBeenCalledWith("profile-1", "supported");
  });

  it("uses one explainable fallback request only after an explicit schema-format rejection", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response("response_format is not supported", { status: 400 }))
      .mockResolvedValueOnce(completion('{"ok":true}'));
    const persistJsonSchemaSupport = vi.fn().mockResolvedValue(undefined);
    const adapter = new OpenAiCompatibleAdapter({ fetch, persistJsonSchemaSupport });

    await expect(adapter.probeJsonCapability(profile, new AbortController().signal)).resolves.toBe(
      "unsupported",
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestBody(fetch, 1)).not.toHaveProperty("response_format");
    expect(requestBody(fetch, 1)).not.toHaveProperty("max_tokens");
    expect(persistJsonSchemaSupport).toHaveBeenCalledWith("profile-1", "unsupported");
  });

  it("treats a DeepSeek-style serde rejection of response_format as a capability downgrade", async () => {
    // DeepSeek rejects json_schema with a Rust serde message that never says
    // "not supported": Failed to deserialize the JSON body into the target
    // type: response_format: unknown variant `json_schema`, expected `text`
    // or `json_object`.
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response(
          '{"error":{"message":"Failed to deserialize the JSON body into the target type: ' +
            "response_format: unknown variant `json_schema`, expected `text` or `json_object` " +
            'at line 1 column 123","type":"invalid_request_error"}}',
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(completion('{"ok":true}'));
    const persistJsonSchemaSupport = vi.fn().mockResolvedValue(undefined);
    const adapter = new OpenAiCompatibleAdapter({ fetch, persistJsonSchemaSupport });

    await expect(adapter.probeJsonCapability(profile, new AbortController().signal)).resolves.toBe(
      "unsupported",
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestBody(fetch, 1)).not.toHaveProperty("response_format");
    expect(persistJsonSchemaSupport).toHaveBeenCalledWith("profile-1", "unsupported");
  });

  it("maps a DeepSeek-style 400 Model Not Exist to MODEL_NOT_FOUND", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response('{"error":{"message":"Model Not Exist","type":"invalid_request_error"}}', {
        status: 400,
      }),
    );
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await expect(
      adapter.completeJson(profile, messages, schema, new AbortController().signal),
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });

  it("keeps an unrecognized 400 as a non-retryable NETWORK_ERROR carrying the status", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        response('{"error":{"message":"messages: field required"}}', { status: 400 }),
      );
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await expect(
      adapter.completeJson(
        { ...profile, jsonSchemaSupport: "unsupported" },
        messages,
        schema,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: false,
      details: { status: 400 },
    });
  });

  it("invokes the default global fetch with the correct receiver", async () => {
    const call = new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
    const globalFetch = vi.fn<typeof globalThis.fetch>(function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(call);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(globalFetch);
    const adapter = new OpenAiCompatibleAdapter();

    await expect(
      adapter.completeJson(profile, messages, schema, new AbortController().signal),
    ).resolves.toEqual({ ok: true });
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it("rejects a probe response that does not follow the minimal JSON instruction", async () => {
    const persistJsonSchemaSupport = vi.fn().mockResolvedValue(undefined);
    const adapter = new OpenAiCompatibleAdapter({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion('{"ok":false}')),
      persistJsonSchemaSupport,
    });

    await expect(
      adapter.probeJsonCapability(profile, new AbortController().signal),
    ).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(persistJsonSchemaSupport).not.toHaveBeenCalledWith("profile-1", "supported");
  });

  it.each(["unknown", "supported"] as const)(
    "sends a deterministic JSON-schema request for a %s profile",
    async (jsonSchemaSupport) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion('{"ok":true}'));
      const adapter = new OpenAiCompatibleAdapter({ fetch });

      await expect(
        adapter.completeJson(
          { ...profile, jsonSchemaSupport },
          messages,
          schema,
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: true });

      expect(fetch.mock.calls[0]![0]).toBe("https://model.example/v1/chat/completions");
      const request = fetch.mock.calls[0]![1]!;
      expect(request.method).toBe("POST");
      const headers = new Headers(request.headers);
      expect(headers.get("Authorization")).toBe("Bearer secret");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("X-Tenant")).toBe("learning");
      expect(requestBody(fetch, 0)).toEqual({
        model: "syntax-model",
        messages,
        temperature: 0,
        stream: false,
        // 默认关思考:思考模型解析单句要 153 秒/14789 tok，靠用户勾选不可靠。
        reasoning_effort: "none",
        response_format: {
          type: "json_schema",
          json_schema: { name: "core_analysis", strict: true, schema: schema.schema },
        },
      });
    },
  );

  it("immediately retries a rejected response_format and persists the capability downgrade", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response("response_format is not supported", { status: 400 }))
      .mockResolvedValueOnce(completion('{"ok":true}'));
    const persistJsonSchemaSupport = vi.fn().mockResolvedValue(undefined);
    const adapter = new OpenAiCompatibleAdapter({ fetch, persistJsonSchemaSupport });

    await adapter.completeJson(profile, messages, schema, new AbortController().signal);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestBody(fetch, 1)).not.toHaveProperty("response_format");
    expect(persistJsonSchemaSupport).toHaveBeenCalledWith("profile-1", "unsupported");
  });

  it("keeps the required JSON content type when a custom header uses different casing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion('{"ok":true}'));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await adapter.completeJson(
      { ...profile, headers: { "content-type": "text/plain" } },
      messages,
      schema,
      new AbortController().signal,
    );

    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it.each([
    [401, "AUTH_FAILED", false, {}],
    [429, "RATE_LIMITED", true, { retryAfterMs: 3_000 }],
    [503, "NETWORK_ERROR", true, { status: 503 }],
  ])("maps HTTP %i to %s", async (status, code, retryable, details) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response("remote failure", {
        status,
        headers: status === 429 ? { "Retry-After": "3" } : undefined,
      }),
    );
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    const rejection = adapter.completeJson(profile, messages, schema, new AbortController().signal);
    await expect(rejection).rejects.toMatchObject({ code, retryable, details });
  });

  it("maps an internal timeout abort separately from caller cancellation", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });
    const adapter = new OpenAiCompatibleAdapter({ fetch });
    const result = adapter.completeJson(profile, messages, schema, new AbortController().signal);
    const assertion = expect(result).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(profile.timeoutMs);
    await assertion;
    vi.useRealTimers();
  });

  it("keeps caller cancellation when fetch rejects only after the later timeout callback", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (reason: Error) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const adapter = new OpenAiCompatibleAdapter({ fetch });
    const caller = new AbortController();
    const result = adapter.completeJson(profile, messages, schema, caller.signal);
    const assertion = expect(result).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
      retryable: false,
    });

    caller.abort();
    await vi.advanceTimersByTimeAsync(profile.timeoutMs);
    rejectFetch(new DOMException("Aborted", "AbortError"));

    await assertion;
    vi.useRealTimers();
  });

  it("keeps timeout when caller cancellation happens after timeout wins", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (reason: Error) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const adapter = new OpenAiCompatibleAdapter({ fetch });
    const caller = new AbortController();
    const result = adapter.completeJson(profile, messages, schema, caller.signal);
    const assertion = expect(result).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(profile.timeoutMs);
    caller.abort();
    rejectFetch(new DOMException("Aborted", "AbortError"));

    await assertion;
    vi.useRealTimers();
  });

  it.each([
    ["malformed envelope", {}, "INVALID_MODEL_OUTPUT"],
    ["missing content", { choices: [{ message: {} }] }, "INVALID_MODEL_OUTPUT"],
  ])("rejects a %s", async (_description, envelope, code) => {
    const adapter = new OpenAiCompatibleAdapter({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(envelope)),
    });
    await expect(
      adapter.completeJson(profile, messages, schema, new AbortController().signal),
    ).rejects.toMatchObject({ code });
  });

  it("salvages a truncated non-streaming content instead of failing the whole batch", async () => {
    const truncated =
      '{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"学习者"}]}]';
    const adapter = new OpenAiCompatibleAdapter({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion(truncated)),
    });

    await expect(
      adapter.completeJson(profile, messages, schema, new AbortController().signal),
    ).resolves.toEqual({
      sentences: [
        {
          sentenceId: "s1",
          components: [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "学习者" }],
        },
      ],
    });
  });

  it("still rejects content with no complete value at all", async () => {
    const adapter = new OpenAiCompatibleAdapter({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion('{"sentences":[{"sen')),
    });

    await expect(
      adapter.completeJson(profile, messages, schema, new AbortController().signal),
    ).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });

  it("strips one outer JSON fence but never extracts JSON from prose", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(completion('```json\n{"ok":true}\n```'))
      .mockResolvedValueOnce(completion('Here is the result: {"ok":true}'));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await expect(
      adapter.completeJson(profile, messages, schema, new AbortController().signal),
    ).resolves.toEqual({ ok: true });
    await expect(
      adapter.completeJson(profile, messages, schema, new AbortController().signal),
    ).rejects.toBeInstanceOf(ModelRequestError);
  });
});

describe("syntax prompts", () => {
  const sentence = {
    sentenceId: "s-1",
    text: "Readers learn.",
    tokens: [
      { id: 0, text: "Readers", start: 0, end: 7, leadingWhitespace: "", punctuation: false },
      { id: 1, text: "learn", start: 8, end: 13, leadingWhitespace: " ", punctuation: false },
      { id: 2, text: ".", start: 13, end: 14, leadingWhitespace: "", punctuation: true },
    ],
  };

  it("states all core structural invariants", () => {
    const prompt = buildCorePrompt([sentence]);
    expect(prompt).toContain("SUBJECT");
    expect(prompt).toContain("INDEPENDENT_ELEMENT");
    expect(prompt).toContain("16");
    expect(prompt).toMatch(/closed.*Token/i);
    expect(prompt).toMatch(/exactly once/i);
    expect(prompt).toMatch(/Chinese/i);
    expect(prompt).toMatch(/JSON only/i);
  });

  it("states the compound-sentence peer-component and conjunction rules", () => {
    const prompt = buildCorePrompt([sentence]);
    expect(prompt).toContain("Never emit COORDINATE_CLAUSE");
    expect(prompt).toContain("CONJUNCTION");
    expect(prompt).toMatch(/coordinating conjunction/i);
    // The conjunction list is the closed FANBOYS set, with no open-ended
    // ellipsis a model could stretch to subordinators like "because".
    expect(prompt).toContain("(for, and, nor, but, or, yet, so)");
    expect(prompt).not.toContain("...");
    expect(prompt).toContain("analyse the inside of every clause as peer components");
    expect(prompt).toMatch(/subordinate clause.*one whole component/is);
    expect(prompt).toContain("single subject-predicate structure as peer components");
  });

  it("spells out the exact output envelope so schema-free models cannot guess", () => {
    // Compatibility mode sends no response_format, so the JSON shape must be
    // stated in the prompt itself; a real model returned a top-level array
    // and punctuation-only components without it.
    const core = buildCorePrompt([sentence]);
    expect(core).toContain('{"sentences":');
    expect(core).toContain('"components":');
    expect(core).toMatch(/not.*top-level.*array|never.*top-level.*array/i);
    expect(core).toMatch(/never.*only punctuation|must not.*only punctuation/i);

    const repair = buildRepairPrompt([sentence], [], {});
    expect(repair).toContain('{"sentences":');

    const verifiedCore = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: "s-1",
      components: [],
      modelProfileId: "profile-1",
    };
    const detail = buildDetailPrompt(sentence, verifiedCore, { startToken: 0, endToken: 1 });
    expect(detail).toContain('"structures":');
    expect(detail).toContain('"grammarPoints":');
    expect(detail).toContain('"explanation":');
  });

  it("keeps immutable sentence identity and tokens in repair instructions", () => {
    const prompt = buildRepairPrompt([sentence], [{ path: "sentences[0]", message: "gap" }], {
      broken: true,
    });
    expect(prompt).toContain("gap");
    expect(prompt).toContain('"broken":true');
    expect(prompt).toMatch(/do not change.*sentence IDs.*Tokens/is);
  });

  it("limits detail context to the selected sentence, verified core, and focus", () => {
    const core = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: "s-1",
      components: [],
      modelProfileId: "profile-1",
    };
    const prompt = buildDetailPrompt(sentence, core, { startToken: 0, endToken: 0 });
    expect(prompt).toContain('"sentenceId":"s-1"');
    expect(prompt).toContain('"modelProfileId":"profile-1"');
    expect(prompt).toContain('"startToken":0');
  });

  it("requires Chinese role names and internal breakdown in detail structures", () => {
    const core = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: "s-1",
      components: [],
      modelProfileId: "profile-1",
    };
    const prompt = buildDetailPrompt(sentence, core, { startToken: 0, endToken: 1 });
    expect(prompt).toMatch(/role.*Chinese/i);
    expect(prompt).toMatch(/主语|谓语|宾语/);
    expect(prompt).toMatch(/never.*English enum/i);
    expect(prompt).toMatch(/never return a single structure that covers the entire focus/i);
    expect(prompt).toMatch(/split.*sub-components/i);
    // 标注区第三行译文：每个 structure 必须带自身英文片段的简短中文译文。
    expect(prompt).toContain('"translation": string');
    expect(prompt).toMatch(/concise Chinese translation of exactly its own English text/i);
  });
});

const streamEnvelope = JSON.stringify({
  sentences: [
    {
      sentenceId: "s1",
      components: [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "\u4e3b\u8bed" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "\u8c13\u8bed" },
      ],
    },
    {
      sentenceId: "s2",
      components: [{ startToken: 0, endToken: 2, role: "OBJECT", translation: "\u5bbe\u8bed" }],
    },
  ],
});

function deltaEvent(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** Splits the envelope into n pieces so the parser has to survive chunk seams. */
function envelopeEvents(text: string, pieces = 5): string[] {
  const size = Math.ceil(text.length / pieces);
  const events: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    events.push(deltaEvent(text.slice(index, index + size)));
  }
  return [...events, "data: [DONE]\n\n"];
}

function sseResponse(events: readonly string[], gapMs = 0): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("streaming core completions", () => {
  it("reports components while the response streams and returns the finished envelope", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(sseResponse(envelopeEvents(streamEnvelope)));
    const adapter = new OpenAiCompatibleAdapter({ fetch });
    const seen: Array<[string, unknown]> = [];

    const result = await adapter.completeJsonStreaming(
      profile,
      messages,
      schema,
      new AbortController().signal,
      ({ sentenceId, component }) => seen.push([sentenceId, component.role]),
    );

    expect(seen).toEqual([
      ["s1", "SUBJECT"],
      ["s1", "PREDICATE"],
      ["s2", "OBJECT"],
    ]);
    expect(result).toEqual(JSON.parse(streamEnvelope));
    expect(requestBody(fetch, 0)).toMatchObject({ stream: true });
  });

  it("falls back to one non-streaming request when the endpoint rejects stream", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response("stream is not supported by this model", { status: 400 }))
      .mockResolvedValueOnce(completion(streamEnvelope));
    const persistStreamSupport = vi.fn().mockResolvedValue(undefined);
    const adapter = new OpenAiCompatibleAdapter({ fetch, persistStreamSupport });

    const result = await adapter.completeJsonStreaming(
      profile,
      messages,
      schema,
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toEqual(JSON.parse(streamEnvelope));
    expect(persistStreamSupport).toHaveBeenCalledWith(profile.id, "unsupported");
    expect(requestBody(fetch, 1)).toMatchObject({ stream: false });
  });

  it("does not attempt streaming for a profile already marked unsupported", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion(streamEnvelope));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await adapter.completeJsonStreaming(
      { ...profile, streamSupport: "unsupported" },
      messages,
      schema,
      new AbortController().signal,
      () => undefined,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestBody(fetch, 0)).toMatchObject({ stream: false });
  });

  it("treats a stream that never produced content as unsupported and retries without it", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        sseResponse(['data: {"choices":[{"delta":{}}]}\n\n', "data: [DONE]\n\n"]),
      )
      .mockResolvedValueOnce(completion(streamEnvelope));
    const persistStreamSupport = vi.fn().mockResolvedValue(undefined);
    const adapter = new OpenAiCompatibleAdapter({ fetch, persistStreamSupport });

    const result = await adapter.completeJsonStreaming(
      profile,
      messages,
      schema,
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toEqual(JSON.parse(streamEnvelope));
    expect(persistStreamSupport).toHaveBeenCalledWith(profile.id, "unsupported");
  });

  it("keeps the schema downgrade working while streaming", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response("response_format: unknown variant `json_schema`", { status: 400 }),
      )
      .mockResolvedValueOnce(sseResponse(envelopeEvents(streamEnvelope)));
    const persistJsonSchemaSupport = vi.fn().mockResolvedValue(undefined);
    const adapter = new OpenAiCompatibleAdapter({ fetch, persistJsonSchemaSupport });

    const result = await adapter.completeJsonStreaming(
      profile,
      messages,
      schema,
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toEqual(JSON.parse(streamEnvelope));
    expect(persistJsonSchemaSupport).toHaveBeenCalledWith(profile.id, "unsupported");
    // 降级后仍然是流式请求，不该连流式一起放弃。
    expect(requestBody(fetch, 1)).toMatchObject({ stream: true });
    expect(requestBody(fetch, 1)).not.toHaveProperty("response_format");
  });

  it("measures the timeout against stream inactivity, not total duration", async () => {
    const events = envelopeEvents(streamEnvelope, 4);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sseResponse(events, 40));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    // 5 个事件 × 40ms 间隔 ≈ 200ms 总时长，远超 120ms 的超时值；只要每片都刷新
    // 计时器就不该超时。
    const result = await adapter.completeJsonStreaming(
      { ...profile, timeoutMs: 120 },
      messages,
      schema,
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toEqual(JSON.parse(streamEnvelope));
  });

  it("salvages a stream that stopped mid-sentence instead of failing the whole chunk", async () => {
    // 本机模型每次都少最后一个 `}`；撞上 max_tokens 会断在半句上。此前这里整块判死。
    const truncated = `${streamEnvelope.slice(0, streamEnvelope.lastIndexOf("]}"))}`;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(sseResponse(envelopeEvents(truncated)));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    const result = (await adapter.completeJsonStreaming(
      profile,
      messages,
      schema,
      new AbortController().signal,
      () => undefined,
    )) as { sentences: { sentenceId: string }[] };

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.sentences.map(({ sentenceId }) => sentenceId)).toEqual(["s1", "s2"]);
  });

  it("times out a stream that stalls longer than the profile timeout", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(sseResponse([deltaEvent('{"sentences":['), deltaEvent("]}")], 200));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await expect(
      adapter.completeJsonStreaming(
        { ...profile, timeoutMs: 60 },
        messages,
        schema,
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });
});

describe("disabling model reasoning", () => {
  const thinking = { ...profile, disableReasoning: true as const };

  it("asks a thinking model to skip reasoning on a buffered request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion('{"ok":1}'));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await adapter.completeJson(thinking, messages, schema, new AbortController().signal);

    expect(requestBody(fetch, 0)).toMatchObject({ reasoning_effort: "none" });
  });

  it("carries the same instruction on a streamed request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(sseResponse(envelopeEvents(streamEnvelope)));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await adapter.completeJsonStreaming(
      thinking,
      messages,
      schema,
      new AbortController().signal,
      () => undefined,
    );

    expect(requestBody(fetch, 0)).toMatchObject({ stream: true, reasoning_effort: "none" });
  });

  // OpenAI 官方 API 不接受 "none"，所以这个字段绝不能默认出现。
});

/**
 * 思考模型为一句话生成上万 token 推理:实测 deepseek-v4-flash 解析单句
 * 默认 153 秒 / 14789 tok，带 reasoning_effort:"none" 后 1.41 秒 / 135 tok。
 * DeepSeek 现存的两个模型都是思考模型，靠用户自己去选项页勾选并不可靠，
 * 所以改成默认下发 + 被拒降级（与 streamSupport 同款套路）。
 */
describe("默认关闭模型思考", () => {
  it("默认就下发 reasoning_effort:none，无需用户勾选", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion('{"ok":1}'));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await adapter.completeJson(profile, messages, schema, new AbortController().signal);

    expect(requestBody(fetch, 0)).toMatchObject({ reasoning_effort: "none" });
  });

  it("端点已知不接受时不再下发", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(completion('{"ok":1}'));
    const adapter = new OpenAiCompatibleAdapter({ fetch });
    const known = { ...profile, reasoningControl: "unsupported" as const };

    await adapter.completeJson(known, messages, schema, new AbortController().signal);

    expect(requestBody(fetch, 0)).not.toHaveProperty("reasoning_effort");
  });

  it("被 4xx 拒绝后去掉该字段重发一次", async () => {
    const rejection = new Response(
      JSON.stringify({ error: { message: "Invalid value for 'reasoning_effort': none" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(rejection)
      .mockResolvedValueOnce(completion('{"ok":1}'));
    const adapter = new OpenAiCompatibleAdapter({ fetch });

    await adapter.completeJson(profile, messages, schema, new AbortController().signal);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestBody(fetch, 0)).toHaveProperty("reasoning_effort");
    expect(requestBody(fetch, 1)).not.toHaveProperty("reasoning_effort");
  });
});
