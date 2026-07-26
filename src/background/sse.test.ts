import { describe, expect, it } from "vitest";
import { SSE_DONE, SseDecoder } from "./sse";

describe("SseDecoder", () => {
  it("returns the payload of a complete event", () => {
    const decoder = new SseDecoder();

    expect(decoder.push('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it("holds an event back until its terminating blank line arrives", () => {
    const decoder = new SseDecoder();

    expect(decoder.push('data: {"a":')).toEqual([]);
    expect(decoder.push("1}")).toEqual([]);
    expect(decoder.push("\n\n")).toEqual(['{"a":1}']);
  });

  it("joins multiple data lines of one event with newlines", () => {
    const decoder = new SseDecoder();

    expect(decoder.push("data: first\ndata: second\n\n")).toEqual(["first\nsecond"]);
  });

  it("accepts CRLF line endings", () => {
    const decoder = new SseDecoder();

    expect(decoder.push("data: value\r\n\r\n")).toEqual(["value"]);
  });

  it("ignores comments and non-data fields", () => {
    const decoder = new SseDecoder();

    expect(decoder.push(": keep-alive\nevent: message\nid: 7\ndata: value\n\n")).toEqual(["value"]);
  });

  it("keeps a data payload that itself contains a colon and leading spaces", () => {
    const decoder = new SseDecoder();

    expect(decoder.push('data: {"url":"https://x"}\n\n')).toEqual(['{"url":"https://x"}']);
  });

  it("surfaces the terminator so the caller can stop reading", () => {
    const decoder = new SseDecoder();

    expect(decoder.push(`data: ${SSE_DONE}\n\n`)).toEqual([SSE_DONE]);
  });

  it("returns several events that arrive in one chunk in order", () => {
    const decoder = new SseDecoder();

    expect(decoder.push("data: one\n\ndata: two\n\ndata: three\n\n")).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("drops an event that carries no data field", () => {
    const decoder = new SseDecoder();

    expect(decoder.push("event: ping\n\ndata: real\n\n")).toEqual(["real"]);
  });
});
