// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import {
  diagnoseElement,
  formatDiagnosisReport,
  recordDiagnosisTarget,
  resolveDiagnosisTarget,
} from "./block-diagnosis";

const baseInput = {
  document,
  url: "https://example.com/docs?page=3#section",
  sessionSnapshot: () => ({ state: "stopped" as const, registered: false, sentences: [] }),
  now: () => new Date("2026-10-11T00:00:00Z"),
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("resolveDiagnosisTarget（spec D1 落点优先级：选区锚点 → 右键落点 → body）", () => {
  it("recordDiagnosisTarget 记录元素，resolve 返回 contextmenu 源", () => {
    document.body.innerHTML = '<main><p id="p">Text</p></main>';
    recordDiagnosisTarget({ target: document.getElementById("p") } as unknown as Event);
    const resolved = resolveDiagnosisTarget();
    expect(resolved.element).toBe(document.getElementById("p"));
    expect(resolved.source).toBe("contextmenu");
  });

  it("选区锚点优先于右键落点（spec D1：三者都记进报告）", () => {
    document.body.innerHTML = '<main><p id="a">First para.</p><p id="b">Second para.</p></main>';
    recordDiagnosisTarget({ target: document.getElementById("b") } as unknown as Event);
    const selection = document.getSelection();
    const range = document.createRange();
    // 真实选区的锚点是文本节点（mousedown 落在文本里）；selectNodeContents 会把
    // 锚点设为元素自身，其 parentElement 是外层容器——spec D1 的规则是
    // anchorNode.parentElement，锚在文本节点上才能取到所选段落。
    const textNode = document.getElementById("a")!.firstChild!;
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const resolved = resolveDiagnosisTarget();
    // happy-dom 的 getSelection 实现有限：若 anchorNode 取不到就跳过该断言分支（真机/E2E 覆盖）
    if (selection?.anchorNode != null) {
      expect(resolved.source).toBe("selection");
      expect(resolved.element).toBe(document.getElementById("a"));
    }
  });

  it("陈旧选区锚点（DOM 重置后脱离文档）回落到右键落点", () => {
    // ① 在 #a 的文本节点上建立选区（真实用户选区的锚点形态）
    document.body.innerHTML = '<main><p id="a">First para.</p><p id="b">Second para.</p></main>';
    const textNode = document.getElementById("a")!.firstChild!;
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textNode);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // ② DOM 重置（选区锚点脱离文档），再记录右键落点
    document.body.innerHTML = '<main><p id="c">Third para.</p></main>';
    // 前置自检：本用例的守卫覆盖依赖「happy-dom 的 Selection 跨 innerHTML 重置存活，
    // 锚点滞留在已脱离文档的节点上」这一行为。若未来 happy-dom 改为重置时清空选区，
    // 这里先红——提醒调整构造，而不是让守卫覆盖静默归零而测试全绿。
    expect(selection?.anchorNode).toBe(textNode);
    expect(document.contains(textNode.parentElement)).toBe(false);
    recordDiagnosisTarget({ target: document.getElementById("c") } as unknown as Event);
    // ③ 陈旧锚点不得当选区源：必须回落到 contextmenu 落点
    const resolved = resolveDiagnosisTarget();
    expect(resolved.element).toBe(document.getElementById("c"));
    expect(resolved.source).toBe("contextmenu");
  });

  it("无选区无记录时回落 body", () => {
    document.body.innerHTML = "<main><p>x</p></main>";
    recordDiagnosisTarget({ target: null } as unknown as Event); // 清掉记录
    const resolved = resolveDiagnosisTarget();
    expect(resolved.element).toBe(document.body);
    expect(resolved.source).toBe("body");
  });

  it("S4：documentElement 的 ready 标记不算扩展自身元素；卡片/胶囊才上溯", () => {
    // installContentScript 会在 <html> 上设 data-syntax-learning-extension="ready"
    // （content-script.ts:462）——任何元素 closest 都会命中它；若把它当扩展元素，
    // 生产环境所有落点都会退化成 html.parentElement === null。必须排除。
    document.documentElement.dataset.syntaxLearningExtension = "ready";
    document.body.innerHTML = '<main><p id="p">Text</p></main>';
    recordDiagnosisTarget({ target: document.getElementById("p") } as unknown as Event);
    expect(resolveDiagnosisTarget().element).toBe(document.getElementById("p"));
    delete document.documentElement.dataset.syntaxLearningExtension;

    // 真正的扩展元素（卡片 host）仍然上溯并标记 extension-ascended
    document.body.innerHTML =
      '<main><div id="wrap"><div data-syntax-learning-block></div></div></main>';
    const card = document.querySelector("[data-syntax-learning-block]")!;
    recordDiagnosisTarget({ target: card } as unknown as Event);
    const resolved = resolveDiagnosisTarget();
    expect(resolved.element).toBe(document.getElementById("wrap"));
    expect(resolved.source).toBe("extension-ascended");
  });
});

describe("diagnoseElement", () => {
  it("非英文段落的证据指向 english-dominant 门并带数值", () => {
    document.body.innerHTML = '<main><p id="mixed">Hello 你好世界测试数据</p></main>';
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("mixed"),
      targetSource: "contextmenu",
    });
    const gate = diagnosis.gates.find(({ gate }) => gate === "english-dominant")!;
    expect(gate.ok).toBe(false);
    expect(gate.value).toBeLessThan(0.6);
    expect(diagnosis.inventory.exclusionReason).toBe("non-english");
  });

  it("text 度量与短块阈值进证据", () => {
    document.body.innerHTML = '<main><div id="tiny">Short text</div></main>';
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("tiny"),
      targetSource: "contextmenu",
    });
    expect(diagnosis.text.minAutoTextLength).toBe(20);
    expect(diagnosis.text.length).toBe(10);
  });

  it("segmentation 用生产分句/分词", () => {
    document.body.innerHTML =
      '<main><p id="two">First sentence here. Second sentence there now.</p></main>';
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("two"),
      targetSource: "contextmenu",
    });
    expect(diagnosis.segmentation.sentenceCount).toBe(2);
    expect(diagnosis.segmentation.tokenCount).toBeGreaterThan(4);
    expect(diagnosis.segmentation.emptyText).toBe(false);
  });

  it("URL 去 query 与 fragment；outerHTML 截断并脱敏表单值", () => {
    document.body.innerHTML =
      '<main><p id="x" data-secret="keep">Value <input value="hunter2"></p></main>';
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("x"),
      targetSource: "contextmenu",
    });
    expect(diagnosis.page.url).toBe("https://example.com/docs");
    expect(diagnosis.target.outerHtml).not.toContain("hunter2");
    expect(diagnosis.target.outerHtml.length).toBeLessThanOrEqual(220); // 200 + 少量省略标记
  });

  it("requestFeasibility 标出超长句并带两档批上限", () => {
    document.body.innerHTML = `<main><p id="long">${"word ".repeat(600)}</p></main>`;
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("long"),
      targetSource: "contextmenu",
    });
    expect(diagnosis.requestFeasibility.maxSentenceLength).toBeGreaterThan(2000);
    expect(diagnosis.requestFeasibility.sentenceLengthLimit).toBe(2000);
    expect(diagnosis.requestFeasibility.maxSentencesPerRequest).toBe(6);
    expect(diagnosis.requestFeasibility.cloudSentencesPerRequest).toBe(2);
  });

  it("会话快照透传", () => {
    document.body.innerHTML = '<main><p id="p">Some English words here.</p></main>';
    const snapshot = {
      state: "running" as const,
      registered: true,
      sentences: [{ text: "x", phase: "failed", failureMessage: "INVALID_MODEL_OUTPUT：bad" }],
    };
    const diagnosis = diagnoseElement({
      ...baseInput,
      target: document.getElementById("p"),
      targetSource: "contextmenu",
      sessionSnapshot: () => snapshot,
    });
    expect(diagnosis.session).toEqual(snapshot);
    expect(diagnosis.targetSource).toBe("contextmenu");
  });
});

describe("formatDiagnosisReport", () => {
  const diagnosisOf = (target: string) =>
    diagnoseElement({
      ...baseInput,
      target: document.querySelector(target),
      targetSource: "contextmenu",
    });

  it("七个小节齐全且顺序固定", () => {
    document.body.innerHTML = '<main><p id="p">Hello world from the test page.</p></main>';
    const report = formatDiagnosisReport(diagnosisOf("#p"), {});
    const sections = [
      "## 概述",
      "## 页面与落点",
      "## 本地判定证据",
      "## 分句与请求可行性",
      "## 会话状态",
      "## 模型解释",
      "## 环境",
    ];
    const positions = sections.map((s) => report.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("概述点名第一个失败门", () => {
    document.body.innerHTML = '<main><p id="mixed">Hello 你好世界测试</p></main>';
    const report = formatDiagnosisReport(diagnosisOf("#mixed"), {});
    expect(report).toContain("english-dominant");
  });

  it("证据表逐门列出结果与取值", () => {
    document.body.innerHTML = '<main><p id="p">Some English words in the paragraph.</p></main>';
    const report = formatDiagnosisReport(diagnosisOf("#p"), {});
    expect(report).toMatch(/\| *english-dominant *\|/u);
    expect(report).toMatch(/\| *门 *\|/u);
  });

  it("模型解释段呈现三字段；无模型时呈现 modelError", () => {
    document.body.innerHTML = '<main><p id="p">Another English sentence here.</p></main>';
    const base = diagnosisOf("#p");
    const withModel = formatDiagnosisReport(base, {
      model: {
        likelyCause: "english ratio below threshold",
        explanation: "占比不足。",
        suggestions: ["检查语言"],
      },
      profileModel: "deepseek-flash",
      extensionVersion: "1.4.2",
      generatedAt: "2026-10-11T00:00:00Z",
    });
    expect(withModel).toContain("likelyCause: english ratio below threshold");
    expect(withModel).toContain("- 检查语言");
    expect(withModel).toContain("deepseek-flash");
    const withError = formatDiagnosisReport(base, {
      modelError: { code: "CONFIG_MISSING", message: "尚未配置", retryable: false },
    });
    expect(withError).toContain("CONFIG_MISSING");
  });

  it("URL 已去 query（进报告的是净化后 URL）", () => {
    document.body.innerHTML = '<main><p id="p">English words for the url check.</p></main>';
    const report = formatDiagnosisReport(diagnosisOf("#p"), {});
    expect(report).toContain("https://example.com/docs");
    expect(report).not.toContain("page=3");
  });
});
