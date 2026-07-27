import { GRAMMAR_LABELS, GrammarRole } from "../shared/grammar";
import type {
  CoreAnalysis,
  DetailAnalysis,
  DetailStructure,
  Token,
  TokenRange,
} from "../shared/grammar";

// Gray #6b7280 is the shared "neutral/functional" bucket (APPOSITIVE,
// INDEPENDENT_ELEMENT, CONJUNCTION).
const ROLE_COLORS: Readonly<Record<GrammarRole, string>> = {
  [GrammarRole.SUBJECT]: "#2563eb",
  [GrammarRole.PREDICATE]: "#dc2626",
  [GrammarRole.OBJECT]: "#059669",
  [GrammarRole.PREDICATIVE]: "#0891b2",
  [GrammarRole.ATTRIBUTE]: "#7c3aed",
  [GrammarRole.ADVERBIAL]: "#d97706",
  [GrammarRole.COMPLEMENT]: "#0891b2",
  [GrammarRole.APPOSITIVE]: "#6b7280",
  [GrammarRole.SUBJECT_CLAUSE]: "#2563eb",
  [GrammarRole.OBJECT_CLAUSE]: "#059669",
  [GrammarRole.PREDICATIVE_CLAUSE]: "#0891b2",
  [GrammarRole.ATTRIBUTIVE_CLAUSE]: "#7c3aed",
  [GrammarRole.ADVERBIAL_CLAUSE]: "#d97706",
  [GrammarRole.INDEPENDENT_ELEMENT]: "#6b7280",
  [GrammarRole.COORDINATE_CLAUSE]: "#0d9488",
  [GrammarRole.CONJUNCTION]: "#6b7280",
};

const RETRY_HINT_DURATION_MS = 2000;

const STYLES = `
:host {
  display: block;
  max-inline-size: 100%;
  font: inherit;
  color: inherit;
}

.sentences {
  max-inline-size: 100%;
}

.sentence,
.detail-annotations {
  display: flex;
  flex-wrap: wrap;
  /* 卡片按首行（角色标签）基线对齐：角色行等高，因此英文行必然齐平。
     不能用 end——译文折行的高卡会把英文行顶上去（同行高低不平）。 */
  align-items: baseline;
  column-gap: 0.5em;
  row-gap: 0.55em;
  max-inline-size: 100%;
  overflow-wrap: anywhere;
}

.sentence {
  display: inline-flex;
  vertical-align: baseline;
  margin-inline-end: 0.75em;
  margin-block-end: 0.55em;
}

/* 句首独立标点没有三行结构，不参与基线组，沉到行底与译文层持平。 */
.sentence > .punctuation {
  align-self: end;
}

/* 面板多数时候是句子的兄弟节点（见 setDetailLoading），句子无需变块级，共行的
   邻句不会被挤走。只有长句折行、面板插进句内时才需要块级来让面板拿到栏宽——
   那种句子本来就已占满栏宽，变块级没有视觉代价。 */
.sentence:has(.detail) {
  display: flex;
  margin-inline-end: 0;
}

.component {
  appearance: none;
  display: inline-grid;
  grid-template-rows: repeat(3, auto);
  justify-items: center;
  min-inline-size: 0;
  max-inline-size: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: center;
  cursor: pointer;
  overflow-wrap: anywhere;
  transition: opacity 120ms ease;
}

.component:hover {
  opacity: 0.72;
}

.role,
.english,
.translation {
  min-inline-size: 0;
  max-inline-size: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}

.role,
.annotation-role {
  font-size: max(11px, 0.68em);
  color: var(--syntax-role-color, currentColor);
  opacity: 0.85;
}

.english,
.annotation-english {
  border-bottom: 1.5px solid
    color-mix(in srgb, var(--syntax-role-color, currentColor) 60%, transparent);
  justify-self: stretch;
  text-align: center;
}

.translation,
.annotation-translation {
  font-size: max(12px, 0.8em);
  opacity: 0.78;
  max-inline-size: 16em;
}

/* 超过 16 字的译文：不参与卡片内涵宽度（inline-size: 0），展示时铺满卡宽、
   下限 16em——宽卡里译文不再以 16em 窄列折行。语义等价于 max(100%, 16em)，
   但 Chrome 在内涵尺寸阶段无法解析该表达式里的百分比，只能渲染期按长度分流；
   短译文保持上方 16em 封顶（对短文本是无操作），避免把窄卡强撑到 16em。 */
.translation-wide {
  inline-size: 0;
  min-inline-size: max(100%, 16em);
  max-inline-size: none;
}

.punctuation {
  white-space: normal;
  border-bottom: 0;
}

.component:focus-visible,
.retry:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}

.detail {
  display: block;
  inline-size: 100%;
  max-inline-size: 100%;
  margin-block: 0.75em;
  overflow-wrap: anywhere;
  border: 1px solid #e2e5e9;
  border-inline-start: 3px solid #0d9488;
  border-radius: 8px;
  background: #fafbfc;
  padding: 1em 1.125em;
}

.sentence-failure {
  inline-size: 100%;
  max-inline-size: 100%;
  margin-block: 0.35em;
  overflow-wrap: anywhere;
}

.sentence-skipped {
  inline-size: 100%;
  max-inline-size: 100%;
  margin-block: 0.35em;
  overflow-wrap: anywhere;
}

.detail-annotations {
  margin-block-end: 0.45em;
}

.annotation {
  display: inline-grid;
  grid-auto-rows: auto;
  justify-items: center;
  min-inline-size: 0;
  max-inline-size: 100%;
  overflow-wrap: anywhere;
}

.detail-structure {
  margin-block: 0.2em;
}

.grammar-points,
.detail-summary {
  margin-block-start: 0.875em;
  padding-block-start: 0.625em;
  border-block-start: 1px dashed #e2e5e9;
  font-size: 0.8125rem;
  line-height: 1.7;
}

.retry {
  margin-inline-start: 0.5em;
  border: 1px solid currentColor;
  border-radius: 0.25em;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    transform 80ms ease;
}

.retry:hover:enabled {
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.retry:active:enabled {
  transform: translateY(1px);
}

.retry:disabled {
  cursor: default;
  opacity: 0.6;
}

@media (prefers-reduced-motion: reduce) {
  .component,
  .retry {
    transition: none;
  }
}
`;

export interface SyntaxFocusEventDetail {
  sentenceId: string;
  focus: TokenRange;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(name);
  if (className !== undefined) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

// 16em 封顶按译文字号约等于 16 个汉字；超过则改用铺开模式（见 .translation-wide）。
const WIDE_TRANSLATION_MIN_CHARS = 17;

// 小参数本地模型偶尔把英文原文回填进 translation 字段（提示词要求中文也拦不住）。
// 与英文等值的"译文"没有信息量，视为无译文，卡片/标注退回两行展示。
function isEchoTranslation(translation: string, english: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/gu, " ").trim();
  return normalize(translation) === normalize(english);
}

function translationElement(className: string, text: string): HTMLSpanElement {
  const element = createElement("span", className, text);
  if ([...text].length >= WIDE_TRANSLATION_MIN_CHARS) {
    element.classList.add("translation-wide");
  }
  return element;
}

function eventDetail(sentenceId: string, focus: TokenRange): SyntaxFocusEventDetail {
  return {
    sentenceId,
    focus: { startToken: focus.startToken, endToken: focus.endToken },
  };
}

function circledNumber(value: number): string {
  // Circled digits starting at ① (U+2460) cover 1-20; longer enumerations
  // fall back to plain numerals.
  return value >= 1 && value <= 20 ? String.fromCodePoint(0x2460 + value - 1) : `${value}`;
}

const FALLBACK_ANNOTATION_COLOR = "#6b7280";

const ROLE_COLOR_BY_LABEL: ReadonlyMap<string, string> = new Map(
  Object.values(GrammarRole).map((role) => [GRAMMAR_LABELS[role], ROLE_COLORS[role]]),
);

/**
 * 详解 structure 的 role 是模型自由文本（新版提示词要求中文，但提供英文枚举兜底）；
 * 优先精确匹配中文标签拿颜色，若为已知英文枚举值则映射后再查，否则统一灰色。
 */
function structureColor(role: string): string {
  // 优先中文标签精确匹配
  const directColor = ROLE_COLOR_BY_LABEL.get(role);
  if (directColor !== undefined) {
    return directColor;
  }
  // 枚举值兜底：英文枚举 → 中文标签 → 颜色
  if (role in GrammarRole) {
    const chineseLabel = GRAMMAR_LABELS[role as GrammarRole];
    const mappedColor = ROLE_COLOR_BY_LABEL.get(chineseLabel);
    if (mappedColor !== undefined) {
      return mappedColor;
    }
  }
  return FALLBACK_ANNOTATION_COLOR;
}

/** 标注块与解释列表共用的「①+角色名」标签。 */
function structureLabel(index: number, role: string): string {
  return `${circledNumber(index + 1)} ${role}`;
}

/**
 * 按 token 闭区间还原英文原文：首 token 去掉前导空格、区间末尾的标点省略
 * （标注是摘录，不同于正文标注会把成分后标点并入英文行），其余 token 保留
 * 前导空格。区间反转、越界或不完整时返回 undefined。
 */
function annotationEnglish(tokens: readonly Token[], range: TokenRange): string | undefined {
  if (
    !Number.isInteger(range.startToken) ||
    !Number.isInteger(range.endToken) ||
    range.startToken < 0 ||
    range.endToken >= tokens.length ||
    range.startToken > range.endToken
  ) {
    return undefined;
  }
  let english = "";
  for (let index = range.startToken; index <= range.endToken; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      return undefined;
    }
    if (token.punctuation && index === range.endToken) {
      continue;
    }
    english += (index === range.startToken ? "" : token.leadingWhitespace) + token.text;
  }
  return english;
}

export class SyntaxLearningBlock {
  /**
   * A content script runs in an isolated world where `window.customElements`
   * is `null`, so this class cannot be registered as a custom element. It wraps
   * a plain host element and owns its shadow root by composition instead. Use
   * {@link host} wherever the surrounding DOM needs the actual element node.
   */
  readonly host: HTMLElement;
  readonly #sentences: HTMLElement;
  #expectedSentenceIds = new Set<string>();
  #expectedSentenceOrder: string[] = [];
  #resolvedSentenceIds = new Set<string>();
  #tokensBySentence = new Map<string, readonly Token[]>();
  #retryResetTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();

  constructor(ownerDocument: Document = document) {
    this.host = ownerDocument.createElement("div");
    this.host.dataset.syntaxLearningBlock = "";
    const root = this.host.attachShadow({ mode: "open" });
    const style = createElement("style", undefined, STYLES);
    this.#sentences = createElement("div", "sentences");
    root.append(style, this.#sentences);
  }

  dispatchEvent(event: Event): boolean {
    return this.host.dispatchEvent(event);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.host.addEventListener(type, listener, options);
  }

  get isConnected(): boolean {
    return this.host.isConnected;
  }

  remove(): void {
    this.host.remove();
  }

  setExpectedSentenceIds(ids: readonly string[]): void {
    if (ids.length === 0) {
      throw new Error("Expected sentence IDs must be nonempty");
    }
    const expected = new Set(ids);
    if (expected.size !== ids.length) {
      throw new Error("Expected sentence IDs must not contain duplicate IDs");
    }
    if ([...expected].some((id) => id.length === 0)) {
      throw new Error("Expected sentence IDs must be nonempty strings");
    }
    this.#expectedSentenceIds = expected;
    this.#expectedSentenceOrder = [...ids];
    this.#resolvedSentenceIds = new Set();
    this.#tokensBySentence = new Map();
  }

  /** 流式预览用:只要有一句已经画出来，就值得先放到页面上。 */
  hasRenderedSentence(): boolean {
    return this.#resolvedSentenceIds.size > 0;
  }

  isReadyToReplace(): boolean {
    return (
      this.#expectedSentenceIds.size > 0 &&
      [...this.#expectedSentenceIds].every((id) => this.#resolvedSentenceIds.has(id))
    );
  }

  renderCore(sentence: string, tokens: readonly Token[], analysis: CoreAnalysis): void {
    this.#validateCoreInput(sentence, tokens, analysis);
    this.#tokensBySentence.set(analysis.sentenceId, [...tokens]);
    const sentenceElement = createElement("section", "sentence");
    sentenceElement.dataset.sentenceId = analysis.sentenceId;
    sentenceElement.setAttribute("aria-label", sentence);

    const coordinateClauseTotal = analysis.components.filter(
      (component) => component.role === GrammarRole.COORDINATE_CLAUSE,
    ).length;
    let coordinateClauseIndex = 0;
    let nextToken = 0;
    let lastEnglish: HTMLElement | null = null;
    for (const component of analysis.components) {
      this.#appendPunctuation(
        lastEnglish ?? sentenceElement,
        tokens,
        nextToken,
        component.startToken - 1,
      );
      let label = GRAMMAR_LABELS[component.role];
      let accessibleLabel = label;
      if (component.role === GrammarRole.COORDINATE_CLAUSE && coordinateClauseTotal >= 2) {
        coordinateClauseIndex += 1;
        // The visible label keeps the circled digit; the accessible label uses
        // a plain digit that screen readers announce reliably.
        label = `${label}${circledNumber(coordinateClauseIndex)}`;
        accessibleLabel = `${accessibleLabel}${coordinateClauseIndex}`;
      }
      const componentElement = createElement("button", "component");
      componentElement.type = "button";
      componentElement.dataset.startToken = String(component.startToken);
      componentElement.dataset.endToken = String(component.endToken);
      componentElement.style.setProperty("--syntax-role-color", ROLE_COLORS[component.role]);
      componentElement.setAttribute("aria-label", `${accessibleLabel}：${component.translation}`);
      const role = createElement("span", "role", label);
      const english = createElement("span", "english");

      for (let index = component.startToken; index <= component.endToken; index += 1) {
        const token = tokens[index];
        if (token === undefined) {
          continue;
        }
        // The gap between components comes from the sentence layout; keeping
        // the first token's leading whitespace would stretch this component's
        // underline into that gap and blur the component boundary.
        const leadingWhitespace = index === component.startToken ? "" : token.leadingWhitespace;
        if (token.punctuation) {
          english.append(createElement("span", "punctuation", leadingWhitespace + token.text));
        } else {
          english.append(document.createTextNode(leadingWhitespace + token.text));
        }
      }

      componentElement.append(role, english);
      if (!isEchoTranslation(component.translation, english.textContent ?? "")) {
        componentElement.append(translationElement("translation", component.translation));
      }
      componentElement.addEventListener("click", () => {
        // A second click on the component whose explanation is already open
        // toggles it closed instead of re-requesting the analysis.
        if (this.#closeDetail(analysis.sentenceId, component)) {
          return;
        }
        this.dispatchEvent(
          new CustomEvent<SyntaxFocusEventDetail>("syntax-detail-request", {
            bubbles: true,
            composed: true,
            detail: eventDetail(analysis.sentenceId, component),
          }),
        );
      });
      sentenceElement.append(componentElement);

      lastEnglish = english;
      nextToken = component.endToken + 1;
    }
    this.#appendPunctuation(lastEnglish ?? sentenceElement, tokens, nextToken, tokens.length - 1);
    this.#placeSentenceSection(analysis.sentenceId, sentenceElement);
    this.#resolvedSentenceIds.add(analysis.sentenceId);
  }

  setDetailLoading(sentenceId: string, focus: TokenRange): void {
    const sentence = this.#sentence(sentenceId);
    if (sentence === null) {
      throw new Error(`Cannot render detail for unknown sentence: ${sentenceId}`);
    }
    // Only one explanation panel stays open at a time; opening a new one
    // switches away from whatever was open before.
    this.closeDetails();

    // Find the clicked component element by matching token range.
    // For sentences that failed core analysis, no components exist in the DOM,
    // so we fall back to appending the detail panel to the sentence container.
    const detail = createElement("div", "detail detail-loading");
    detail.dataset.sentenceId = sentenceId;
    detail.dataset.startToken = String(focus.startToken);
    detail.dataset.endToken = String(focus.endToken);
    detail.setAttribute("aria-live", "polite");
    detail.setAttribute("aria-busy", "true");
    detail.textContent = "正在加载详细解析…";

    // 面板落在**被点成分所在视觉行**的正下方。两种插法，取决于那一行是不是
    // 整句的最后一行：
    //
    //  * 不是最后一行（长句折行）：插在句内、该行最后一个成分之后。这种句子
    //    已经占满栏宽、不可能与别的句子共行，所以让它变块级（见 CSS 的
    //    :has(.detail)）没有任何视觉代价。
    //  * 是最后一行：插到句子外面、该视觉行最后一句之后。短句常与邻句共行，
    //    放句内会逼句子变块级，把邻居挤到下一行。
    //
    // 行判定依赖真实布局，零尺寸环境（单测）退化为插在句子之后。
    const component = sentence.querySelector<HTMLElement>(
      `.component[data-start-token="${focus.startToken}"][data-end-token="${focus.endToken}"]`,
    );
    const clickedRect = component?.getBoundingClientRect();
    // 显式判断有没有真实布局:happy-dom 等零尺寸环境里所有矩形都是 0，靠数值
    // 比较会误判成"下面还有成分"而选错分支。
    const hasLayout = clickedRect !== undefined && clickedRect.height > 0;
    const hasComponentBelow =
      hasLayout &&
      [...sentence.querySelectorAll<HTMLElement>(".component")].some(
        (other) => other.getBoundingClientRect().top >= clickedRect.bottom,
      );

    if (component !== null && hasComponentBelow) {
      const clickedBottom = clickedRect.bottom;
      let anchor: Element = component;
      for (let next = anchor.nextElementSibling; next !== null; next = next.nextElementSibling) {
        if (next.getBoundingClientRect().top >= clickedBottom) break;
        anchor = next;
      }
      anchor.after(detail);
      return;
    }

    const sentenceBottom = sentence.getBoundingClientRect().bottom;
    let anchor: Element = sentence;
    for (let next = anchor.nextElementSibling; next !== null; next = next.nextElementSibling) {
      if (!next.classList.contains("sentence")) break;
      if (next.getBoundingClientRect().top >= sentenceBottom) break;
      anchor = next;
    }
    anchor.after(detail);
  }

  closeDetails(): void {
    for (const detail of this.#sentences.querySelectorAll(".detail")) {
      detail.remove();
    }
  }

  /**
   * 流式预览:把已完成的结构画进已打开的面板，替换掉"正在加载"。只渲染标注行，
   * 语法点与整体说明要等完整响应——它们在信封末尾，流式期间还没到。
   */
  renderDetailStructures(
    sentenceId: string,
    focus: TokenRange,
    structures: readonly DetailStructure[],
  ): void {
    const detail = this.#findDetail(sentenceId, focus);
    if (detail === null || structures.length === 0) return;
    const tokens = this.#tokensBySentence.get(sentenceId) ?? [];
    detail.className = "detail";
    detail.removeAttribute("aria-busy");
    detail.replaceChildren(this.#annotations(structures, tokens));
  }

  /** 标注行:流式预览与完整渲染共用，两处各写一遍必然漂移。 */
  #annotations(structures: readonly DetailStructure[], tokens: readonly Token[]): HTMLElement {
    const annotations = createElement("div", "detail-annotations");
    for (const [index, structure] of structures.entries()) {
      const english = annotationEnglish(tokens, structure);
      // 区间越界/反转或纯标点（还原为空文本）：跳过标注块，下方解释列表仍按同一序号列出该条。
      if (english === undefined || english === "") {
        continue;
      }
      const annotation = createElement("span", "annotation");
      annotation.style.setProperty("--syntax-role-color", structureColor(structure.role));
      annotation.append(
        createElement("span", "annotation-role", structureLabel(index, structure.role)),
        createElement("span", "annotation-english", english),
      );
      // 第三行译文与正文同构；旧缓存/模型缺省/回显英文时退回两行标注。
      if (
        structure.translation !== undefined &&
        structure.translation.trim().length > 0 &&
        !isEchoTranslation(structure.translation, english)
      ) {
        annotation.append(translationElement("annotation-translation", structure.translation));
      }
      annotations.append(annotation);
    }
    return annotations;
  }

  renderDetail(detailAnalysis: DetailAnalysis): void {
    const detail = this.#findDetail(detailAnalysis.sentenceId, detailAnalysis.focus);
    // The reader may have toggled the panel closed while the analysis was in
    // flight; a late response must not reopen it.
    if (detail === null) {
      return;
    }
    detail.className = "detail";
    detail.removeAttribute("aria-busy");
    detail.replaceChildren();

    if (detailAnalysis.structures.length > 0) {
      const tokens = this.#tokensBySentence.get(detailAnalysis.sentenceId) ?? [];
      const annotations = this.#annotations(detailAnalysis.structures, tokens);
      if (annotations.childElementCount > 0) {
        detail.append(annotations);
      }
      for (const [index, structure] of detailAnalysis.structures.entries()) {
        const row = createElement("div", "detail-structure");
        row.append(
          createElement("strong", "detail-role", structureLabel(index, structure.role)),
          document.createTextNode("："),
          createElement("span", "detail-explanation", structure.explanation),
        );
        detail.append(row);
      }
    }
    if (detailAnalysis.grammarPoints.length > 0) {
      detail.append(
        createElement("div", "grammar-points", detailAnalysis.grammarPoints.join("、")),
      );
    }
    detail.append(createElement("div", "detail-summary", detailAnalysis.explanation));
  }

  #createRetry(sentenceId: string, focus: TokenRange): HTMLButtonElement {
    const retry = createElement("button", "retry", "重新解析");
    retry.type = "button";
    retry.addEventListener("click", () => {
      if (retry.disabled) return;
      retry.disabled = true;
      retry.textContent = "解析中…";
      this.dispatchEvent(
        new CustomEvent<SyntaxFocusEventDetail>("syntax-reanalyze-request", {
          bubbles: true,
          composed: true,
          detail: eventDetail(sentenceId, focus),
        }),
      );
    });
    return retry;
  }

  renderError(sentenceId: string, focus: TokenRange, message: string): void {
    this.#assertExpected(sentenceId);
    const detail = this.#findDetail(sentenceId, focus);
    if (detail === null) {
      return;
    }
    detail.className = "detail detail-error";
    detail.removeAttribute("aria-busy");
    detail.replaceChildren(createElement("span", "error-message", message));
    detail.append(this.#createRetry(sentenceId, focus));
    this.#resolvedSentenceIds.add(sentenceId);
  }

  renderFailure(sentenceId: string, sentence: string, message: string): void {
    this.#assertExpected(sentenceId);
    const failure = createElement("section", "sentence-failure");
    failure.dataset.sentenceId = sentenceId;
    failure.append(
      createElement("span", "original-sentence", sentence),
      createElement("span", "error-message", ` ${message}`),
    );
    failure.append(this.#createRetry(sentenceId, { startToken: 0, endToken: 0 }));
    this.#placeSentenceSection(sentenceId, failure);
    this.#resolvedSentenceIds.add(sentenceId);
  }

  /** 恢复该句所有「重新解析」按钮；带 hint 时先短暂显示提示再恢复（如暂停时点击）。 */
  resetRetry(sentenceId: string, hint?: string): void {
    for (const retry of this.#sentences.querySelectorAll<HTMLButtonElement>(".retry")) {
      if (retry.closest<HTMLElement>("[data-sentence-id]")?.dataset.sentenceId !== sentenceId) {
        continue;
      }
      const timer = this.#retryResetTimers.get(retry);
      if (timer !== undefined) clearTimeout(timer);
      this.#retryResetTimers.delete(retry);
      if (hint === undefined) {
        retry.disabled = false;
        retry.textContent = "重新解析";
        continue;
      }
      retry.disabled = true;
      retry.textContent = hint;
      this.#retryResetTimers.set(
        retry,
        setTimeout(() => {
          this.#retryResetTimers.delete(retry);
          retry.disabled = false;
          retry.textContent = "重新解析";
        }, RETRY_HINT_DURATION_MS),
      );
    }
  }

  /** 纯缓存模式未命中：按原文渲染，无错误样式、无重试按钮。 */
  renderSkipped(sentenceId: string, sentence: string): void {
    this.#assertExpected(sentenceId);
    const section = createElement("section", "sentence-skipped");
    section.dataset.sentenceId = sentenceId;
    section.append(createElement("span", "original-sentence", sentence));
    this.#placeSentenceSection(sentenceId, section);
    this.#resolvedSentenceIds.add(sentenceId);
  }

  #sentence(sentenceId: string): HTMLElement | null {
    for (const sentence of this.#sentences.children) {
      if (sentence instanceof HTMLElement && sentence.dataset.sentenceId === sentenceId) {
        return sentence;
      }
    }
    return null;
  }

  /** 把 [startToken, endToken] 里的标点追加到 target：有前置成分时是其英文行，否则是句容器。 */
  #appendPunctuation(
    target: HTMLElement,
    tokens: readonly Token[],
    startToken: number,
    endToken: number,
  ): void {
    for (let index = startToken; index <= endToken; index += 1) {
      const token = tokens[index];
      if (token?.punctuation === true) {
        target.append(createElement("span", "punctuation", token.leadingWhitespace + token.text));
      }
    }
  }

  #validateCoreInput(sentence: string, tokens: readonly Token[], analysis: CoreAnalysis): void {
    this.#assertExpected(analysis.sentenceId);
    let offset = 0;
    let reconstructed = "";
    for (const [index, token] of tokens.entries()) {
      reconstructed += token.leadingWhitespace + token.text;
      const expectedStart = offset + token.leadingWhitespace.length;
      if (
        token.id !== index ||
        token.start !== expectedStart ||
        token.end !== expectedStart + token.text.length
      ) {
        throw new Error("Original sentence and tokens do not match");
      }
      offset = token.end;
    }
    if (reconstructed !== sentence) {
      throw new Error("Original sentence and tokens do not match");
    }

    let previousEnd = -1;
    for (const component of analysis.components) {
      if (
        !Number.isInteger(component.startToken) ||
        !Number.isInteger(component.endToken) ||
        component.startToken < 0 ||
        component.endToken < component.startToken ||
        component.endToken >= tokens.length ||
        component.startToken <= previousEnd
      ) {
        throw new Error("Core component ranges must be ordered and non-overlapping");
      }
      previousEnd = component.endToken;
    }
  }

  #assertExpected(sentenceId: string): void {
    if (this.#expectedSentenceIds.size > 0 && !this.#expectedSentenceIds.has(sentenceId)) {
      throw new Error(`Unexpected sentence ID: ${sentenceId}`);
    }
  }

  #findDetail(sentenceId: string, focus: TokenRange): HTMLElement | null {
    for (const candidate of this.#sentences.querySelectorAll<HTMLElement>(".detail")) {
      if (
        candidate.dataset.sentenceId === sentenceId &&
        Number(candidate.dataset.startToken) === focus.startToken &&
        Number(candidate.dataset.endToken) === focus.endToken
      ) {
        return candidate;
      }
    }
    return null;
  }

  #closeDetail(sentenceId: string, focus: TokenRange): boolean {
    const detail = this.#findDetail(sentenceId, focus);
    if (detail === null) {
      return false;
    }
    detail.remove();
    return true;
  }

  /**
   * Puts a (re-)rendered sentence section at its position in the block's
   * source order. Appending re-renders and failures at the end used to move a
   * sentence — and every detail panel later opened under it — below the
   * sentences that follow it.
   */
  #placeSentenceSection(sentenceId: string, section: HTMLElement): void {
    const existing = this.#sentence(sentenceId);
    if (existing !== null) {
      // 面板不再是句子的子节点，replaceWith 不会顺带清掉它:留着会变成一张
      // 指向旧成分区间的孤儿面板。
      for (const detail of this.#sentences.querySelectorAll<HTMLElement>(".detail")) {
        if (detail.dataset.sentenceId === sentenceId) detail.remove();
      }
      existing.replaceWith(section);
      return;
    }
    const order = this.#expectedSentenceOrder.indexOf(sentenceId);
    if (order !== -1) {
      for (const sibling of this.#sentences.children) {
        if (!(sibling instanceof HTMLElement) || sibling.dataset.sentenceId === undefined) {
          continue;
        }
        const siblingOrder = this.#expectedSentenceOrder.indexOf(sibling.dataset.sentenceId);
        if (siblingOrder > order) {
          sibling.before(section);
          return;
        }
      }
    }
    this.#sentences.append(section);
  }
}
