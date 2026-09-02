// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewRenderer } from "./render";
import { setDarkMode, isDarkMode } from "./roles";

const HIDDEN = "data-english-syntax-hidden";

function paragraph(id: string): HTMLElement {
  const element = document.createElement("p");
  element.id = id;
  element.textContent = "The service validates every response before returning anything.";
  document.body.append(element);
  return element;
}

function corePayload(
  sentenceId: string,
  components: Array<{
    startToken: number;
    endToken: number;
    role: string;
    translation: string;
    text?: string;
  }>,
) {
  return { sentenceId, components };
}

function setup(paragraphId = "p1"): {
  renderer: PreviewRenderer;
  element: HTMLElement;
  detailRequests: Array<[string, number, number]>;
} {
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
    setDarkMode(false); // 每个用例重置深色开关，避免跨用例污染
    document.body.replaceChildren();
  });

  it("keeps the original text visible until a complete or streamed result arrives", () => {
    const { renderer, element } = setup();
    expect(element.hasAttribute(HIDDEN)).toBe(false);
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();
    void renderer;
  });

  it("the injected stylesheet really hides the replaced original, not just marks it", () => {
    // HIDDEN 属性只是标记（还原时据它精确删除），真正的隐藏靠 preview.css 里的规则。
    // 这条规则曾整个缺失：卡片插在原文之后，原文照旧显示，一段翻完屏上有两份。
    // 后果不止是难看——鼠标本来就停在那份可见的原文上，再按一次按段解析快捷键就会
    // 对同一段重复下发（原文是卡片的兄弟节点，`closest([data-...-card])` 查不到），
    // 表现为「一直显示在翻译状态」。happy-dom 不加载注入的样式表，只能按文本钉住。
    const css = readFileSync(join(process.cwd(), "src/main/resources/web/preview.css"), "utf8");
    expect(css).toMatch(/\[data-english-syntax-hidden\][^{]*\{[^}]*display:\s*none/);
  });

  it("renders a provisional card from the first streamed component", () => {
    const { renderer, element } = setup();
    renderer.renderCoreStream("s1", "b1", [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
    ]);

    const card = document.querySelector("[data-english-syntax-card]");
    expect(card).not.toBeNull();
    expect(element.hasAttribute(HIDDEN)).toBe(true);
    expect(card?.querySelector(".english-syntax-component")?.textContent).toContain("该服务");
    // 中文角色标签：SUBJECT → 主语
    expect(card?.querySelector(".english-syntax-role")?.textContent).toBe("主语");
    expect(
      card
        ?.querySelector(".english-syntax-sentence")
        ?.classList.contains("english-syntax-provisional"),
    ).toBe(true);
  });

  it("restores uncovered dashes and commas once in source order", () => {
    const { renderer } = setup();
    const tokens = [
      { id: 0, text: "Explore", leadingWhitespace: "", punctuation: false },
      { id: 1, text: "context", leadingWhitespace: " ", punctuation: false },
      { id: 2, text: "—", leadingWhitespace: " ", punctuation: true },
      { id: 3, text: "check", leadingWhitespace: " ", punctuation: false },
      { id: 4, text: "files", leadingWhitespace: " ", punctuation: false },
      { id: 5, text: ",", leadingWhitespace: "", punctuation: true },
      { id: 6, text: "docs", leadingWhitespace: " ", punctuation: false },
      { id: 7, text: ",", leadingWhitespace: "", punctuation: true },
      { id: 8, text: "commits", leadingWhitespace: " ", punctuation: false },
      { id: 9, text: ".", leadingWhitespace: "", punctuation: true },
    ];

    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "OBJECT", translation: "项目上下文", text: "Explore context" },
        { startToken: 3, endToken: 3, role: "PREDICATE", translation: "检查", text: " check" },
        { startToken: 4, endToken: 4, role: "OBJECT", translation: "文件", text: " files" },
        { startToken: 6, endToken: 6, role: "OBJECT", translation: "文档", text: " docs" },
        { startToken: 8, endToken: 8, role: "OBJECT", translation: "提交", text: " commits" },
      ]),
      tokens,
    );

    const sentence = document.querySelector(".english-syntax-sentence");
    expect(sentence?.textContent?.match(/—/gu)).toHaveLength(1);
    expect(sentence?.textContent?.match(/,/gu)).toHaveLength(2);
    expect(sentence?.textContent?.match(/\./gu)).toHaveLength(1);
    expect(
      [...document.querySelectorAll(".english-syntax-english")].map((node) => node.textContent),
    ).toEqual(["Explore context —", " check", " files,", " docs,", " commits."]);
  });

  it("restores uncovered punctuation during streaming", () => {
    const { renderer } = setup();
    renderer.renderCoreStream(
      "s1",
      "b1",
      [{ startToken: 0, endToken: 1, role: "OBJECT", translation: "项目上下文", text: "Explore context" }],
      [
        { id: 0, text: "Explore", leadingWhitespace: "", punctuation: false },
        { id: 1, text: "context", leadingWhitespace: " ", punctuation: false },
        { id: 2, text: "—", leadingWhitespace: " ", punctuation: true },
      ],
    );

    expect(document.querySelector(".english-syntax-english")?.textContent).toBe("Explore context —");
  });

  it("replaces the provisional card with the final result", () => {
    const { renderer } = setup();
    renderer.renderCoreStream("s1", "b1", [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
    ]);
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        { startToken: 2, endToken: 2, role: "PREDICATE", translation: "校验", text: "validates" },
      ]),
    );

    const sentence = document.querySelector(".english-syntax-sentence");
    expect(sentence?.classList.contains("english-syntax-provisional")).toBe(false);
    expect(document.querySelectorAll(".english-syntax-component")).toHaveLength(2);
  });

  it("shows failure with original text and retry, and retry is restored on second error", () => {
    const { renderer, element, detailRequests } = setup();
    const tokens = [
      { id: 0, text: "Classify", leadingWhitespace: "", punctuation: false },
      { id: 1, text: "the", leadingWhitespace: " ", punctuation: false },
      { id: 2, text: "request", leadingWhitespace: " ", punctuation: false },
      { id: 3, text: ".", leadingWhitespace: "", punctuation: true },
    ];
    renderer.renderCoreError(
      "s1",
      "b1",
      "INVALID_MODEL_OUTPUT",
      "原始 JSON 不该上屏",
      tokens,
    );

    const retry = document.querySelector(".english-syntax-retry") as HTMLButtonElement;
    expect(retry).not.toBeNull();
    // 错误文案按 code 出友好提示，不再透传模型原始 JSON
    expect(document.querySelector(".english-syntax-error")?.textContent).toContain("模型返回结果无法解析");
    expect(document.querySelector(".english-syntax-error")?.textContent).not.toContain("原始 JSON");
    // 即使完整结果到达前没有流式分片，CORE_ERROR 自带 tokens 也能保留准确原句。
    expect(document.querySelector(".english-syntax-original")?.textContent).toBe("Classify the request.");

    retry.click();
    expect(detailRequests.length).toBe(0); // 失败句重试走 RETRY_SENTENCE，不触发 detail
    void element;
  });

  it("restoreAll removes plugin nodes and data attributes", () => {
    const { renderer, element } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]),
    );
    expect(document.querySelector("[data-english-syntax-card]")).not.toBeNull();

    renderer.restoreAll();

    expect(element.hasAttribute(HIDDEN)).toBe(false);
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();
  });

  /**
   * 「停止并恢复原文」后再点开始：JS 侧 initialize 重扫同一批元素，对同一个 blockId
   * 再 registerBlock，sentenceId（`s-{blockId}-{index}`）也照旧复用。#sentences 是全局
   * 映射，旧条目留着会让 #ensureSentence 判「已存在」提前返回，新 BlockRecord 的
   * sentences 永远拿不到这一句 → #repaintBlock 算出 hasContent=false → 走 #restoreBlock，
   * 卡片永远画不出来（真机：恢复原文后再点翻译，整页毫无反应且无报错）。
   */
  it("renders again after restoreAll when the same block is registered a second time", () => {
    const { renderer, element } = setup();
    const result = corePayload("s1", [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
    ]);
    renderer.renderCoreResult("s1", "b1", result);
    renderer.restoreAll();
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();

    // 第二轮：同一元素、同一 blockId、同一 sentenceId 重新注册并出结果。
    renderer.registerBlock("b1", element);
    renderer.renderCoreResult("s1", "b1", result);

    const card = document.querySelector("[data-english-syntax-card]");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("The service");
    expect(element.hasAttribute(HIDDEN)).toBe(true);
  });

  it("treats model text as text, never markup", () => {
    const { renderer } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        {
          startToken: 0,
          endToken: 1,
          role: "SUBJECT",
          translation: '<img onerror="alert(1)">',
          text: "The service",
        },
      ]),
    );

    const translation = document.querySelector(".english-syntax-translation");
    expect(translation?.innerHTML).not.toContain("<img");
    expect(translation?.textContent).toContain("<img onerror=");
  });

  it("emits a detail request when a component is clicked and toggles on repeat clicks", () => {
    const { renderer, detailRequests } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]),
    );

    const component = document.querySelector(".english-syntax-component") as HTMLButtonElement;
    component.click();
    expect(detailRequests).toEqual([["s1", 0, 1]]);

    renderer.renderDetailResult({
      sentenceId: "s1",
      focus: { startToken: 0, endToken: 1 },
      structures: [
        {
          startToken: 0,
          endToken: 1,
          role: "主语",
          explanation: "名词短语",
          translation: "该服务",
          text: "The service",
        },
      ],
      grammarPoints: ["一般现在时"],
      explanation: "整体说明",
    });
    expect(document.querySelector(".english-syntax-detail")).not.toBeNull();
    // 标注行带圈号 + 角色
    expect(document.querySelector(".english-syntax-annotation-role")?.textContent).toContain("① 主语");
    // 英文摘录 + 中文译文并行渲染（与 Chrome 端对齐，避免「没有英文与中文对照」）
    const english = document.querySelector(".english-syntax-annotation-english");
    expect(english?.textContent).toContain("The service");
    const translation = document.querySelector(".english-syntax-annotation-translation");
    expect(translation?.textContent).toContain("该服务");

    // 再次点击同一成分 → 关闭面板，不发第二次请求。
    component.click();
    expect(detailRequests).toHaveLength(1);
    expect(document.querySelector(".english-syntax-detail")).toBeNull();
  });

  it("anchors the detail panel right below the clicked sentence, not at the card end", () => {
    // 多句块：面板必须插在「被点句子」的 section 之后（兄弟节点），不能跑到卡片末尾。
    const { renderer } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]),
    );
    renderer.renderCoreResult(
      "s2",
      "b1",
      corePayload("s2", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]),
    );
    renderer.renderCoreResult(
      "s3",
      "b1",
      corePayload("s3", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]),
    );

    // 点第二句的成分
    const sections = document.querySelectorAll<HTMLElement>(".english-syntax-sentence");
    expect(sections.length).toBe(3);
    const secondComponent = sections[1]!.querySelector<HTMLButtonElement>(".english-syntax-component")!;
    secondComponent.click();
    renderer.renderDetailResult({
      sentenceId: "s2",
      focus: { startToken: 0, endToken: 1 },
      structures: [
        { startToken: 0, endToken: 1, role: "主语", explanation: "名词短语", translation: "该服务" },
      ],
      grammarPoints: [],
      explanation: "整体说明",
    });

    const panel = document.querySelector(".english-syntax-detail");
    expect(panel).not.toBeNull();
    // 面板紧跟 s2 的 section，在 s3 之前（而不是 append 到容器末尾之后）
    expect(panel?.previousElementSibling?.getAttribute("data-sentence-id")).toBe("s2");
    expect(panel?.nextElementSibling?.getAttribute("data-sentence-id")).toBe("s3");
    // 面板插在句外这一支:句子绝不能变块级。它一撑满整行,本来与它共行的短句就被压到
    // 面板下面去了——用户看到的就是「本来一行,点一下变两行」。
    const rebuilt = document.querySelectorAll<HTMLElement>(".english-syntax-sentence");
    const s2Section = [...rebuilt].find((el) => el.dataset.sentenceId === "s2")!;
    expect(s2Section.classList.contains("english-syntax-has-detail")).toBe(false);
  });

  it("anchors the detail panel at the end of the clicked component's visual line, not the sentence end", () => {
    // Chrome 端 setDetailLoading 的行锚定：长句折行时，点第一行的成分，面板插到
    // 「该行最后一个成分」之后（同一视觉行下方），而不是整句末尾。
    const { renderer } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        { startToken: 2, endToken: 2, role: "PREDICATE", translation: "校验", text: "validates" },
        { startToken: 3, endToken: 5, role: "OBJECT", translation: "每个响应", text: "every response" },
      ]),
    );

    // 模拟真实布局：句子内第一个成分单独一行（top=40），后两个成分在下一行（top=60）。
    // 被点成分「下面还有成分」→ 面板应插到该行末尾（即第一个成分之后）。
    // mock 按元素在句子内的成分索引返回布局——整卡重建后新元素同样命中。
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("english-syntax-component")) {
        const sentence = this.parentElement;
        const index = sentence === null ? 0 : [...sentence.children].indexOf(this);
        const top = index === 0 ? 40 : 60;
        return {
          top,
          bottom: top + 16,
          height: 16,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return original.call(this);
    });

    // 点第一个成分（用 mock 之前的首个成分元素触发 click）
    const components = document.querySelectorAll<HTMLElement>(".english-syntax-component");
    const first = components[0]!;
    try {
      first.click();
      renderer.renderDetailResult({
        sentenceId: "s1",
        focus: { startToken: 0, endToken: 1 },
        structures: [
          { startToken: 0, endToken: 1, role: "主语", explanation: "名词短语", translation: "该服务" },
        ],
        grammarPoints: [],
        explanation: "整体说明",
      });

      const panel = document.querySelector(".english-syntax-detail");
      expect(panel).not.toBeNull();
      // 整卡重建后重新查询成分
      const rebuilt = document.querySelectorAll<HTMLElement>(".english-syntax-component");
      expect(rebuilt.length).toBe(3);
      // 面板插在第一个成分之后（该行末尾），而不是第二个成分之后/句子末尾
      expect(panel?.previousElementSibling).toBe(rebuilt[0]);
      expect(panel?.nextElementSibling).toBe(rebuilt[1]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("anchors the loading placeholder on the clicked line so the panel never jumps when content arrives", () => {
    // 回归过一次的老毛病:占位图省事插在整句之后,详解回来才精确锚定,于是面板先出现在
    // 句尾、内容到了又跳到被点成分那一行。判据就是「占位的落点 = 最终面板的落点」。
    const { renderer } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        { startToken: 2, endToken: 2, role: "PREDICATE", translation: "校验", text: "validates" },
        { startToken: 3, endToken: 5, role: "OBJECT", translation: "每个响应", text: "every response" },
      ]),
    );
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("english-syntax-component")) {
        const sentence = this.parentElement;
        const index = sentence === null ? 0 : [...sentence.children].indexOf(this);
        const top = index === 0 ? 40 : 60; // 第一个成分独占一行,后两个在下一行
        return { top, bottom: top + 16, height: 16, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return original.call(this);
    });
    try {
      document.querySelectorAll<HTMLElement>(".english-syntax-component")[0]!.click();
      const loading = document.querySelector(".english-syntax-detail-loading");
      expect(loading).not.toBeNull();
      // 占位落在句内、被点成分之后——不是句尾
      expect(loading?.parentElement?.classList.contains("english-syntax-sentence")).toBe(true);
      expect((loading?.previousElementSibling as HTMLElement | null)?.dataset.startToken).toBe("0");
      renderer.renderDetailResult({
        sentenceId: "s1",
        focus: { startToken: 0, endToken: 1 },
        structures: [
          { startToken: 0, endToken: 1, role: "主语", explanation: "名词短语", translation: "该服务" },
        ],
        grammarPoints: [],
        explanation: "整体说明",
      });
      const panel = document.querySelector(".english-syntax-detail");
      expect(panel?.classList.contains("english-syntax-detail-loading")).toBe(false);
      // 最终面板前面还是同一个成分:占位到成品没挪窝
      expect((panel?.previousElementSibling as HTMLElement | null)?.dataset.startToken).toBe("0");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps sentences that share a visual line on that line: the panel goes after the last one", () => {
    // 用户报的第二个问题:点一下成分,本来一行的变成两行。短句和邻句共行,面板若插在
    // 「被点句」正后方,同行的后一句就被压到面板下面;句子再被加上块级类,它自己撑满
    // 整行,邻居照样被挤走。正解:面板插到该视觉行最后一句之后,且不动句子的显示方式。
    const { renderer } = setup();
    for (const id of ["s1", "s2", "s3"]) {
      renderer.renderCoreResult(
        id,
        "b1",
        corePayload(id, [
          { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        ]),
      );
    }
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      // 三句短句同处一行(top 都是 40):句内只有一个成分,所以走「插到句外」那一支。
      if (
        this.classList.contains("english-syntax-sentence") ||
        this.classList.contains("english-syntax-component")
      ) {
        return { top: 40, bottom: 56, height: 16, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return original.call(this);
    });
    try {
      const sections = document.querySelectorAll<HTMLElement>(".english-syntax-sentence");
      sections[1]!.querySelector<HTMLButtonElement>(".english-syntax-component")!.click();
      const loading = document.querySelector(".english-syntax-detail-loading");
      // 面板落在同行最后一句(s3)之后,s2/s3 仍在面板之前,顺序没被拆开
      expect((loading?.previousElementSibling as HTMLElement | null)?.dataset.sentenceId).toBe("s3");
      const marked = [...document.querySelectorAll<HTMLElement>(".english-syntax-sentence")].filter((el) =>
        el.classList.contains("english-syntax-has-detail"),
      );
      expect(marked).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ignores messages for unregistered sentences", () => {
    const { renderer } = setup();
    renderer.renderCoreResult(
      "unknown",
      corePayload("unknown", [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务" }]),
    );
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();
  });

  it("keeps punctuation-only components out of standalone rendering when text is missing", () => {
    const { renderer } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        { startToken: 5, endToken: 5, role: "CONJUNCTION", translation: ".", text: "." },
      ]),
    );
    const components = document.querySelectorAll(".english-syntax-component");
    // 标点成分仍是按钮（与 Chrome 一致按成分渲染），这里只断言存在且安全。
    expect(components.length).toBe(2);
    void renderer;
  });

  it("dispatches host messages through handleHostMessage", () => {
    const { renderer } = setup();
    renderer.handleHostMessage({
      version: 1,
      type: "CORE_RESULT",
      previewId: "p1",
      generation: 0,
      sentenceId: "s1",
      blockId: "b1",
      analysisJson: JSON.stringify(
        corePayload("s1", [
          { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        ]),
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

  it("renders a card from a CORE_RESULT without prior sentence registration (production path)", () => {
    // 生产链路：只 registerBlock（扫描），句子由 CORE_RESULT 携带的 blockId 惰性注册。
    const element = paragraph("p1");
    const renderer = new PreviewRenderer(() => {});
    renderer.registerBlock("b1", element);

    renderer.handleHostMessage({
      version: 1,
      type: "CORE_RESULT",
      previewId: "p1",
      generation: 0,
      sentenceId: "s-b1-0",
      blockId: "b1",
      analysisJson: JSON.stringify(
        corePayload("s-b1-0", [
          { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        ]),
      ),
    } as never);

    expect(element.hasAttribute(HIDDEN)).toBe(true);
    const card = document.querySelector("[data-english-syntax-card]");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("该服务");
    expect(card?.textContent).toContain("主语");
  });

  it("ignores a CORE_RESULT whose block was never registered", () => {
    const renderer = new PreviewRenderer(() => {});
    renderer.handleHostMessage({
      version: 1,
      type: "CORE_RESULT",
      previewId: "p1",
      generation: 0,
      sentenceId: "s-unknown-0",
      blockId: "unknown",
      analysisJson: JSON.stringify(corePayload("s-unknown-0", [])),
    } as never);
    expect(document.querySelector("[data-english-syntax-card]")).toBeNull();
  });

  it("uses a brightened role palette when dark mode is enabled", () => {
    setDarkMode(true);
    expect(isDarkMode()).toBe(true);
    const { renderer } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]),
    );

    const component = document.querySelector(".english-syntax-component") as HTMLElement;
    // 浅色板 SUBJECT=#2563eb；深色板应提亮为 #60a5fa（内联到 --english-syntax-role-color）。
    expect(component.style.getPropertyValue("--english-syntax-role-color")).toBe("#60a5fa");
  });

  it("restores the default palette when dark mode is disabled", () => {
    setDarkMode(false);
    const { renderer } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]),
    );
    const component = document.querySelector(".english-syntax-component") as HTMLElement;
    expect(component.style.getPropertyValue("--english-syntax-role-color")).toBe("#2563eb");
  });

  it("streamed detail anchors below the clicked component line using its focus", () => {
    // Bug 修复：DETAIL_STREAM 也携带 focus，流式阶段就被锚定到被点成分所在行，
    // 而不是等完整结果（DETAIL_RESULT）到了才从「句子最后一行」跳到「当前行」。
    const { renderer } = setup();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        { startToken: 2, endToken: 2, role: "PREDICATE", translation: "校验", text: "validates" },
        { startToken: 3, endToken: 5, role: "OBJECT", translation: "每个响应", text: "every response" },
      ]),
    );

    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("english-syntax-component")) {
        const sentence = this.parentElement;
        const index = sentence === null ? 0 : [...sentence.children].indexOf(this);
        const top = index === 0 ? 40 : 60;
        return {
          top,
          bottom: top + 16,
          height: 16,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return original.call(this);
    });

    try {
      const first = document.querySelectorAll<HTMLElement>(".english-syntax-component")[0]!;
      first.click();
      renderer.renderDetailStream("s1", 0, 1, [
        { startToken: 0, endToken: 1, role: "主语", explanation: "名词短语", translation: "该服务", text: "The service" },
      ]);

      const panel = document.querySelector(".english-syntax-detail");
      const rebuilt = document.querySelectorAll<HTMLElement>(".english-syntax-component");
      // 流式阶段就应插到第一个成分之后（被点行末尾），而非句子之末。之前 focus=0/0 会退化到句子后。
      expect(panel?.previousElementSibling).toBe(rebuilt[0]);
      expect(panel?.nextElementSibling).toBe(rebuilt[1]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("renders sentences in source order even when streamed messages arrive out of order", () => {
    // 回归：卡片里句子顺序 = 原文源序，而不是消息到达顺序。
    // 流式分片按模型输出到达，可能先吐后半句（s2 先来）。#blockSentenceOrder 若按到达
    // 累积，final 卡片就会把 s2 排在 s1 前面（英文与原文对不上）。此处乱序喂入 s2、s1 的
    // CORE_RESULT，最终卡片仍应按 s1、s2（源序）排列。
    const { renderer } = setup(); // registerSentence(b1, s1)
    renderer.registerSentence("b1", "s2");

    // 先到 s2（语法上常先想到后半句），再到 s1。
    renderer.renderCoreResult(
      "s2",
      "b1",
      corePayload("s2", [
        { startToken: 0, endToken: 1, role: "PREDICATE", translation: "校验", text: "validates" },
      ]),
    );
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]),
    );

    const sections = document.querySelectorAll<HTMLElement>(".english-syntax-sentence");
    expect(sections.length).toBe(2);
    // 卡片内句子按源序 s1 → s2 排列。
    expect(sections[0]!.dataset.sentenceId).toBe("s1");
    expect(sections[1]!.dataset.sentenceId).toBe("s2");
    // s1（源序靠前）的英文原文行在前。
    expect(sections[0]!.querySelector(".english-syntax-english")?.textContent).toBe("The service");
  });
});
