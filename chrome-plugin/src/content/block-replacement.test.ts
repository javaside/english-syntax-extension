// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_SCHEMA_VERSION } from "../shared/versions";
import { GrammarRole } from "../shared/grammar";
import { SyntaxLearningBlock } from "./learning-block";
import { BlockReplacement } from "./block-replacement";

const sentence = "Learners read.";
const tokens = [
  { id: 0, text: "Learners", start: 0, end: 8, leadingWhitespace: "", punctuation: false },
  { id: 1, text: "read", start: 9, end: 13, leadingWhitespace: " ", punctuation: false },
  { id: 2, text: ".", start: 13, end: 14, leadingWhitespace: "", punctuation: true },
];

function learningBlock(expectedIds: readonly string[]): SyntaxLearningBlock {
  const block = new SyntaxLearningBlock();
  if (expectedIds.length > 0) {
    block.setExpectedSentenceIds(expectedIds);
  }
  return block;
}

function renderReady(block: SyntaxLearningBlock, sentenceId = "sentence-1"): void {
  block.renderCore(sentence, tokens, {
    schemaVersion: CORE_SCHEMA_VERSION,
    sentenceId,
    components: [
      { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" },
      { startToken: 1, endToken: 2, role: GrammarRole.PREDICATE, translation: "阅读" },
    ],
    modelProfileId: "profile-1",
  });
}

describe("BlockReplacement", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.innerHTML =
      '<p class="article-copy emphasized" style="color: purple">Original</p>';
  });

  it("restores the exact original node without changing its class, style, state, or listeners", () => {
    const original = document.querySelector("p")!;
    const originalClass = original.className;
    const originalStyle = original.getAttribute("style");
    const listener = vi.fn();
    original.addEventListener("click", listener);
    const block = learningBlock(["sentence-1"]);
    renderReady(block);
    const replacement = new BlockReplacement();

    replacement.show(original, block);
    expect(original.nextElementSibling).toBe(block.host);
    expect(original.className).toContain("article-copy");
    expect(original.getAttribute("style")).toBe(originalStyle);
    expect(getComputedStyle(original).display).toBe("none");
    expect(original.hidden).toBe(false);

    replacement.restore();
    expect(document.querySelector("p")).toBe(original);
    expect(original.hidden).toBe(false);
    expect(original.className).toBe(originalClass);
    expect(original.getAttribute("style")).toBe(originalStyle);
    original.click();
    expect(listener).toHaveBeenCalledOnce();
    expect(block.isConnected).toBe(false);
  });

  it("restores the page with zero extension nodes even while a detail panel is open", () => {
    const original = document.querySelector("p")!;
    const block = learningBlock(["sentence-1"]);
    renderReady(block);
    const replacement = new BlockReplacement();
    replacement.show(original, block);
    block.setDetailLoading("sentence-1", { startToken: 0, endToken: 0 });
    block.renderDetail({
      sentenceId: "sentence-1",
      focus: { startToken: 0, endToken: 0 },
      structures: [{ startToken: 0, endToken: 0, role: "主语", explanation: "句子的主语" }],
      grammarPoints: [],
      explanation: "详细解析",
      modelProfileId: "profile-1",
    });
    expect(block.host.shadowRoot!.querySelectorAll(".detail")).toHaveLength(1);

    replacement.restore();

    expect(document.querySelector("[data-syntax-learning-block]")).toBeNull();
    expect(document.querySelector("style[data-syntax-learning-hide]")).toBeNull();
    expect(document.querySelector(".detail")).toBeNull();
    expect(getComputedStyle(original).display).not.toBe("none");
  });

  it("leaves no empty class attribute behind on an element that never had one", () => {
    document.body.replaceChildren();
    const original = document.createElement("p");
    original.textContent = "Original without class";
    document.body.append(original);
    expect(original.hasAttribute("class")).toBe(false);
    const block = learningBlock(["sentence-1"]);
    renderReady(block);
    const replacement = new BlockReplacement();

    replacement.show(original, block);
    replacement.restore();

    expect(original.hasAttribute("class")).toBe(false);
    expect(original.outerHTML).toBe("<p>Original without class</p>");
  });

  it("does not insert or hide an empty or partially resolved learning block", () => {
    const original = document.querySelector("p")!;
    const replacement = new BlockReplacement();
    const empty = learningBlock([]);

    replacement.show(original, empty);
    expect(empty.isConnected).toBe(false);
    expect(original.classList.contains(BlockReplacement.hiddenClass)).toBe(false);

    const partial = learningBlock(["sentence-1", "sentence-2"]);
    renderReady(partial);
    replacement.show(original, partial);
    expect(partial.isConnected).toBe(false);
    expect(original.classList.contains(BlockReplacement.hiddenClass)).toBe(false);
  });

  it("rejects a non-learning element at runtime", () => {
    const original = document.querySelector("p")!;
    const replacement = new BlockReplacement();
    const generic = document.createElement("div") as unknown as SyntaxLearningBlock;

    expect(() => replacement.show(original, generic)).toThrow(/SyntaxLearningBlock/u);
    expect(generic.isConnected).toBe(false);
    expect(original.classList.contains(BlockReplacement.hiddenClass)).toBe(false);
  });

  it("inserts and hides a fully ready success block", () => {
    const original = document.querySelector("p")!;
    const originalClasses = [...original.classList];
    const block = learningBlock(["sentence-1"]);
    renderReady(block);
    const replacement = new BlockReplacement();

    replacement.show(original, block);

    expect(original.nextElementSibling).toBe(block.host);
    expect(getComputedStyle(original).display).toBe("none");
    expect(original.classList).toHaveLength(originalClasses.length + 1);
  });

  it("renders every failed sentence as original text before hiding a partially successful block", () => {
    const original = document.querySelector("p")!;
    const block = learningBlock(["sentence-1", "sentence-2"]);
    renderReady(block);
    const replacement = new BlockReplacement();

    replacement.showPartialFailure(original, block, [
      { sentenceId: "sentence-2", sentence: "This sentence stays original.", message: "解析失败" },
    ]);

    const failure = block.host.shadowRoot!.querySelector(".sentence-failure")!;
    expect(failure.textContent).toContain("This sentence stays original.");
    expect(failure.textContent).toContain("解析失败");
    expect(getComputedStyle(original).display).toBe("none");
  });

  it("does not hide when a partial failure has not been represented", () => {
    const original = document.querySelector("p")!;
    const block = learningBlock(["sentence-1", "sentence-2"]);
    renderReady(block);
    const replacement = new BlockReplacement();

    replacement.showPartialFailure(original, block, []);

    expect(original.classList.contains(BlockReplacement.hiddenClass)).toBe(false);
    expect(block.isConnected).toBe(false);
  });

  it("does not hide when one expected failure row is still missing", () => {
    const original = document.querySelector("p")!;
    const block = learningBlock(["sentence-1", "sentence-2", "sentence-3"]);
    renderReady(block);
    const replacement = new BlockReplacement();

    replacement.showPartialFailure(original, block, [
      { sentenceId: "sentence-2", sentence: "Second failed.", message: "解析失败" },
    ]);

    expect(block.host.shadowRoot!.querySelector("[data-sentence-id='sentence-2']")).not.toBeNull();
    expect(original.classList.contains(BlockReplacement.hiddenClass)).toBe(false);
    expect(block.isConnected).toBe(false);
  });

  it("removes the learning sibling when the page removes the original", async () => {
    const original = document.querySelector("p")!;
    const block = learningBlock(["sentence-1"]);
    renderReady(block);
    const replacement = new BlockReplacement();
    replacement.show(original, block);

    original.remove();
    await Promise.resolve();

    expect(block.isConnected).toBe(false);
    expect(replacement.active).toBe(false);
  });

  it("moves cleanly to a new pair and registers one important hiding rule", () => {
    const first = document.querySelector("p")!;
    const firstClass = first.className;
    const firstBlock = learningBlock(["sentence-1"]);
    renderReady(firstBlock);
    const replacement = new BlockReplacement();
    replacement.show(first, firstBlock);
    document.body.insertAdjacentHTML("beforeend", "<p>Second</p>");
    const second = document.querySelectorAll("p")[1]!;
    const secondBlock = learningBlock(["sentence-2"]);
    renderReady(secondBlock, "sentence-2");

    replacement.show(second, secondBlock);

    expect(first.className).toBe(firstClass);
    expect(firstBlock.isConnected).toBe(false);
    expect(document.querySelectorAll(`style[data-syntax-learning-hide]`)).toHaveLength(1);
    expect(document.querySelector("style")!.textContent).toContain("display: none !important");
  });

  it("preserves display, visibility, and exact classes when the original has the default hide class", () => {
    const original = document.querySelector("p")!;
    original.classList.add(BlockReplacement.hiddenClass);
    const originalClass = original.className;
    const display = getComputedStyle(original).display;
    const visibility = getComputedStyle(original).visibility;
    const block = learningBlock(["sentence-1"]);
    renderReady(block);
    const replacement = new BlockReplacement();

    replacement.show(original, block);
    expect(getComputedStyle(original).display).toBe("none");
    expect(
      [...document.querySelectorAll("style[data-syntax-learning-hide]")].every(
        (style) => !style.textContent?.includes(`.${BlockReplacement.hiddenClass} {`),
      ),
    ).toBe(true);
    replacement.restore();

    expect(original.className).toBe(originalClass);
    expect(original.classList.contains(BlockReplacement.hiddenClass)).toBe(true);
    expect(getComputedStyle(original).display).toBe(display);
    expect(getComputedStyle(original).visibility).toBe(visibility);
    expect(document.querySelector("style[data-syntax-learning-hide]")).toBeNull();
  });

  it("owns unique classes and styles so simultaneous replacements restore independently", () => {
    const first = document.querySelector("p")!;
    const second = document.createElement("p");
    second.className = "second-copy";
    second.textContent = "Second original";
    document.body.append(second);
    const firstClass = first.className;
    const secondClass = second.className;
    const firstClasses = new Set(first.classList);
    const secondClasses = new Set(second.classList);
    const firstDisplay = getComputedStyle(first).display;
    const secondDisplay = getComputedStyle(second).display;
    const firstBlock = learningBlock(["sentence-1"]);
    const secondBlock = learningBlock(["sentence-2"]);
    renderReady(firstBlock);
    renderReady(secondBlock, "sentence-2");
    const firstReplacement = new BlockReplacement();
    const secondReplacement = new BlockReplacement();

    firstReplacement.show(first, firstBlock);
    secondReplacement.show(second, secondBlock);

    const firstAddedClass = [...first.classList].find((name) => !firstClasses.has(name));
    const secondAddedClass = [...second.classList].find((name) => !secondClasses.has(name));
    expect(firstAddedClass).toBeDefined();
    expect(secondAddedClass).toBeDefined();
    expect(firstAddedClass).not.toBe(secondAddedClass);
    expect(document.querySelectorAll("style[data-syntax-learning-hide]")).toHaveLength(2);

    firstReplacement.restore();
    expect(first.className).toBe(firstClass);
    expect(getComputedStyle(first).display).toBe(firstDisplay);
    expect(getComputedStyle(second).display).toBe("none");
    expect(document.querySelectorAll("style[data-syntax-learning-hide]")).toHaveLength(1);

    secondReplacement.restore();
    expect(second.className).toBe(secondClass);
    expect(getComputedStyle(second).display).toBe(secondDisplay);
    expect(document.querySelector("style[data-syntax-learning-hide]")).toBeNull();
  });

  it("previews a block whose sentences have not all resolved yet", () => {
    const original = document.querySelector("p")!;
    const block = learningBlock(["sentence-1", "sentence-2"]);
    renderReady(block, "sentence-1");
    const replacement = new BlockReplacement(() => "preview");

    expect(block.isReadyToReplace()).toBe(false);
    replacement.showPreview(original, block);

    expect(replacement.active).toBe(true);
    expect(block.host.isConnected).toBe(true);
  });

  it("refuses to preview a block with nothing rendered at all", () => {
    const original = document.querySelector("p")!;
    const block = learningBlock(["sentence-1"]);
    const replacement = new BlockReplacement(() => "empty");

    replacement.showPreview(original, block);

    expect(replacement.active).toBe(false);
  });

  // 完整结果落地时 finishBlock 会再调 show;若照旧先 restore 再插入，预览会闪一下。
  it("leaves an already displayed block in place instead of tearing it down", () => {
    const original = document.querySelector("p")!;
    const block = learningBlock(["sentence-1"]);
    renderReady(block);
    const replacement = new BlockReplacement(() => "stable");
    replacement.showPreview(original, block);
    const host = block.host;

    replacement.show(original, block);

    expect(block.host).toBe(host);
    expect(host.isConnected).toBe(true);
    expect(replacement.active).toBe(true);
    expect(document.head.querySelectorAll("style[data-syntax-learning-hide]")).toHaveLength(1);
  });
});

/**
 * 卡片插在原元素之后，继承的是父容器字体而不是被替换的那个元素。于是 h2 换成
 * 卡片后掉到正文字号，整篇文章的层级在解析后全部消失。卡片内部用的是 em 相对
 * 单位，所以把原元素的字号与字重搬到 host 上，整张卡片就会按层级等比缩放。
 */
describe("卡片保留原元素的排版层级", () => {
  it("把原元素的字号与字重搬到卡片上", () => {
    document.body.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Original";
    heading.style.fontSize = "32px";
    heading.style.fontWeight = "700";
    document.body.append(heading);
    const block = learningBlock(["sentence-1"]);
    renderReady(block);

    new BlockReplacement().show(heading, block);

    expect(block.host.style.fontSize).toBe("32px");
    expect(block.host.style.fontWeight).toBe("700");
  });

  it("普通段落不写死字号，继续跟随页面", () => {
    document.body.replaceChildren();
    const paragraph = document.createElement("p");
    paragraph.textContent = "Original";
    document.body.append(paragraph);
    const block = learningBlock(["sentence-1"]);
    renderReady(block);

    new BlockReplacement().show(paragraph, block);

    expect(block.host.style.fontWeight).toBe("");
  });
});
