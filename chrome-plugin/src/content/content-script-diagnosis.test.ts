// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { GrammarRole } from "../shared/grammar";
import type {
  BlockDiagnosis,
  ChatStreamPush,
  CoreStreamPush,
  DetailStreamPush,
  RequestMessage,
  ResponseMessage,
} from "../shared/protocol";
import { CORE_SCHEMA_VERSION } from "../shared/versions";
import { recordDiagnosisTarget } from "./block-diagnosis";
import { ChromeRuntimeTransport, ContentScriptRouter, isRuntimeResponse } from "./content-script";
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

describe("isRuntimeResponse CORE_RESULT case", () => {
  const base = {
    version: 1,
    requestId: "r1",
    type: "CORE_RESULT",
    analyses: [],
  } as const;

  it("携带合法逐句 failures 的 CORE_RESULT 通过守卫", () => {
    expect(
      isRuntimeResponse(
        {
          ...base,
          failures: [
            {
              sentenceId: "sentence-2",
              error: {
                code: "INVALID_MODEL_OUTPUT",
                message: "模型输出经两轮修复后仍不合格：at most one FRAGMENT_HEAD",
                retryable: false,
              },
            },
          ],
        },
        "r1",
      ),
    ).toBe(true);
    expect(isRuntimeResponse({ ...base }, "r1")).toBe(true);
  });

  it("failures 形状非法被拒（三层校验的 content 层一环）", () => {
    expect(
      isRuntimeResponse(
        {
          ...base,
          failures: [{ sentenceId: "sentence-2", error: { code: "INVALID_MODEL_OUTPUT" } }],
        },
        "r1",
      ),
    ).toBe(false);
    expect(isRuntimeResponse({ ...base, failures: [{ broken: true }] }, "r1")).toBe(false);
    expect(isRuntimeResponse({ ...base, failures: "not-an-array" }, "r1")).toBe(false);
  });
});

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

/** 追问对话消息守卫用的最小句料（与 protocol.test.ts 的 sentence/core 同构）。 */
const chatSentence = {
  sentenceId: "sentence-1",
  text: "Learners read.",
  tokens: [
    { id: 0, text: "Learners", start: 0, end: 8, leadingWhitespace: "", punctuation: false },
    { id: 1, text: "read", start: 9, end: 13, leadingWhitespace: " ", punctuation: false },
    { id: 2, text: ".", start: 13, end: 14, leadingWhitespace: "", punctuation: true },
  ],
};

const chatCore = {
  schemaVersion: CORE_SCHEMA_VERSION,
  sentenceId: "sentence-1",
  components: [
    { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" },
    { startToken: 1, endToken: 2, role: GrammarRole.PREDICATE, translation: "阅读" },
  ],
  modelProfileId: "profile-1",
};

describe("isRuntimeResponse CHAT_RESULT case", () => {
  const base = {
    version: 1,
    requestId: "r1",
    type: "CHAT_RESULT",
    conversationId: "document-1:chat:1",
    answer: "这句的主语是 Learners，谓语是 read。",
  };

  it("合法 CHAT_RESULT 通过守卫（case 缺了它必红——三层校验的 content 层一环）", () => {
    expect(isRuntimeResponse(base, "r1")).toBe(true);
  });

  it("answer 非串或 conversationId 缺失被拒", () => {
    expect(isRuntimeResponse({ ...base, answer: 42 }, "r1")).toBe(false);
    expect(
      isRuntimeResponse(
        { version: 1, requestId: "r1", type: "CHAT_RESULT", answer: "缺会话 id 的回答" },
        "r1",
      ),
    ).toBe(false);
    expect(isRuntimeResponse({ ...base, conversationId: "" }, "r1")).toBe(false);
  });
});

describe("chat 入站拒绝与端口分发", () => {
  it("伪造 CHAT_ASK 入站被拒成 MALFORMED_MESSAGE（这条只有 content 自己会发）", async () => {
    const router = new ContentScriptRouter({});
    const response = await router.route({
      ...pageCommandBase,
      type: "CHAT_ASK",
      conversationId: "document-1:chat:1",
      context: { kind: "sentence", sentence: chatSentence, core: chatCore },
      history: [{ role: "user", content: "为什么这么译？" }],
      question: "这句为什么这么译？",
    });
    expect(response).toMatchObject({
      type: "ERROR",
      requestId: "diagnose-1",
      error: { code: "MALFORMED_MESSAGE" },
    });
  });

  it("CHAT_STREAM 端口推送经守卫分发给 onStream 订阅者（异文档与畸形推送丢弃）", () => {
    const listeners: Array<(message: unknown) => void> = [];
    const port = {
      disconnect: () => undefined,
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          listeners.push(listener);
        },
      },
      onDisconnect: { addListener: () => undefined },
    };
    const transport = new ChromeRuntimeTransport(3, "document-1", {
      connect: () => port,
      sendMessage: () => Promise.resolve({}),
    });
    const pushes: unknown[] = [];
    // onStream 的注册签名已与分发集合同宽（三类推送的联合，窄签名已删除）；chat 推送据此直达订阅者
    transport.onStream((push: CoreStreamPush | DetailStreamPush | ChatStreamPush) => {
      pushes.push(push);
    });

    listeners[0]!({
      version: 1,
      type: "CHAT_STREAM",
      documentId: "document-1",
      conversationId: "document-1:chat:1",
      text: "截至目前的完整回答",
    });
    // 别的 documentId 的推送与畸形推送都必须丢弃
    listeners[0]!({
      version: 1,
      type: "CHAT_STREAM",
      documentId: "document-2",
      conversationId: "document-2:chat:1",
      text: "别的文档的推送",
    });
    listeners[0]!({ version: 1, type: "CHAT_STREAM", documentId: "document-1" });

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      type: "CHAT_STREAM",
      documentId: "document-1",
      conversationId: "document-1:chat:1",
      text: "截至目前的完整回答",
    });

    transport.dispose();
  });
});
