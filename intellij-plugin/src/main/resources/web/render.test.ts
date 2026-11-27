// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FEEDBACK_CHARACTERS } from "./bridge";
import { CORRECTION_OPEN_EVENT, PreviewRenderer } from "./render";
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
      "AUTH_FAILED",
      '{"error":{"message":"Insufficient Balance"}}',
      tokens,
    );

    const retry = document.querySelector(".english-syntax-retry") as HTMLButtonElement;
    expect(retry).not.toBeNull();
    // 传输/鉴权类 code 出友好提示，不透传 provider 原始 JSON（看不懂又可能泄内部信息）。
    expect(document.querySelector(".english-syntax-error")?.textContent).toContain(
      "模型配置鉴权失败",
    );
    expect(document.querySelector(".english-syntax-error")?.textContent).not.toContain("Insufficient Balance");
    // 即使完整结果到达前没有流式分片，CORE_ERROR 自带 tokens 也能保留准确原句。
    expect(document.querySelector(".english-syntax-original")?.textContent).toBe("Classify the request.");

    retry.click();
    expect(detailRequests.length).toBe(0); // 失败句重试走 RETRY_SENTENCE，不触发 detail
    void element;
  });

  it("INVALID_MODEL_OUTPUT with a non-empty message shows the real validator summary (F1)", () => {
    // F1：两轮修复仍失败的真实校验错误已在 CORE_ERROR.message 桥上（Kotlin 侧构造
    // failures 时按 profile 密钥边界脱敏），屏上直接显示它——正是 Chrome 侧逐句失败
    // 文案的形态；继续覆写成笼统文案会把排障刚需藏进 IDEA 日志。
    const { renderer } = setup();
    const tokens = [
      { id: 0, text: "Classify", leadingWhitespace: "", punctuation: false },
      { id: 1, text: "the", leadingWhitespace: " ", punctuation: false },
      { id: 2, text: "request", leadingWhitespace: " ", punctuation: false },
      { id: 3, text: ".", leadingWhitespace: "", punctuation: true },
    ];
    const summary =
      "Model output remained invalid after two repairs: sentences[0].components[2].role: must be a known grammar role";
    renderer.renderCoreError("s1", "b1", "INVALID_MODEL_OUTPUT", summary, tokens);

    const error = document.querySelector(".english-syntax-error")?.textContent ?? "";
    expect(error).toContain("Model output remained invalid after two repairs");
    expect(error).toContain("must be a known grammar role");
    expect(error).not.toContain("模型返回结果无法解析");
  });

  it("failure row survives sibling repaints (persistent failure state)", () => {
    // 多句块：失败行此前只在触发帧（errorSentenceId 匹配）渲染，兄弟句的
    // CORE_RESULT 一到就整块重画——失败句变成空 section，原文隐藏、译文没有、
    // 重试/纠正按钮全丢。失败文案必须存进 record，任何重画都从持久状态渲染
    // （Chrome 端 sentence-failure 从会话状态渲染，重画不丢）。
    const { renderer } = setup();
    renderer.registerSentence("b1", "s2");
    const tokens = [
      { id: 0, text: "Classify", leadingWhitespace: "", punctuation: false },
      { id: 1, text: "the", leadingWhitespace: " ", punctuation: false },
      { id: 2, text: "request", leadingWhitespace: " ", punctuation: false },
      { id: 3, text: ".", leadingWhitespace: "", punctuation: true },
    ];
    renderer.renderCoreError("s1", "b1", "AUTH_FAILED", "Insufficient Balance", tokens);

    // 兄弟句成功 → 同块整卡重画（无错误 options）：s1 失败行必须原样存活。
    renderer.renderCoreResult(
      "s2",
      "b1",
      corePayload("s2", [{ startToken: 0, endToken: 3, role: "OBJECT", translation: "分类该请求" }]),
      tokens,
    );

    const failure = document.querySelector('.english-syntax-sentence-failure[data-sentence-id="s1"]');
    expect(failure).not.toBeNull();
    expect(failure?.querySelector(".english-syntax-original")?.textContent).toBe("Classify the request.");
    expect(failure?.querySelector(".english-syntax-error")?.textContent).toContain("模型配置鉴权失败");
    expect(failure?.querySelector(".english-syntax-retry")).not.toBeNull();
  });

  it("INVALID_MODEL_OUTPUT with an empty message keeps the friendly fallback text", () => {
    // 桥上 message 缺失/为空（旧缓存或异常路径）时仍走 ERROR_TEXT，不显示空错误行。
    const { renderer } = setup();
    const tokens = [
      { id: 0, text: "Classify", leadingWhitespace: "", punctuation: false },
      { id: 1, text: "the", leadingWhitespace: " ", punctuation: false },
      { id: 2, text: "request", leadingWhitespace: " ", punctuation: false },
      { id: 3, text: ".", leadingWhitespace: "", punctuation: true },
    ];
    renderer.renderCoreError("s1", "b1", "INVALID_MODEL_OUTPUT", "", tokens);

    expect(document.querySelector(".english-syntax-error")?.textContent).toContain("模型返回结果无法解析");
  });

  it("unknown codes keep the code-prefixed raw fallback", () => {
    const { renderer } = setup();
    const tokens = [
      { id: 0, text: "Classify", leadingWhitespace: "", punctuation: false },
      { id: 1, text: "the", leadingWhitespace: " ", punctuation: false },
      { id: 2, text: "request", leadingWhitespace: " ", punctuation: false },
      { id: 3, text: ".", leadingWhitespace: "", punctuation: true },
    ];
    renderer.renderCoreError("s1", "b1", "SOME_NEW_CODE", "细节信息", tokens);

    expect(document.querySelector(".english-syntax-error")?.textContent).toContain("SOME_NEW_CODE：细节信息");
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
        const index =
          sentence === null ? 0 : [...sentence.querySelectorAll(".english-syntax-component")].indexOf(this);
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
        const index =
          sentence === null ? 0 : [...sentence.querySelectorAll(".english-syntax-component")].indexOf(this);
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
        const index =
          sentence === null ? 0 : [...sentence.querySelectorAll(".english-syntax-component")].indexOf(this);
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

  describe("句头追问图标按钮", () => {
    it("does not render the chat icon on failed sentences", () => {
      const { renderer } = setup();
      renderer.renderCoreError("s1", "b1", "INVALID_MODEL_OUTPUT", "bad json", [
        { id: 0, text: "Classify", leadingWhitespace: "", punctuation: false },
        { id: 1, text: "the", leadingWhitespace: " ", punctuation: false },
        { id: 2, text: "request", leadingWhitespace: " ", punctuation: false },
        { id: 3, text: ".", leadingWhitespace: "", punctuation: true },
      ]);
      expect(document.querySelector(".english-syntax-chat-ask")).toBeNull();
    });

    it("does not render the chat icon while the card is still provisional", () => {
      // 流式暂定卡:分析未核实,追问的「已核实上下文」还不存在——入口要等 CORE_RESULT。
      const { renderer } = setup();
      renderer.renderCoreStream("s1", "b1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]);
      expect(document.querySelector(".english-syntax-chat-ask")).toBeNull();
    });

    it("renders the bubble icon at the head of core-success sentences (Chrome parity)", () => {
      const { renderer } = setup();
      renderer.renderCoreResult(
        "s1",
        "b1",
        corePayload("s1", [
          { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        ]),
      );

      const sentence = document.querySelector(".english-syntax-sentence");
      const ask = sentence?.querySelector<HTMLElement>(".english-syntax-chat-ask");
      expect(ask).not.toBeNull();
      expect(ask?.tagName).toBe("BUTTON");
      // 句头第一个子元素(在成分按钮之前,Chrome 端 sentenceElement.append(createChatAsk) 同款)。
      expect(sentence?.firstElementChild).toBe(ask);
      // 无文字:可发现性由 title/aria 承载;SVG 气泡对屏幕阅读器隐藏。
      expect(ask?.textContent).toBe("");
      expect(ask?.getAttribute("aria-label")).toBe("追问这句");
      expect(ask?.getAttribute("title")).toBe("追问这句");
      const svg = ask?.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      // 官方主题会压过 stylesheet 的 cursor:内联 pointer + important(成分按钮同款坑)。
      expect(ask?.style.getPropertyValue("cursor")).toBe("pointer");
    });

    it("dispatches a bubbling composed chat-request event; keyboard activation falls back to the button rect", () => {
      const { renderer } = setup();
      renderer.renderCoreResult(
        "s1",
        "b1",
        corePayload("s1", [
          { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        ]),
      );
      const ask = document.querySelector<HTMLElement>(".english-syntax-chat-ask")!;

      const seen: Array<{ detail: unknown; composed: boolean }> = [];
      const listener = (event: Event): void => {
        seen.push({
          detail: (event as CustomEvent).detail,
          composed: event.composed,
        });
      };
      document.addEventListener("english-syntax-chat-request", listener);
      try {
        // 鼠标点击:锚点取真实坐标。
        ask.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 120, clientY: 64 }));
        expect(seen).toEqual([
          { detail: { sentenceId: "s1", anchor: { x: 120, y: 64 } }, composed: true },
        ]);

        // 键盘激活(Enter/Space)的 click 坐标是 0:回落到按钮 rect 右下角。
        const original = HTMLElement.prototype.getBoundingClientRect;
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
          this: HTMLElement,
        ) {
          if (this.classList.contains("english-syntax-chat-ask")) {
            return {
              top: 40, bottom: 56, height: 16, left: 10, right: 26, width: 16, x: 10, y: 40,
              toJSON: () => ({}),
            } as DOMRect;
          }
          return original.call(this);
        });
        ask.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(seen[1]!.detail).toEqual({ sentenceId: "s1", anchor: { x: 26, y: 56 } });
      } finally {
        document.removeEventListener("english-syntax-chat-request", listener);
        vi.restoreAllMocks();
      }
    });

    it("the injected stylesheet ships the chat icon's Chrome-parity visuals (circle, semi-transparent, hover-revealed)", () => {
      // happy-dom 不加载注入样式表,只能按文本钉住(隐藏属性那条 CSS 测试同款)。
      // 少了这组规则的症状:图标带浏览器默认按钮边框/背景,且不会「悬停句区才显现」。
      const css = readFileSync(join(process.cwd(), "src/main/resources/web/preview.css"), "utf8");
      expect(css).toMatch(/\.english-syntax-chat-ask\s*\{/);
      // 20px 圆形最小尺寸 + 默认半透明。
      expect(css).toMatch(/\.english-syntax-chat-ask[^{]*\{[^}]*min-width:\s*20px[^}]*opacity:\s*0\.45/s);
      // 悬停句区(或键盘聚焦)才完全显现。
      expect(css).toMatch(/\.english-syntax-sentence:hover \.english-syntax-chat-ask/);
      expect(css).toMatch(/\.english-syntax-chat-ask:focus-visible/);
    });
  });

  // —— sentenceBlockElement 访问器(追问段落上下文,2026-11-28 spec) ——
  describe("sentenceBlockElement 访问器", () => {
    it("命中已注册句 → 句所在块的原元素;多块各归各", () => {
      const a = paragraph("pa");
      const b = paragraph("pb");
      const renderer = new PreviewRenderer(() => {});
      renderer.registerBlock("b-a", a);
      renderer.registerBlock("b-b", b);
      renderer.registerSentence("b-a", "s-a-0");
      renderer.registerSentence("b-b", "s-b-0");

      expect(renderer.sentenceBlockElement("s-a-0")).toBe(a);
      expect(renderer.sentenceBlockElement("s-b-0")).toBe(b);
    });

    it("未注册句 → null(调用方据此省略 CHAT_ASK 的 surroundings 键)", () => {
      const a = paragraph("pa");
      const renderer = new PreviewRenderer(() => {});
      renderer.registerBlock("b-a", a);
      renderer.registerSentence("b-a", "s-a-0");

      expect(renderer.sentenceBlockElement("s-a-0")).toBe(a);
      expect(renderer.sentenceBlockElement("s-unknown-0")).toBeNull();
      expect(renderer.sentenceBlockElement("never-registered")).toBeNull();
    });

    it("卡片渲染后仍返回原 <p>(不是卡片):追问 current 要匹配候选集里的原段落元素", () => {
      // 原文被卡片替换后原元素只被打上 HIDDEN 属性,DOM 位置与 textContent 都不变;
      // collectContextBlocks 的候选集收录的正是原元素——访问器必须返回它而不是卡片。
      const { renderer, element } = setup();
      renderer.renderCoreResult(
        "s1",
        "b1",
        corePayload("s1", [
          { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        ]),
      );
      const card = document.querySelector("[data-english-syntax-card]");
      expect(card).not.toBeNull();

      const current = renderer.sentenceBlockElement("s1");
      expect(current).toBe(element);
      expect(current).not.toBe(card);
      // 与 currentElement(卡片优先)的语义刻意不同:那是打标记用的「当前呈现元素」。
      expect(renderer.currentElement("b1")).toBe(card);
    });
  });

  describe("F2 内联纠正输入行", () => {
    const TOKENS = [
      { id: 0, text: "Classify", leadingWhitespace: "", punctuation: false },
      { id: 1, text: "the", leadingWhitespace: " ", punctuation: false },
      { id: 2, text: "request", leadingWhitespace: " ", punctuation: false },
      { id: 3, text: ".", leadingWhitespace: "", punctuation: true },
    ];

    function setupFeedback(): {
      renderer: PreviewRenderer;
      element: HTMLElement;
      feedbackRequests: Array<[string, string]>;
    } {
      const element = paragraph("p1");
      const feedbackRequests: Array<[string, string]> = [];
      const renderer = new PreviewRenderer(
        () => {},
        (sentenceId, feedback) => {
          feedbackRequests.push([sentenceId, feedback]);
        },
      );
      renderer.registerBlock("b1", element);
      renderer.registerSentence("b1", "s1");
      return { renderer, element, feedbackRequests };
    }

    /**
     * 成功句 → 详解失败（A9 quirk）：`renderCoreError` 会把 analysis 置 null，但
     * Kotlin 侧 record.core 仍在——「曾有 core」标志必须在置 null 前捕获，纠正入口
     * （「纠正」按钮）据此保留。
     */
    function hadCoreFailure(renderer: PreviewRenderer): void {
      renderer.renderCoreResult(
        "s1",
        "b1",
        corePayload("s1", [
          { startToken: 0, endToken: 2, role: "OBJECT", translation: "分类请求", text: "Classify the request" },
        ]),
        TOKENS,
      );
      renderer.renderCoreError("s1", "b1", "DETAIL_FAILED", "detail request failed", TOKENS);
    }

    function openRow(renderer: PreviewRenderer): {
      row: HTMLElement;
      textarea: HTMLTextAreaElement;
      submit: HTMLButtonElement;
      cancel: HTMLButtonElement;
    } {
      renderer.openCorrection("s1");
      const row = document.querySelector<HTMLElement>(".english-syntax-feedback");
      if (row === null) throw new Error("correction row not rendered");
      return {
        row,
        textarea: row.querySelector<HTMLTextAreaElement>(".english-syntax-feedback-input")!,
        submit: row.querySelector<HTMLButtonElement>(".english-syntax-feedback-submit")!,
        cancel: row.querySelector<HTMLButtonElement>(".english-syntax-feedback-cancel")!,
      };
    }

    it("renders the 纠正 button next to 重新解析 on a had-core failure row (detail-failure quirk)", () => {
      const { renderer } = setupFeedback();
      hadCoreFailure(renderer);

      const failure = document.querySelector(".english-syntax-sentence-failure");
      expect(failure).not.toBeNull();
      const retry = failure?.querySelector<HTMLButtonElement>(".english-syntax-retry");
      const correct = failure?.querySelector<HTMLButtonElement>(".english-syntax-correct");
      expect(retry).not.toBeNull();
      expect(correct).not.toBeNull();
      expect(correct?.textContent).toBe("纠正");
      // 「重新解析」旁：纠正按钮紧跟其后。
      expect(correct?.previousElementSibling).toBe(retry);
    });

    it("renders no 纠正 button for a sentence that never had core (fresh core failure)", () => {
      // 纠正以 Kotlin 侧仍在的 record.core 为底稿——全新 core 失败没有可纠正的划分，
      // 不设入口（想纠正先「重新解析」拿到核实划分）。
      const { renderer } = setupFeedback();
      renderer.renderCoreError("s1", "b1", "INVALID_MODEL_OUTPUT", "bad json", TOKENS);

      expect(document.querySelector(".english-syntax-retry")).not.toBeNull();
      expect(document.querySelector(".english-syntax-correct")).toBeNull();
      // 直接调 API 也是 no-op。
      renderer.openCorrection("s1");
      expect(document.querySelector(".english-syntax-feedback")).toBeNull();
    });

    it("纠正 button dispatches a bubbling composed correction-open event (chat icon precedent)", () => {
      const { renderer } = setupFeedback();
      hadCoreFailure(renderer);
      const correct = document.querySelector<HTMLElement>(".english-syntax-correct")!;

      const seen: Array<{ detail: unknown; composed: boolean }> = [];
      const listener = (event: Event): void => {
        seen.push({ detail: (event as CustomEvent).detail, composed: event.composed });
      };
      document.addEventListener(CORRECTION_OPEN_EVENT, listener);
      try {
        correct.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(seen).toEqual([{ detail: { sentenceId: "s1" }, composed: true }]);
      } finally {
        document.removeEventListener(CORRECTION_OPEN_EVENT, listener);
      }
    });

    it("openCorrection inserts an inline row below the card; submit sends trimmed feedback and disables the row", () => {
      const { renderer, feedbackRequests } = setupFeedback();
      hadCoreFailure(renderer);

      const { row, textarea, submit, cancel } = openRow(renderer);
      // 句卡下方：行挂在卡片元素正后方，不在被整卡重建的卡片里。
      expect(row.previousElementSibling?.hasAttribute("data-english-syntax-card")).toBe(true);
      expect(textarea.getAttribute("maxlength")).toBe("2000");
      expect(submit.textContent).toBe("提交");
      expect(cancel.textContent).toBe("取消");

      // 空白反馈不提交（Kotlin parse 门同样拒收）。
      textarea.value = "   ";
      submit.click();
      expect(feedbackRequests).toHaveLength(0);

      textarea.value = "  of applications 应是定语不是状语  ";
      submit.click();
      expect(feedbackRequests).toEqual([["s1", "of applications 应是定语不是状语"]]);
      // 等待中禁用（输入与两个按钮全部冻结）。
      expect(textarea.disabled).toBe(true);
      expect(submit.disabled).toBe(true);
      expect(cancel.disabled).toBe(true);
      expect(submit.textContent).toBe("提交中…");
    });

    it("over-limit feedback (maxlength bypassed via direct value) stays editable and sends nothing", () => {
      // 防御路径：maxlength 只是 UI 缓冲，直接改 textarea.value 可绕过。上限守卫必须在
      // #submitCorrection 进 waiting 前拒绝——若只靠 bootstrap 回调的静默 return 兜底，
      // 行已全禁用且永无 FEEDBACK_ERROR 回来，等于自己把自己锁死。
      const { renderer, feedbackRequests } = setupFeedback();
      hadCoreFailure(renderer);
      const { textarea, submit, cancel } = openRow(renderer);

      textarea.value = "x".repeat(MAX_FEEDBACK_CHARACTERS + 1);
      submit.click();
      expect(feedbackRequests).toHaveLength(0);
      // 仍可编辑：未进入等待态，草稿保留。
      expect(textarea.disabled).toBe(false);
      expect(submit.disabled).toBe(false);
      expect(cancel.disabled).toBe(false);
      expect(submit.textContent).toBe("提交");

      // 收回上限内后照常提交（守卫不吞合法输入）。
      textarea.value = "x".repeat(MAX_FEEDBACK_CHARACTERS);
      submit.click();
      expect(feedbackRequests).toEqual([["s1", "x".repeat(MAX_FEEDBACK_CHARACTERS)]]);
    });

    it("Enter submits and Shift+Enter keeps the newline (chat composer parity)", () => {
      const { renderer, feedbackRequests } = setupFeedback();
      hadCoreFailure(renderer);
      const { textarea } = openRow(renderer);

      textarea.value = "划分不对";
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expect(feedbackRequests).toEqual([["s1", "划分不对"]]);

      textarea.value = "换个描述";
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
      );
      expect(feedbackRequests).toHaveLength(1);
    });

    it("FEEDBACK_ERROR shows the message in the row, leaves the card untouched, and stays retryable", () => {
      const { renderer, feedbackRequests } = setupFeedback();
      hadCoreFailure(renderer);
      const { row, textarea, submit } = openRow(renderer);
      textarea.value = "划分不对";
      submit.click();

      const failureErrorBefore = document.querySelector(".english-syntax-error")?.textContent;
      renderer.renderFeedbackError(
        "s1",
        "INVALID_MODEL_OUTPUT：Model output remained invalid after one repair: sentences[0].components[1].role: must be a known grammar role",
      );

      // 错误就地显示在输入行（F1 口径：INVALID_MODEL_OUTPUT 显示真实 summary）。
      const rowError = row.querySelector(".english-syntax-feedback-error");
      expect(rowError?.textContent).toContain("Model output remained invalid after one repair");
      expect(rowError?.textContent).toContain("must be a known grammar role");
      // 卡片不动：失败行仍是原来的详解失败文案，没有被失败重画（had-core 句的重画会
      // 抹掉仍在 Kotlin 侧的核实划分）。
      expect(document.querySelector(".english-syntax-error")?.textContent).toBe(failureErrorBefore);
      expect(document.querySelectorAll(".english-syntax-sentence-failure")).toHaveLength(1);
      // 输入恢复、草稿保留、可重试。
      expect(textarea.disabled).toBe(false);
      expect(submit.disabled).toBe(false);
      expect(textarea.value).toBe("划分不对");
      expect(submit.textContent).toBe("提交");

      textarea.value = "再描述一次";
      submit.click();
      expect(feedbackRequests).toHaveLength(2);
      expect(feedbackRequests[1]).toEqual(["s1", "再描述一次"]);
    });

    it("ignores FEEDBACK_ERROR for other sentences or before any submit", () => {
      const { renderer } = setupFeedback();
      hadCoreFailure(renderer);
      const { row, textarea, submit } = openRow(renderer);
      const errorSlot = (): { hidden: boolean; text: string } => {
        const slot = row.querySelector<HTMLElement>(".english-syntax-feedback-error");
        return { hidden: slot === null || slot.hidden === true, text: slot?.textContent ?? "" };
      };

      // 未提交（editing）时到达的错误与本轮无关：不显示、不打断输入。
      renderer.renderFeedbackError("s1", "early");
      expect(errorSlot()).toEqual({ hidden: true, text: "" });
      expect(textarea.disabled).toBe(false);

      textarea.value = "划分不对";
      submit.click();
      // 其他句子的错误不影响本行：仍在等待。
      renderer.renderFeedbackError("s-other", "boom");
      expect(errorSlot()).toEqual({ hidden: true, text: "" });
      expect(textarea.disabled).toBe(true);
    });

    it("a late FEEDBACK_ERROR after the row closed is harmless", () => {
      const { renderer } = setupFeedback();
      hadCoreFailure(renderer);
      const { cancel } = openRow(renderer);
      cancel.click();
      expect(document.querySelector(".english-syntax-feedback")).toBeNull();

      expect(() => renderer.renderFeedbackError("s1", "late")).not.toThrow();
      expect(document.querySelector(".english-syntax-feedback")).toBeNull();
    });

    it("CORE_RESULT for the corrected sentence re-renders the card and removes the row", () => {
      const { renderer, feedbackRequests } = setupFeedback();
      hadCoreFailure(renderer);
      const { textarea, submit } = openRow(renderer);
      textarea.value = "划分不对";
      submit.click();

      renderer.renderCoreResult(
        "s1",
        "b1",
        corePayload("s1", [
          { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
        ]),
        TOKENS,
      );

      expect(document.querySelector(".english-syntax-feedback")).toBeNull();
      // 既有重画路径：成功卡片的成分照常渲染。
      expect(document.querySelectorAll(".english-syntax-component").length).toBeGreaterThan(0);
      expect(feedbackRequests).toHaveLength(1);
    });

    it("keeps the open row (with draft) across sibling repaints — the row does not live in the rebuilt card", () => {
      // 输入行的存续只依赖 renderer 状态，兄弟句消息触发的整卡重建既不能吞掉行、
      // 也不能丢草稿（失败行自身已从 record 持久状态渲染，重画不丢——见上方
      // "failure row survives sibling repaints"）。
      const { renderer } = setupFeedback();
      renderer.registerSentence("b1", "s2");
      hadCoreFailure(renderer);
      const { textarea } = openRow(renderer);
      textarea.value = "翻译不对";

      renderer.renderCoreStream("s2", "b1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务", text: "The service" },
      ]);

      const row = document.querySelector<HTMLElement>(".english-syntax-feedback");
      expect(row).not.toBeNull();
      expect(row?.querySelector<HTMLTextAreaElement>(".english-syntax-feedback-input")?.value).toBe("翻译不对");
    });

    it("取消 closes the row; openCorrection no-ops for unknown sentences", () => {
      const { renderer } = setupFeedback();
      hadCoreFailure(renderer);
      const { cancel } = openRow(renderer);
      cancel.click();
      expect(document.querySelector(".english-syntax-feedback")).toBeNull();

      renderer.openCorrection("unknown");
      expect(document.querySelector(".english-syntax-feedback")).toBeNull();
    });

    it("restoreAll and block re-registration drop the open row", () => {
      const { renderer, element } = setupFeedback();
      hadCoreFailure(renderer);
      openRow(renderer);
      expect(document.querySelector(".english-syntax-feedback")).not.toBeNull();

      renderer.restoreAll();
      expect(document.querySelector(".english-syntax-feedback")).toBeNull();

      // 重新注册同块（换代重扫）：行随旧句子作废，不会悬在新卡上。
      hadCoreFailure(renderer);
      renderer.openCorrection("s1");
      expect(document.querySelector(".english-syntax-feedback")).not.toBeNull();
      renderer.registerBlock("b1", element);
      expect(document.querySelector(".english-syntax-feedback")).toBeNull();
    });

    it("the injected stylesheet ships the correction button and inline row visuals (chat vocabulary)", () => {
      // happy-dom 不加载注入样式表，只能按文本钉住（隐藏属性/chat 图标 CSS 测试同款）。
      const css = readFileSync(join(process.cwd(), "src/main/resources/web/preview.css"), "utf8");
      expect(css).toMatch(/\.english-syntax-correct\s*\{/);
      expect(css).toMatch(/\.english-syntax-feedback\s*\{/);
      expect(css).toMatch(/\.english-syntax-feedback-input\s*\{/);
      // 错误就地显示沿用 chat 错误气泡的视觉语汇。
      expect(css).toMatch(/\.english-syntax-feedback-error\s*\{/);
      // 深色主题有对应覆盖（chat 面板同款考虑，否则暗色页上一块白补丁）。
      expect(css).toMatch(/\[data-english-syntax-dark="true"\][^{]*\.english-syntax-feedback\s*\{/);
    });
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

  // —— 面板内下钻(Task 1) ——
  const drillTokens = [
    { id: 0, text: "The", leadingWhitespace: "", punctuation: false },
    { id: 1, text: "service", leadingWhitespace: " ", punctuation: false },
    { id: 2, text: "validates", leadingWhitespace: " ", punctuation: false },
    { id: 3, text: "everything", leadingWhitespace: " ", punctuation: false },
  ];

  function detailPayload(
    sentenceId: string,
    startToken: number,
    endToken: number,
    structures: Array<{ startToken: number; endToken: number; role: string; explanation: string }>,
    explanation: string,
  ) {
    return { sentenceId, focus: { startToken, endToken }, structures, grammarPoints: [], explanation };
  }

  function clickComponent(startToken: number, endToken: number): void {
    clickComponentFor("s1", startToken, endToken);
  }

  function clickComponentFor(sentenceId: string, startToken: number, endToken: number): void {
    document
      .querySelector<HTMLButtonElement>(
        `.english-syntax-sentence[data-sentence-id="${sentenceId}"] .english-syntax-component[data-start-token="${startToken}"][data-end-token="${endToken}"]`,
      )
      ?.click();
  }

  function drillSetup() {
    const subject = setup();
    subject.renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "校验" },
      ]),
      drillTokens,
    );
    return subject;
  }

  it("完整渲染的详解标注是按钮,点击以子结构区间再次请求详解并回到 loading", () => {
    const { renderer, detailRequests } = drillSetup();
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
        { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
      ], "父级详解"),
    );

    const annotations = [...document.querySelectorAll<HTMLElement>(".english-syntax-annotation")];
    expect(annotations).toHaveLength(2);
    // 单 token 子结构也是按钮:单词同样可下钻,无最小词数特判。
    expect(annotations.map((annotation) => annotation.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(annotations[1]!.style.cursor).toContain("pointer");

    annotations[1]!.click();
    expect(detailRequests.at(-1)).toEqual(["s1", 1, 1]);
    expect(document.querySelector(".english-syntax-detail-loading")).not.toBeNull();
  });

  it("下钻后返回上级纯前端恢复父级;句级关闭与失败行都清空返回栈", () => {
    const { renderer, detailRequests } = drillSetup();
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
        { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
      ], "父级详解"),
    );

    const drillIntoChild = () => {
      document.querySelectorAll<HTMLElement>(".english-syntax-annotation")[1]!.click();
      renderer.renderDetailResult(
        detailPayload("s1", 1, 1, [
          { startToken: 1, endToken: 1, role: "名词", explanation: "中心词" },
        ], "子级详解"),
      );
    };
    drillIntoChild();
    const back = document.querySelector<HTMLButtonElement>(".english-syntax-detail-back");
    expect(back?.textContent).toBe("← 返回上级");
    expect(document.querySelector(".english-syntax-detail")?.textContent).toContain("子级详解");

    // 返回是纯前端:面板回父级内容,不产生新请求。
    const requestsBeforeBack = detailRequests.length;
    back!.click();
    expect(document.querySelector(".english-syntax-detail")?.textContent).toContain("父级详解");
    expect(document.querySelector(".english-syntax-detail-back")).toBeNull();
    expect(detailRequests.length).toBe(requestsBeforeBack);

    // 句级 toggle 关闭(点同句成分)清栈:重开详解不再有返回按钮。
    drillIntoChild();
    clickComponent(2, 3); // 面板开着时点同句成分 = 既有句级关闭语义
    expect(document.querySelector(".english-syntax-detail")).toBeNull();
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 1, role: "名词短语", explanation: "整体" },
      ], "重新打开的详解"),
    );
    expect(document.querySelector(".english-syntax-detail-back")).toBeNull();

    // 失败行(CORE_ERROR)清栈:详解失败把句子打成失败行,面板消失后重开同样无返回按钮。
    clickComponent(2, 3); // 先关掉上一段遗留的面板(句级 toggle)
    expect(document.querySelector(".english-syntax-detail")).toBeNull();
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
        { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
      ], "父级详解"),
    );
    drillIntoChild();
    renderer.renderCoreError("s1", "b1", "DETAIL_FAILED", "详解失败", drillTokens);
    expect(document.querySelector(".english-syntax-detail")).toBeNull();
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "校验" },
      ]),
      drillTokens,
    );
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 1, role: "名词短语", explanation: "整体" },
      ], "失败行之后的详解"),
    );
    expect(document.querySelector(".english-syntax-detail-back")).toBeNull();
  });

  it("流式预览的标注是纯 span 且无 pointer 光标", () => {
    const { renderer } = drillSetup();
    clickComponent(0, 1);
    renderer.renderDetailStream("s1", 0, 1, [
      { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
      { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
    ]);

    const annotations = [...document.querySelectorAll<HTMLElement>(".english-syntax-annotation")];
    expect(annotations.map((annotation) => annotation.tagName)).toEqual(["SPAN", "SPAN"]);
    for (const annotation of annotations) {
      expect(annotation.style.cursor).not.toContain("pointer");
    }
  });

  it("晚到的详解响应不得重开已关闭的面板、不得覆盖返回后的父级、不得顶掉切换中的新焦点", () => {
    const { renderer } = drillSetup();
    const parentDetail = () =>
      renderer.renderDetailResult(
        detailPayload("s1", 0, 1, [
          { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
          { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
        ], "父级详解"),
      );

    // 关闭后:面板被句级 toggle 关掉,晚到的 DETAIL_RESULT 不得重开。
    clickComponent(0, 1);
    clickComponent(2, 3); // 面板开着(loading)时点同句成分 = 句级关闭
    expect(document.querySelector(".english-syntax-detail")).toBeNull();
    parentDetail();
    expect(document.querySelector(".english-syntax-detail")).toBeNull();

    // 返回后:面板回到父级,晚到的子级响应不得把内容跳回去。
    clickComponent(0, 1);
    parentDetail();
    document.querySelectorAll<HTMLElement>(".english-syntax-annotation")[1]!.click();
    renderer.renderDetailResult(
      detailPayload("s1", 1, 1, [{ startToken: 1, endToken: 1, role: "名词", explanation: "中心词" }], "子级详解"),
    );
    document.querySelector<HTMLButtonElement>(".english-syntax-detail-back")!.click();
    expect(document.querySelector(".english-syntax-detail")?.textContent).toContain("父级详解");
    renderer.renderDetailResult(
      detailPayload("s1", 1, 1, [{ startToken: 1, endToken: 1, role: "名词", explanation: "晚到" }], "晚到的子级详解"),
    );
    expect(document.querySelector(".english-syntax-detail")?.textContent).toContain("父级详解");
    expect(document.querySelector(".english-syntax-detail")?.textContent).not.toContain("晚到的子级详解");

    // 跨句切换中:s2 的 loading 在等,s1 的晚到响应不得把面板拉回 s1。
    renderer.registerSentence("b1", "s2");
    renderer.renderCoreResult(
      "s2",
      "b1",
      corePayload("s2", [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "第二句" }]),
      drillTokens,
    );
    clickComponentFor("s2", 0, 1);
    expect(document.querySelector(".english-syntax-detail-loading")).not.toBeNull();
    renderer.renderDetailResult(
      detailPayload("s1", 2, 3, [{ startToken: 2, endToken: 3, role: "谓语", explanation: "x" }], "晚到的 s1 详解"),
    );
    // 面板仍停在 s2 的 loading,s1 的晚到结果被丢弃。
    expect(document.querySelector(".english-syntax-detail-loading")).not.toBeNull();
    expect(document.querySelector(".english-syntax-detail")?.textContent).not.toContain("晚到的 s1 详解");
  });

  it("被守卫丢弃的晚到响应不得污染返回栈:关闭/返回后重开或再下钻都恢复正确层级", () => {
    const { renderer } = drillSetup();
    const parent = () =>
      renderer.renderDetailResult(
        detailPayload("s1", 0, 1, [
          { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
          { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
        ], "父级详解"),
      );

    // 关闭 → 晚到的 DETAIL_RESULT 到达(被守卫丢弃)→ 重开新详解:不得带返回按钮。
    clickComponent(0, 1);
    parent();
    clickComponent(2, 3); // 句级关闭
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [{ startToken: 0, endToken: 1, role: "名词短语", explanation: "x" }], "晚到的父级"),
    );
    expect(document.querySelector(".english-syntax-detail")).toBeNull();
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 0, role: "限定词", explanation: "整体" },
        { startToken: 1, endToken: 1, role: "名词", explanation: "重开" },
      ], "重新打开的详解"),
    );
    expect(document.querySelector(".english-syntax-detail")?.textContent).toContain("重新打开的详解");
    expect(document.querySelector(".english-syntax-detail-back")).toBeNull();

    // 返回父级 → 晚到的子级响应到达(被守卫丢弃)→ 再下钻孙级 → 返回必须回到父级(不是子级)。
    const drillChild = () => {
      document.querySelectorAll<HTMLElement>(".english-syntax-annotation")[1]!.click();
      renderer.renderDetailResult(
        detailPayload("s1", 1, 1, [{ startToken: 1, endToken: 1, role: "名词", explanation: "中心词", text: "service" }], "子级详解"),
      );
    };
    drillChild();
    document.querySelector<HTMLButtonElement>(".english-syntax-detail-back")!.click();
    expect(document.querySelector(".english-syntax-detail")?.textContent).toContain("重新打开的详解");
    renderer.renderDetailResult(
      detailPayload("s1", 1, 1, [{ startToken: 1, endToken: 1, role: "名词", explanation: "晚到" }], "晚到的子级详解"),
    );
    // 晚到被丢弃后下钻孙级:栈顶应是父级,返回直达父级。
    document.querySelectorAll<HTMLElement>(".english-syntax-annotation")[1]!.click();
    renderer.renderDetailResult(
      detailPayload("s1", 1, 1, [{ startToken: 1, endToken: 1, role: "名词", explanation: "孙级" }], "孙级详解"),
    );
    document.querySelector<HTMLButtonElement>(".english-syntax-detail-back")!.click();
    expect(document.querySelector(".english-syntax-detail")?.textContent).toContain("重新打开的详解");
  });

  it("标注按钮的子元素同样带内联 pointer:悬停标签文字不得出现非 pointer 光标", () => {
    const { renderer } = drillSetup();
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
        { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
      ], "父级详解"),
    );
    const annotation = document.querySelector<HTMLButtonElement>(".english-syntax-annotation")!;
    const children = [...annotation.querySelectorAll<HTMLElement>("*")];
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.style.cursor).toContain("pointer");
    }
  });

  it("跨句新开详解不压栈:返回按钮不得跨句复活", () => {
    const { renderer } = drillSetup();
    renderer.registerSentence("b1", "s2");
    renderer.renderCoreResult(
      "s2",
      "b1",
      corePayload("s2", [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "第二句" }]),
      drillTokens,
    );
    // s1 开面板(父级)
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
        { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
      ], "s1 的详解"),
    );
    // 直接点 s2 的成分(跨句新开,不是下钻):s2 面板不得带返回按钮。
    clickComponentFor("s2", 0, 1);
    renderer.renderDetailResult(
      detailPayload("s2", 0, 1, [{ startToken: 0, endToken: 1, role: "主语", explanation: "x" }], "s2 的详解"),
    );
    expect(document.querySelector(".english-syntax-detail")?.textContent).toContain("s2 的详解");
    expect(document.querySelector(".english-syntax-detail-back")).toBeNull();
  });

  it("RESTORE_ALL 与兄弟句重画销毁面板后,重开详解不残留返回栈", () => {
    const { renderer } = drillSetup();
    // 下钻一层(栈=[父级])
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
        { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
      ], "父级详解"),
    );
    document.querySelectorAll<HTMLElement>(".english-syntax-annotation")[1]!.click();
    renderer.renderDetailResult(
      detailPayload("s1", 1, 1, [{ startToken: 1, endToken: 1, role: "名词", explanation: "中心词" }], "子级详解"),
    );
    expect(document.querySelector(".english-syntax-detail-back")).not.toBeNull();

    // 兄弟句 CORE_RESULT 整卡重画:面板随卡片销毁,栈必须一并清空。
    renderer.registerSentence("b1", "s2");
    renderer.renderCoreResult(
      "s2",
      "b1",
      corePayload("s2", [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "第二句" }]),
      drillTokens,
    );
    expect(document.querySelector(".english-syntax-detail")).toBeNull();
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [{ startToken: 0, endToken: 1, role: "名词短语", explanation: "整体" }], "重开详解"),
    );
    expect(document.querySelector(".english-syntax-detail-back")).toBeNull();

    // RESTORE_ALL(停止/恢复原文)后同样清空。
    clickComponent(2, 3); // 句级关闭
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [
        { startToken: 0, endToken: 0, role: "限定词", explanation: "特指标记" },
        { startToken: 1, endToken: 1, role: "名词中心", explanation: "短语中心词" },
      ], "父级详解"),
    );
    document.querySelectorAll<HTMLElement>(".english-syntax-annotation")[1]!.click();
    renderer.renderDetailResult(
      detailPayload("s1", 1, 1, [{ startToken: 1, endToken: 1, role: "名词", explanation: "中心词" }], "子级详解"),
    );
    renderer.restoreAll();
    clickComponent(0, 1);
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该服务" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "校验" },
      ]),
      drillTokens,
    );
    clickComponent(0, 1);
    renderer.renderDetailResult(
      detailPayload("s1", 0, 1, [{ startToken: 0, endToken: 1, role: "名词短语", explanation: "整体" }], "停止后重开详解"),
    );
    expect(document.querySelector(".english-syntax-detail-back")).toBeNull();
  });
});

// ---- 朗读：三层喇叭（句头整句 / 面板条目 / 面板焦点），Chrome 端同款语义 ----

function speakSetup(sentences: string[] = ["s1"]) {
  const speaks: Array<[string, string]> = [];
  const stops: number[] = [];
  const renderer = new PreviewRenderer(
    () => {},
    () => {},
    {
      speak: (sentenceId: string, text: string) => speaks.push([sentenceId, text]),
      stop: () => stops.push(stops.length),
    },
  );
  const element = paragraph("speak-p1");
  renderer.registerBlock("b1", element);
  for (const sentenceId of sentences) renderer.registerSentence("b1", sentenceId);
  const tokens = [
    { id: 0, text: "Learners", start: 0, end: 8, leadingWhitespace: "", punctuation: false },
    { id: 1, text: "read", start: 9, end: 13, leadingWhitespace: " ", punctuation: false },
    { id: 2, text: "books", start: 14, end: 19, leadingWhitespace: " ", punctuation: false },
    { id: 3, text: ".", start: 19, end: 20, leadingWhitespace: "", punctuation: true },
  ];
  for (const sentenceId of sentences) {
    renderer.renderCoreResult(
      sentenceId,
      "b1",
      corePayload(sentenceId, [
        { startToken: 0, endToken: 2, role: "SUBJECT", translation: "学习者们", text: "Learners read books" },
      ]),
      tokens,
    );
  }
  return { renderer, speaks, stops };
}

describe("PreviewRenderer 朗读", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function clickComponentFor(sentenceId: string, startToken: number, endToken: number): void {
    document
      .querySelector<HTMLButtonElement>(
        `.english-syntax-sentence[data-sentence-id="${sentenceId}"] .english-syntax-component[data-start-token="${startToken}"][data-end-token="${endToken}"]`,
      )
      ?.click();
  }

  it("句头喇叭在追问按钮之后,失败句不出现;点击朗读整句(尾标点省略)并置按下态", () => {
    const { speaks } = speakSetup(["s1"]);
    const sentence = document.querySelector(".english-syntax-sentence");
    const ask = sentence?.querySelector<HTMLElement>(".english-syntax-chat-ask");
    const speak = sentence?.querySelector<HTMLButtonElement>("[data-english-syntax-speak]");
    expect(speak).not.toBeNull();
    expect(ask?.nextElementSibling).toBe(speak);
    expect(speak?.getAttribute("aria-label")).toBe("朗读这句");
    speak?.click();
    expect(speaks).toEqual([["s1", "Learners read books"]]);
    expect(speak?.getAttribute("aria-pressed")).toBe("true");
  });

  it("按下时再点同一喇叭=停;点另一句喇叭=接管且不发 stop", () => {
    const { speaks, stops } = speakSetup(["s1", "s2"]);
    const buttons = document.querySelectorAll<HTMLButtonElement>("[data-english-syntax-speak]");
    const first = buttons[0]!;
    const second = buttons[1]!;
    first.click();
    second.click();
    expect(speaks).toHaveLength(2);
    expect(stops).toHaveLength(0);
    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(second.getAttribute("aria-pressed")).toBe("true");
    second.click();
    expect(stops).toHaveLength(1);
    expect(second.getAttribute("aria-pressed")).toBe("false");
  });

  it("面板条目有兄弟喇叭读 structure 文本;流式预览不挂", () => {
    const { renderer, speaks } = speakSetup(["s1"]);
    clickComponentFor("s1", 0, 2);
    renderer.renderDetailStream("s1", 0, 2, [
      { startToken: 0, endToken: 1, role: "主语", explanation: "名词", text: "Learners" },
    ]);
    // 流式:wrapper 内是纯 span,无喇叭。
    let item = document.querySelector(".english-syntax-annotation-item");
    expect(item?.querySelector(".english-syntax-annotation")?.tagName).toBe("SPAN");
    expect(item?.querySelector("[data-english-syntax-speak]")).toBeNull();

    renderer.renderDetailResult({
      sentenceId: "s1",
      focus: { startToken: 0, endToken: 2 },
      structures: [
        { startToken: 0, endToken: 1, role: "主语", explanation: "名词", text: "Learners" },
        { startToken: 1, endToken: 2, role: "谓语", explanation: "动宾", text: " read books" },
      ],
      grammarPoints: [],
      explanation: "整体说明",
    } as never);
    const items = document.querySelectorAll(".english-syntax-annotation-item");
    expect(items).toHaveLength(2);
    for (const item of items) {
      const annotation = item.querySelector(".english-syntax-annotation");
      expect(annotation?.querySelector("button")).toBeNull();
      expect(item.querySelector("[data-english-syntax-speak]")).not.toBeNull();
    }
    (items[0]!.querySelector("[data-english-syntax-speak]") as HTMLButtonElement).click();
    expect(speaks[0]?.[1]).toBe("Learners");
  });

  it("面板焦点喇叭读当前详解区间文本", () => {
    const { renderer, speaks } = speakSetup(["s1"]);
    clickComponentFor("s1", 0, 2);
    renderer.renderDetailResult({
      sentenceId: "s1",
      focus: { startToken: 0, endToken: 2 },
      structures: [{ startToken: 0, endToken: 2, role: "整体", explanation: "短语", text: "whatever" }],
      grammarPoints: [],
      explanation: "说明",
    } as never);
    const focusSpeak = document.querySelector<HTMLButtonElement>(".english-syntax-detail > [data-english-syntax-speak]");
    expect(focusSpeak?.getAttribute("aria-label")).toBe("朗读所选成分");
    focusSpeak?.click();
    // 焦点文本按 tokens 区间重建(尾标点省略),不用 structure.text。
    expect(speaks[0]?.[1]).toBe("Learners read books");
  });

  it("整句文本超过 2000 字符时不挂句头喇叭", () => {
    const speaks: Array<[string, string]> = [];
    const renderer = new PreviewRenderer(() => {}, () => {}, {
      speak: (sentenceId: string, text: string) => speaks.push([sentenceId, text]),
      stop: () => {},
    });
    const element = paragraph("speak-long");
    renderer.registerBlock("b1", element);
    renderer.registerSentence("b1", "s1");
    const longText = `${"word ".repeat(500)}end`;
    renderer.renderCoreResult(
      "s1",
      "b1",
      corePayload("s1", [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "长句", text: longText },
      ]),
      [{ id: 0, text: longText, start: 0, end: longText.length, leadingWhitespace: "", punctuation: false }],
    );
    expect(document.querySelector("[data-english-syntax-speak]")).toBeNull();
  });

  it("speakFailed 复位该句按下态", () => {
    const { renderer } = speakSetup(["s1"]);
    const speak = document.querySelector<HTMLButtonElement>("[data-english-syntax-speak]")!;
    speak.click();
    expect(speak.getAttribute("aria-pressed")).toBe("true");
    renderer.speakFailed("s1");
    expect(speak.getAttribute("aria-pressed")).toBe("false");
  });

  it("未提供朗读回调时整卡不渲染喇叭", () => {
    const renderer = new PreviewRenderer(() => {});
    const element = paragraph("speak-none");
    renderer.registerBlock("b1", element);
    renderer.registerSentence("b1", "s1");
    renderer.renderCoreResult("s1", "b1", corePayload("s1", [
      { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主", text: "It works" },
    ]));
    expect(document.querySelector("[data-english-syntax-speak]")).toBeNull();
  });
});

// ---- INVALID_MODEL_OUTPUT 失败行不给「纠正」入口(格式错误无从纠正,对齐 Chrome 裁决) ----

describe("PreviewRenderer 纠正入口与格式错误", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function failureSetup(code: string): void {
    const renderer = new PreviewRenderer(() => {});
    const element = document.createElement("p");
    element.textContent = "The service validates every response.";
    document.body.append(element);
    renderer.registerBlock("b1", element);
    renderer.registerSentence("b1", "s1");
    renderer.renderCoreResult("s1", "b1", corePayload("s1", [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "主", text: "The service" },
    ]));
    // 详解失败 quirk:core 已核实后整句被打成失败行。
    renderer.renderCoreError("s1", "b1", code, "raw message");
  }

  it("INVALID_MODEL_OUTPUT 的失败行只有重新解析,没有纠正按钮", () => {
    failureSetup("INVALID_MODEL_OUTPUT");
    const failure = document.querySelector(".english-syntax-sentence-failure, [data-sentence-id=\"s1\"]");
    expect(failure?.querySelector(".english-syntax-correct")).toBeNull();
    expect(failure?.querySelector(".english-syntax-retry, button")).not.toBeNull();
  });

  it("其它错误的 hadCore 失败行照常保留纠正入口", () => {
    failureSetup("NETWORK_ERROR");
    const failure = document.querySelector("[data-sentence-id=\"s1\"]");
    expect(failure?.querySelector(".english-syntax-correct")).not.toBeNull();
  });
});
