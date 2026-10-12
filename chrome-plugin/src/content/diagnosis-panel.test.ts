// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockDiagnosis } from "../shared/protocol";
import { DiagnosisPanel } from "./diagnosis-panel";

const strip = (text: string | null | undefined) => (text ?? "").replace(/\s+/gu, " ").trim();

/**
 * happy-dom 的 navigator.clipboard 是原型上的 getter-only 访问器,Object.assign 覆盖会抛
 * "which has only a getter";defineProperty(configurable) 是唯一可行的安装方式,且可重复覆盖。
 * 生产代码仍走真实的 navigator.clipboard.writeText,测试意图不变。
 */
const mockClipboard = (writeText: (text: string) => Promise<void>): void => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
};

/** Task 3 protocol.test.ts 的 baseDiagnosis 内联。 */
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

describe("DiagnosisPanel", () => {
  let panel: DiagnosisPanel;
  beforeEach(() => {
    panel = new DiagnosisPanel();
  });
  afterEach(() => {
    panel.close();
    document.documentElement.innerHTML = "";
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("show 渲染本地证据并挂载到 documentElement", () => {
    panel.show(sampleDiagnosis());
    expect(panel.host.isConnected).toBe(true);
    const text = strip(panel.host.shadowRoot!.textContent);
    expect(text).toContain("本地判定证据");
    expect(text).toContain("english-dominant");
    expect(text).toContain("模型解释生成中"); // show 后默认等待模型
  });

  it("updateModel 渲染解释；过期 requestId 被忽略", () => {
    panel.show(sampleDiagnosis());
    panel.trackRequest("req-2");
    panel.updateModel({
      requestId: "req-1",
      model: { likelyCause: "stale", explanation: "旧", suggestions: [] },
    });
    expect(strip(panel.host.shadowRoot!.textContent)).not.toContain("stale");
    panel.updateModel({
      requestId: "req-2",
      modelError: { code: "CONFIG_MISSING", message: "尚未配置", retryable: false },
    });
    expect(strip(panel.host.shadowRoot!.textContent)).toContain("CONFIG_MISSING");
  });

  it("show 后、track 前的陈旧响应不得被接受（parked fix：show 重置连 requestId 一起作废）", () => {
    panel.show(sampleDiagnosis());
    panel.trackRequest("req-1");
    // 下一轮诊断：show 之后、trackRequest 之前，上一轮 requestId 的响应抵达
    panel.show(sampleDiagnosis());
    panel.updateModel({
      requestId: "req-1",
      model: { likelyCause: "stale-window", explanation: "旧", suggestions: [] },
    });
    expect(strip(panel.host.shadowRoot!.textContent)).not.toContain("stale-window");
    expect(strip(panel.host.shadowRoot!.textContent)).toContain("模型解释生成中");
    // 登记新请求后，新响应照常接受
    panel.trackRequest("req-2");
    panel.updateModel({
      requestId: "req-2",
      model: { likelyCause: "fresh", explanation: "新", suggestions: [] },
    });
    expect(strip(panel.host.shadowRoot!.textContent)).toContain("fresh");
  });

  it("report() 在模型返回后含解释与 profile 模型名", () => {
    panel.show(sampleDiagnosis());
    panel.trackRequest("req-1");
    panel.updateModel({
      requestId: "req-1",
      model: { likelyCause: "english ratio", explanation: "占比不足", suggestions: ["x"] },
      profile: { model: "deepseek-flash" },
    });
    const report = panel.report();
    expect(report).toContain("## 模型解释");
    expect(report).toContain("english ratio");
    expect(report).toContain("deepseek-flash");
  });

  it("复制按钮成功走剪贴板；失败降级 textarea", async () => {
    panel.show(sampleDiagnosis());
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    (panel.host.shadowRoot!.querySelector(".copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("## 概述");

    const fail = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
    mockClipboard(fail);
    (panel.host.shadowRoot!.querySelector(".copy") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const area = panel.host.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea");
      expect(area).not.toBeNull();
      expect(area!.value).toContain("## 概述");
    });
  });

  it("隐私提示两句都在面板上", () => {
    panel.show(sampleDiagnosis());
    const text = strip(panel.host.shadowRoot!.textContent);
    expect(text).toContain("粘贴到外部工具前请自查");
    expect(text).toContain("发送给你配置的模型服务");
  });

  it("close 移除 host", () => {
    panel.show(sampleDiagnosis());
    panel.close();
    expect(panel.host.isConnected).toBe(false);
  });
});
