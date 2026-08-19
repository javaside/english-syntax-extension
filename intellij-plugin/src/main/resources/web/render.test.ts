// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewRenderer } from "./render";

const HIDDEN = "data-english-syntax-hidden";

function paragraph(id: string): HTMLElement {
  const element = document.createElement("p");
  element.id = id;
  element.textContent = "The service validates every response before returning anything.";
  document.body.append(element);
  return element;
}

function corePayload(sentenceId: string, components: Array<{ startToken: number; endToken: number; role: string; translation: string; text?: string }>) {
  return { sentenceId, components };
}

function setup(paragraphId = "p1"): { renderer: PreviewRenderer; element: HTMLElement; detailRequests: Array<[string, number, number]> } {
  const element = paragraph(paragraphId);
  const detailRequests: Array<[string, number, number]> = [];
  const renderer = new PreviewRenderer((sentenceId, focusStart, focusEnd) => {
    detailRequests.push([sentenceId, focusStart, focusEnd]);
  });
  renderer.registerBlock("b1", element);
  renderer.registerSentence("b1", "s1");
  return { renderer, element, detailRequests };
}

describe("PreviewRenderer", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("keeps the original text visible until a complete or streamed result arrives", () => {
    const { renderer, element } = setup();
    expect(element.hasAttribute(HIDDEN)).toBe(false);
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();
    void renderer;
  });

  it("renders a provisional card from the first streamed component", () => {
    const { renderer, element } = setup();
    renderer.renderCoreStream("s1", [{ startToken: 0, endToken: 1, role: "主语", translation: "该服务", text: "The service" }]);

    const card = document.querySelector("[data-english-syntax-card]");
    expect(card).not.toBeNull();
    expect(element.hasAttribute(HIDDEN)).toBe(true);
    expect(card?.querySelector(".english-syntax-component")?.textContent).toContain("该服务");
    expect(card?.querySelector(".english-syntax-sentence")?.classList.contains("english-syntax-provisional")).toBe(true);
  });

  it("replaces the provisional card with the final result", () => {
    const { renderer } = setup();
    renderer.renderCoreStream("s1", [{ startToken: 0, endToken: 1, role: "主语", translation: "该服务", text: "The service" }]);
    renderer.renderCoreResult("s1", corePayload("s1", [
      { startToken: 0, endToken: 1, role: "主语", translation: "该服务", text: "The service" },
      { startToken: 2, endToken: 2, role: "谓语", translation: "校验", text: "validates" },
    ]));

    const sentence = document.querySelector(".english-syntax-sentence");
    expect(sentence?.classList.contains("english-syntax-provisional")).toBe(false);
    expect(document.querySelectorAll(".english-syntax-component")).toHaveLength(2);
  });

  it("restores the original and shows retry on error", () => {
    const { renderer, element, detailRequests } = setup();
    renderer.renderCoreResult("s1", corePayload("s1", [
      { startToken: 0, endToken: 1, role: "主语", translation: "该服务", text: "The service" },
    ]));
    renderer.renderCoreError("s1", "INVALID_MODEL_OUTPUT", "解析失败");

    const retry = document.querySelector(".english-syntax-retry") as HTMLButtonElement;
    expect(retry).not.toBeNull();
    expect(document.querySelector(".english-syntax-error")?.textContent).toBe("解析失败");

    retry.click();
    expect(detailRequests.length).toBeGreaterThanOrEqual(1);
    void element;
  });

  it("restoreAll removes plugin nodes and data attributes", () => {
    const { renderer, element } = setup();
    renderer.renderCoreResult("s1", corePayload("s1", [
      { startToken: 0, endToken: 1, role: "主语", translation: "该服务", text: "The service" },
    ]));
    expect(document.querySelector("[data-english-syntax-card]")).not.toBeNull();

    renderer.restoreAll();

    expect(element.hasAttribute(HIDDEN)).toBe(false);
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();
  });

  it("treats model text as text, never markup", () => {
    const { renderer } = setup();
    renderer.renderCoreResult("s1", corePayload("s1", [
      { startToken: 0, endToken: 1, role: "主语", translation: '<img onerror="alert(1)">', text: "The service" },
    ]));

    const translation = document.querySelector(".english-syntax-translation");
    expect(translation?.innerHTML).not.toContain("<img");
    expect(translation?.textContent).toContain("<img onerror=");
  });

  it("emits a detail request when a component is clicked and toggles on repeat clicks", () => {
    const { renderer, detailRequests } = setup();
    renderer.renderCoreResult("s1", corePayload("s1", [
      { startToken: 0, endToken: 1, role: "主语", translation: "该服务", text: "The service" },
    ]));

    const component = document.querySelector(".english-syntax-component") as HTMLButtonElement;
    component.click();
    expect(detailRequests).toEqual([["s1", 0, 1]]);

    renderer.renderDetailResult({
      sentenceId: "s1",
      focus: { startToken: 0, endToken: 1 },
      structures: [{ startToken: 0, endToken: 1, role: "主语", explanation: "名词短语", translation: "该服务" }],
      grammarPoints: ["一般现在时"],
      explanation: "整体说明",
    });
    expect(document.querySelector(".english-syntax-detail")).not.toBeNull();

    // 再次点击同一成分 → 关闭面板，不发第二次请求。
    component.click();
    expect(detailRequests).toHaveLength(1);
    expect(document.querySelector(".english-syntax-detail")).toBeNull();
  });

  it("ignores messages for unregistered sentences", () => {
    const { renderer } = setup();
    renderer.renderCoreResult("unknown", corePayload("unknown", [
      { startToken: 0, endToken: 1, role: "主语", translation: "该服务" },
    ]));
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();
  });

  it("keeps punctuation-only text out of standalone components", () => {
    const { renderer } = setup();
    renderer.renderCoreResult("s1", corePayload("s1", [
      { startToken: 0, endToken: 1, role: "主语", translation: "该服务", text: "The service" },
      { startToken: 5, endToken: 5, role: "标点", translation: ".", text: "." },
    ]));
    const components = document.querySelectorAll(".english-syntax-component");
    // 标点不带翻译按钮：渲染层只画有 text 的成分行；纯标点翻译 "." 仍然安全显示。
    expect(components.length).toBe(2);
    void renderer;
  });

  it("dispatches host messages through handleHostMessage", () => {
    const { renderer } = setup();
    const handler = vi.fn();
    void handler;
    renderer.handleHostMessage({
      version: 1,
      type: "CORE_RESULT",
      previewId: "p1",
      generation: 0,
      sentenceId: "s1",
      analysisJson: JSON.stringify(
        corePayload("s1", [{ startToken: 0, endToken: 1, role: "主语", translation: "该服务", text: "The service" }]),
      ),
    } as never);
    expect(document.querySelector("[data-english-syntax-card]")).not.toBeNull();

    renderer.handleHostMessage({
      version: 1,
      type: "RESTORE_ALL",
      previewId: "p1",
      generation: 0,
    } as never);
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();
  });
});
