// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { BlockDiagnosis, RequestMessage, ResponseMessage } from "../shared/protocol";
import { recordDiagnosisTarget } from "./block-diagnosis";
import { ContentScriptRouter, isRuntimeResponse } from "./content-script";
import type { RuntimeTransport } from "./session-controller";

/** Task 3 protocol.test.ts / Task 9 diagnosis-panel.test.ts 的 baseDiagnosis 内联。 */
const sampleDiagnosis = (): BlockDiagnosis => ({
  target: {
    tagName: "P",
    className: "content",
    id: "p1",
    selectorPath: "main > p#p1",
    outerHtml: '<p id="p1">',
  },
  targetSource: "contextmenu",
  inventory: {
    isUnit: true,
    kind: "paragraph",
    automatic: false,
    exclusionReason: "non-english",
  },
  explicit: { resolvable: false },
  gates: [{ gate: "english-dominant", ok: false, value: 0.2 }],
  text: { length: 40, letterWords: 8, englishRatio: 0.2, minAutoTextLength: 20 },
  segmentation: { sentenceCount: 1, sentenceLengths: [40], tokenCount: 9, emptyText: false },
  requestFeasibility: {
    maxSentenceLength: 40,
    sentenceLengthLimit: 2000,
    maxSentencesPerRequest: 6,
    cloudSentencesPerRequest: 2,
  },
  session: { state: "stopped", registered: false, sentences: [] },
  page: { url: "https://example.com/a", readyState: "complete" },
  capturedAt: "2026-10-11T00:00:00.000Z",
});

const validResult: ResponseMessage = {
  version: 1,
  requestId: "r1",
  type: "DIAGNOSIS_RESULT",
  diagnosis: sampleDiagnosis(),
  modelError: { code: "CONFIG_MISSING", message: "x", retryable: false },
};

const pageCommandBase = {
  version: 1,
  requestId: "diagnose-1",
  tabId: 3,
  documentId: "document-1",
} as const;

describe("isRuntimeResponse 诊断 case", () => {
  it("合法 DIAGNOSIS_RESULT 通过守卫（case 缺了它必红——防三层漏一层的断言形态）", () => {
    expect(isRuntimeResponse(validResult, "r1")).toBe(true);
    expect(
      isRuntimeResponse(
        {
          ...validResult,
          model: { likelyCause: "english ratio", explanation: "占比不足", suggestions: ["x"] },
        },
        "r1",
      ),
    ).toBe(true);
  });

  it("requestId 不匹配或载荷畸形被拒", () => {
    expect(isRuntimeResponse(validResult, "r2")).toBe(false);
    expect(isRuntimeResponse({ ...validResult, diagnosis: { broken: true } }, "r1")).toBe(false);
    expect(
      isRuntimeResponse(
        {
          ...validResult,
          model: { likelyCause: "x", explanation: "y", suggestions: "not-an-array" },
        },
        "r1",
      ),
    ).toBe(false);
  });
});

describe("ContentScriptRouter 诊断命令", () => {
  afterEach(() => {
    document.documentElement.innerHTML = "";
    document.body.innerHTML = "";
    recordDiagnosisTarget({ target: null } as unknown as Event);
  });

  it("DIAGNOSE_BLOCK 回 ack 且发出 EXPLAIN_DIAGNOSIS（经会话 transport，不另开通道）", async () => {
    const sent: RequestMessage[] = [];
    // 同一实例喂给 controller 与诊断编排：S5 要求诊断复用会话 transport，
    // 这里正是靠「sent 只可能来自这个实例」来钉住复用行为。
    const fakeTransportInstance: RuntimeTransport = {
      send: (message: RequestMessage) => {
        sent.push(message);
        return Promise.resolve({ ...validResult, requestId: message.requestId });
      },
      cancelDocument: () => undefined,
    };
    const router = new ContentScriptRouter({
      transportFactory: () => fakeTransportInstance,
    });
    document.body.innerHTML = '<p id="p">Hello target text here.</p>';
    // 先用 contextmenu 记录落点（capture 监听由 installContentScript 装配；单测里手动调）
    recordDiagnosisTarget({ target: document.getElementById("p") } as unknown as Event);

    const response = await router.route({ ...pageCommandBase, type: "DIAGNOSE_BLOCK" });
    expect(response).toMatchObject({ type: "ACK", acknowledgedType: "DIAGNOSE_BLOCK" });
    // runDiagnosis 同步执行到 transport.send（首个 await 前），route 返回时 sent 已就绪
    expect(sent.at(-1)?.type).toBe("EXPLAIN_DIAGNOSIS");
    expect(sent.at(-1)?.requestId).toContain(":diagnosis:");
    // 让编排链（await transport.send → panel.updateModel）在用例内收尾
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
  });

  it("EXPLAIN_DIAGNOSIS 误入站返回 invalidMessage", async () => {
    const router = new ContentScriptRouter({});
    const response = await router.route({
      ...pageCommandBase,
      type: "EXPLAIN_DIAGNOSIS",
      diagnosis: sampleDiagnosis(),
    });
    expect(response).toMatchObject({
      type: "ERROR",
      requestId: "diagnose-1",
      error: { code: "MALFORMED_MESSAGE" },
    });
  });
});
