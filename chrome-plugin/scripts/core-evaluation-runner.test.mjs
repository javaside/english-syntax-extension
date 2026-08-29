import { describe, expect, it, vi } from "vitest";

import {
  parseRunnerBaseUrl,
  predictionList,
  requestChatCompletion,
  sanitizeProviderError,
} from "./core-evaluation-runner.mjs";

function completion(content = '{"sentences":[]}') {
  return new globalThis.Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function rejection(status, body) {
  return new globalThis.Response(body, { status });
}

describe("parseRunnerBaseUrl", () => {
  it("accepts and normalizes the default HTTPS base URL", () => {
    expect(parseRunnerBaseUrl("https://api.deepseek.com/v1")).toEqual({
      requestBaseUrl: "https://api.deepseek.com/v1",
      safeBaseUrl: "https://api.deepseek.com/v1",
    });
  });

  it("uses the same trailing-slash normalization for requests and records", () => {
    expect(parseRunnerBaseUrl("http://localhost:11434/v1/")).toEqual({
      requestBaseUrl: "http://localhost:11434/v1",
      safeBaseUrl: "http://localhost:11434/v1",
    });
  });

  it.each([
    "https://user@api.example.com/v1",
    "https://user:password@api.example.com/v1",
    "https://api.example.com/v1?api_key=secret",
    "https://api.example.com/v1#secret",
  ])("rejects credentials, query strings, and fragments in %s", (baseUrl) => {
    expect(() => parseRunnerBaseUrl(baseUrl)).toThrow(
      "must not contain username, password, query, or fragment",
    );
  });

  it.each(["ftp://api.example.com/v1", "file:///tmp/provider", "mailto:model@example.com"])(
    "rejects non-HTTP(S) URL %s",
    (baseUrl) => {
      expect(() => parseRunnerBaseUrl(baseUrl)).toThrow("must use http or https");
    },
  );

  it("rejects a malformed credential-like URL without echoing its input", () => {
    const baseUrl = "https://user:secret@";

    let thrown;
    try {
      parseRunnerBaseUrl(baseUrl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe("Runner base URL is invalid");
    expect(thrown.message).not.toContain("user");
    expect(thrown.message).not.toContain("secret");
    expect(thrown.message).not.toContain(baseUrl);
  });
});

describe("predictionList", () => {
  it("accepts the production core prompt sentences envelope", () => {
    const sentences = [{ sentenceId: "s1", components: [] }];

    expect(predictionList({ sentences })).toBe(sentences);
  });
});

describe("requestChatCompletion", () => {
  it("removes reasoning_effort once after an explicit 400 rejection", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(rejection(400, "reasoning_effort is not supported"))
      .mockResolvedValueOnce(completion());

    await requestChatCompletion(
      {
        url: "https://provider.invalid/chat/completions",
        apiKey: "secret-key",
        timeoutMs: 1_000,
        body: { reasoning_effort: "none", response_format: { type: "json_object" } },
      },
      fetchImplementation,
    );

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImplementation.mock.calls[0][1].body)).toHaveProperty(
      "reasoning_effort",
    );
    expect(JSON.parse(fetchImplementation.mock.calls[1][1].body)).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  it("removes response_format once after an explicit 422 rejection", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(rejection(422, "response_format json_object is unsupported"))
      .mockResolvedValueOnce(completion());

    await requestChatCompletion(
      {
        url: "https://provider.invalid/chat/completions",
        apiKey: "secret-key",
        timeoutMs: 1_000,
        body: { reasoning_effort: "none", response_format: { type: "json_object" } },
      },
      fetchImplementation,
    );

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImplementation.mock.calls[1][1].body)).not.toHaveProperty(
      "response_format",
    );
  });

  it("applies each compatibility downgrade at most once", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(rejection(400, "reasoning_effort rejected"))
      .mockResolvedValueOnce(rejection(422, "response_format json_object rejected"))
      .mockResolvedValueOnce(completion());

    await requestChatCompletion(
      {
        url: "https://provider.invalid/chat/completions",
        apiKey: "secret-key",
        timeoutMs: 1_000,
        body: { reasoning_effort: "none", response_format: { type: "json_object" } },
      },
      fetchImplementation,
    );

    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchImplementation.mock.calls[2][1].body)).toEqual({});
  });
});

describe("sanitizeProviderError", () => {
  it("masks the configured key and authorization token forms while limiting output", () => {
    const apiKey = "actual-secret-key";
    const message = `failed ${apiKey}; Bearer bearer-secret; Authorization: token-secret; ${"x".repeat(1_000)}`;

    const sanitized = sanitizeProviderError(message, apiKey);

    expect(sanitized).not.toContain(apiKey);
    expect(sanitized).not.toContain("bearer-secret");
    expect(sanitized).not.toContain("token-secret");
    expect(sanitized).toContain("<masked>");
    expect(sanitized.length).toBeLessThanOrEqual(320);
  });
});
