import { describe, expect, it } from "vitest";
import { GrammarRole } from "./grammar";
import {
  isCoreStreamPush,
  isRequestMessage,
  isSessionComplete,
  type SessionStatus,
} from "./protocol";

const page = {
  version: 1,
  requestId: "request-1",
  tabId: 7,
  documentId: "document-1",
} as const;

const token = {
  id: 0,
  text: "Learners",
  start: 0,
  end: 8,
  leadingWhitespace: "",
  punctuation: false,
};

const sentence = {
  sentenceId: "sentence-1",
  text: "Learners read.",
  tokens: [token],
};

const core = {
  schemaVersion: 1,
  sentenceId: "sentence-1",
  components: [
    {
      startToken: 0,
      endToken: 0,
      role: GrammarRole.SUBJECT,
      translation: "学习者",
    },
  ],
  modelProfileId: "profile-1",
};

describe("request protocol guard", () => {
  it.each([
    ["START_SESSION", { ...page, type: "START_SESSION" }],
    ["PAUSE_SESSION", { ...page, type: "PAUSE_SESSION" }],
    ["STOP_SESSION", { ...page, type: "STOP_SESSION" }],
    ["GET_SESSION_STATUS", { ...page, type: "GET_SESSION_STATUS" }],
    ["REANALYZE_VISIBLE", { ...page, type: "REANALYZE_VISIBLE" }],
    ["ANALYZE_CORE", { ...page, type: "ANALYZE_CORE", sentences: [sentence] }],
    [
      "ANALYZE_DETAIL",
      {
        ...page,
        type: "ANALYZE_DETAIL",
        sentence,
        core,
        focus: { startToken: 0, endToken: 0 },
      },
    ],
    [
      "REANALYZE_WITH_FEEDBACK",
      {
        ...page,
        type: "REANALYZE_WITH_FEEDBACK",
        sentence,
        core,
        feedback: "Please explain the subject again.",
      },
    ],
    ["SWITCH_PROFILE", { ...page, type: "SWITCH_PROFILE", profileId: "profile-2" }],
    [
      "TEST_PROFILE",
      { version: 1, requestId: "request-1", type: "TEST_PROFILE", profileId: "profile-1" },
    ],
    ["GET_CACHE_STATS", { version: 1, requestId: "request-1", type: "GET_CACHE_STATS" }],
    ["CLEAR_CACHE", { version: 1, requestId: "request-1", type: "CLEAR_CACHE" }],
    ["PARSE_SELECTION", { ...page, type: "PARSE_SELECTION", selectionText: "Learners read." }],
    ["PARSE_CONTEXT_BLOCK", { ...page, type: "PARSE_CONTEXT_BLOCK" }],
    ["PARSE_HOVERED_BLOCK", { ...page, type: "PARSE_HOVERED_BLOCK" }],
  ])("accepts a valid %s request", (_type, request) => {
    expect(isRequestMessage(request)).toBe(true);
  });

  it("rejects an unversioned content message", () => {
    expect(isRequestMessage({ type: "ANALYZE_CORE" })).toBe(false);
  });

  it("requires page correlation identifiers for page requests", () => {
    expect(
      isRequestMessage({
        version: 1,
        requestId: "request-1",
        type: "GET_SESSION_STATUS",
        tabId: 7,
      }),
    ).toBe(false);
  });

  it("rejects unknown top-level properties as executable instructions", () => {
    expect(
      isRequestMessage({
        version: 1,
        requestId: "request-1",
        type: "GET_CACHE_STATS",
        command: "DELETE_ALL_DATA",
      }),
    ).toBe(false);
  });

  it("rejects surplus reanalysis instructions instead of executing arbitrary scope", () => {
    expect(isRequestMessage({ ...page, type: "REANALYZE_VISIBLE", scope: "whole-document" })).toBe(
      false,
    );
  });

  it("rejects a hovered-block request with surplus keys", () => {
    expect(isRequestMessage({ ...page, type: "PARSE_HOVERED_BLOCK", target: "body" })).toBe(false);
  });

  it("accepts ANALYZE_CORE with offscreen: true and rejects other values", () => {
    const validAnalyzeCore = { ...page, type: "ANALYZE_CORE", sentences: [sentence] };
    expect(isRequestMessage({ ...validAnalyzeCore, offscreen: true })).toBe(true);
    expect(isRequestMessage({ ...validAnalyzeCore, offscreen: false })).toBe(false);
    expect(isRequestMessage({ ...validAnalyzeCore, offscreen: "yes" })).toBe(false);
  });

  it("accepts ANALYZE_CORE with bypassCache: true and rejects other values", () => {
    const validAnalyzeCore = { ...page, type: "ANALYZE_CORE", sentences: [sentence] };
    expect(isRequestMessage({ ...validAnalyzeCore, bypassCache: true })).toBe(true);
    expect(isRequestMessage({ ...validAnalyzeCore, bypassCache: false })).toBe(false);
    expect(isRequestMessage({ ...validAnalyzeCore, bypassCache: "yes" })).toBe(false);
  });

  it.each([
    ["a null token", { ...sentence, tokens: [null] }],
    ["an arbitrary token", { ...sentence, tokens: [{ command: "RUN" }] }],
    ["a token with a surplus key", { ...sentence, tokens: [{ ...token, command: "RUN" }] }],
    ["a token with a negative ID", { ...sentence, tokens: [{ ...token, id: -1 }] }],
    ["a token with a fractional offset", { ...sentence, tokens: [{ ...token, start: 0.5 }] }],
    ["a token with a reversed range", { ...sentence, tokens: [{ ...token, start: 8, end: 0 }] }],
  ])("rejects ANALYZE_CORE containing %s", (_description, malformedSentence) => {
    expect(
      isRequestMessage({
        ...page,
        type: "ANALYZE_CORE",
        sentences: [malformedSentence],
      }),
    ).toBe(false);
  });

  it.each([
    ["an arbitrary core", { command: "RUN" }, { startToken: 0, endToken: 0 }],
    ["a core with a surplus key", { ...core, command: "RUN" }, { startToken: 0, endToken: 0 }],
    [
      "a component with a surplus key",
      { ...core, components: [{ ...core.components[0], command: "RUN" }] },
      { startToken: 0, endToken: 0 },
    ],
    [
      "an unknown grammar role",
      { ...core, components: [{ ...core.components[0], role: "COMMAND" }] },
      { startToken: 0, endToken: 0 },
    ],
    ["a reversed focus", core, { startToken: 2, endToken: 1 }],
    ["a negative focus", core, { startToken: -1, endToken: 1 }],
    ["a focus with a surplus key", core, { startToken: 0, endToken: 0, command: "RUN" }],
  ])("rejects ANALYZE_DETAIL containing %s", (_description, malformedCore, focus) => {
    expect(
      isRequestMessage({
        ...page,
        type: "ANALYZE_DETAIL",
        sentence,
        core: malformedCore,
        focus,
      }),
    ).toBe(false);
  });

  it.each([
    ["a non-array component collection", { ...core, components: null }],
    [
      "a component with a reversed range",
      { ...core, components: [{ ...core.components[0], startToken: 2, endToken: 1 }] },
    ],
    [
      "a non-string translation",
      { ...core, components: [{ ...core.components[0], translation: 42 }] },
    ],
    ["a whitespace-only sentence ID", { ...core, sentenceId: "   " }],
    ["a whitespace-only model profile ID", { ...core, modelProfileId: "\t" }],
  ])("rejects REANALYZE_WITH_FEEDBACK containing %s", (_description, malformedCore) => {
    expect(
      isRequestMessage({
        ...page,
        type: "REANALYZE_WITH_FEEDBACK",
        sentence,
        core: malformedCore,
        feedback: "Try again.",
      }),
    ).toBe(false);
  });

  it.each([
    ["requestId", { version: 1, requestId: "   ", type: "GET_CACHE_STATS" }],
    ["documentId", { ...page, documentId: "\n", type: "GET_SESSION_STATUS" }],
    [
      "sentenceId",
      { ...page, type: "ANALYZE_CORE", sentences: [{ ...sentence, sentenceId: " " }] },
    ],
    ["profileId", { ...page, type: "SWITCH_PROFILE", profileId: "\t" }],
  ])("rejects a whitespace-only %s", (_field, request) => {
    expect(isRequestMessage(request)).toBe(false);
  });
});

describe("session completion", () => {
  const status = (overrides: Partial<SessionStatus>): SessionStatus => ({
    state: "running",
    discovered: 0,
    queued: 0,
    ready: 0,
    failed: 0,
    ...overrides,
  });

  it.each([
    ["every sentence is ready", { discovered: 4, ready: 4 }],
    ["ready and failed cover the discovery", { discovered: 4, ready: 3, failed: 1 }],
    ["cache-only skips cover the remainder", { discovered: 3, ready: 2, skipped: 1 }],
    // 屏外句子尚未触发:当前无工作在跑，就该允许恢复网页。
    ["offscreen sentences have not been triggered yet", { discovered: 40, ready: 6 }],
  ])("is complete when %s", (_description, overrides) => {
    expect(isSessionComplete(status(overrides))).toBe(true);
  });

  it.each([
    ["sentences are still queued", { discovered: 4, queued: 1, ready: 3 }],
    // 「结果没覆盖全部 discovered」本身不再意味着未完成:屏外句子要滚动到可见
    // 才入队，长页面永远覆盖不满。真正的未完成由在飞工作表达。
    ["requests are still in flight", { discovered: 4, ready: 2, failed: 1, inFlight: 1 }],
    ["a skip still leaves work running", { discovered: 4, ready: 2, skipped: 1, inFlight: 1 }],
  ])("is incomplete when %s", (_description, overrides) => {
    expect(isSessionComplete(status(overrides))).toBe(false);
  });
});

describe("prefetch protocol", () => {
  it("accepts START_SESSION with and without the prefetchDetail flag", () => {
    const base = {
      ...page,
      type: "START_SESSION",
    };
    expect(isRequestMessage(base)).toBe(true);
    expect(isRequestMessage({ ...base, prefetchDetail: true })).toBe(true);
    expect(isRequestMessage({ ...base, prefetchDetail: false })).toBe(false);
  });

  it("accepts PREFETCH_SENTENCE_DETAILS with sentence and core only", () => {
    const message = {
      ...page,
      type: "PREFETCH_SENTENCE_DETAILS",
      sentence,
      core,
    };
    expect(isRequestMessage(message)).toBe(true);
    expect(isRequestMessage({ ...message, focus: { startToken: 0, endToken: 0 } })).toBe(false);
  });

  it("keeps isSessionComplete independent of detail counters", () => {
    const status = {
      state: "running",
      discovered: 2,
      queued: 0,
      ready: 2,
      failed: 0,
      detailTotal: 6,
      detailReady: 1,
      detailFailed: 0,
    } as const;
    expect(isSessionComplete(status)).toBe(true);
  });
});

describe("isCoreStreamPush", () => {
  const push = {
    version: 1,
    type: "CORE_STREAM",
    documentId: "document-1",
    sentenceId: "sentence-1",
    components: [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "主语" }],
  };

  it("accepts a well-formed provisional push", () => {
    expect(isCoreStreamPush(push)).toBe(true);
  });

  it("rejects a version it does not speak", () => {
    expect(isCoreStreamPush({ ...push, version: 2 })).toBe(false);
  });

  it("rejects a push without page correlation", () => {
    expect(isCoreStreamPush({ ...push, documentId: "" })).toBe(false);
    expect(isCoreStreamPush({ ...push, sentenceId: "" })).toBe(false);
  });

  it("rejects components the renderer could not draw", () => {
    expect(isCoreStreamPush({ ...push, components: [{ startToken: 1, endToken: 0 }] })).toBe(false);
    expect(
      isCoreStreamPush({
        ...push,
        components: [{ startToken: 0, endToken: 1, role: "NOPE", translation: "x" }],
      }),
    ).toBe(false);
  });

  it("accepts an empty component list", () => {
    expect(isCoreStreamPush({ ...push, components: [] })).toBe(true);
  });

  it("rejects anything that is not this message", () => {
    expect(isCoreStreamPush({ ...push, type: "CORE_RESULT" })).toBe(false);
    expect(isCoreStreamPush(null)).toBe(false);
  });
});

/**
 * discovered 含屏外尚未触发的句子(它们要滚动到可见才解析)。原判定要求所有
 * discovered 都达终态,于是长页面永远"未完成":主按钮一直停在「解析中…」,
 * 不会变成「恢复网页原文」。自动扫描覆盖率提高后，这个缺陷变得随处可见。
 *
 * 正确语义是「当前没有在飞的工作」——屏外还没轮到的不算阻塞。
 */
describe("isSessionComplete 与屏外未触发的句子", () => {
  const base = { state: "running" as const, discovered: 100, queued: 0, ready: 12, failed: 0 };

  it("屏内跑完即算完成，屏外未触发的不阻塞", () => {
    expect(isSessionComplete({ ...base, inFlight: 0 })).toBe(true);
  });

  it("仍有请求在飞时不算完成", () => {
    expect(isSessionComplete({ ...base, inFlight: 2 })).toBe(false);
  });

  it("还在排队时不算完成", () => {
    expect(isSessionComplete({ ...base, queued: 3, inFlight: 0 })).toBe(false);
  });

  it("会话刚启动的空状态不算完成——那时 queued 与 inFlight 也都是 0", () => {
    expect(
      isSessionComplete({ state: "running", discovered: 0, queued: 0, ready: 0, failed: 0 }),
    ).toBe(false);
  });
});
