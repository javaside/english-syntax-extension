import { describe, expect, it } from "vitest";
import {
  chatCompletionsUrl,
  hostPermissionPattern,
  isLoopbackBaseUrl,
  normalizeBaseUrl,
} from "./base-url";

describe("model profile URL safety", () => {
  it("normalizes a trailing slash from an HTTPS base URL", () => {
    expect(normalizeBaseUrl("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/v1");
  });

  it("appends the chat completions endpoint", () => {
    expect(chatCompletionsUrl("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("does not append a duplicate chat completions endpoint", () => {
    expect(chatCompletionsUrl("http://localhost:11434/v1/chat/completions")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
  });

  it.each(["http://localhost:11434/v1", "http://127.0.0.1:11434/v1"])(
    "allows a local HTTP model endpoint at %s",
    (baseUrl) => {
      expect(normalizeBaseUrl(baseUrl)).toBe(baseUrl);
    },
  );

  it("rejects remote HTTP model endpoints", () => {
    expect(() => normalizeBaseUrl("http://api.example.com/v1")).toThrow("HTTPS");
  });

  it("rejects embedded URL credentials", () => {
    expect(() => normalizeBaseUrl("https://user:pass@example.com/v1")).toThrow("credentials");
  });

  it.each([
    "https://api.example.com/v1?",
    "https://api.example.com/v1/chat/completions?",
    "https://api.example.com/v1?tenant=syntax",
    "https://api.example.com/v1/chat/completions?tenant=syntax",
  ])("rejects a query string in model URL %s", (baseUrl) => {
    expect(() => normalizeBaseUrl(baseUrl)).toThrow("query strings or fragments");
    expect(() => chatCompletionsUrl(baseUrl)).toThrow("query strings or fragments");
  });

  it.each([
    "https://api.example.com/v1#",
    "https://api.example.com/v1/chat/completions#",
    "https://api.example.com/v1#syntax",
    "https://api.example.com/v1/chat/completions#syntax",
  ])("rejects a fragment in model URL %s", (baseUrl) => {
    expect(() => normalizeBaseUrl(baseUrl)).toThrow("query strings or fragments");
    expect(() => chatCompletionsUrl(baseUrl)).toThrow("query strings or fragments");
  });

  it("derives an exact-origin host permission", () => {
    expect(hostPermissionPattern("https://api.deepseek.com:8443/v1")).toBe(
      "https://api.deepseek.com:8443/*",
    );
  });
});

/**
 * 本地与云端的合批取舍相反:本地模型串行处理请求,合并成一条大请求才快
 * (CHANGELOG 1.0.4 记录的收益);云端 API 并发好,而耗时几乎只由输出 token 决定,
 * 拆小批并行才快。所以要能区分二者。
 */
describe("isLoopbackBaseUrl", () => {
  it.each([
    ["http://localhost:11434/v1", true],
    ["http://127.0.0.1:1234/v1", true],
    ["https://api.deepseek.com", false],
    ["https://api.openai.com/v1", false],
  ])("%s → %s", (baseUrl, expected) => {
    expect(isLoopbackBaseUrl(baseUrl)).toBe(expected);
  });

  it("对畸形 URL 返回 false 而不是抛错——判定失败该退回云端策略", () => {
    expect(isLoopbackBaseUrl("not a url")).toBe(false);
  });
});
