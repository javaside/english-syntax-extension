/**
 * 预览页句法卡片渲染：可逆替换、流式暂定卡、详解面板。
 *
 * 结构与视觉对齐 Chrome 端 `learning-block.ts`：
 * 三行组件（角色标签/英文原文/中文译文，居中网格 + baseline 组对齐）、
 * 按角色着色的细下划线、标点沉入行底、详解面板为「标注行 + ①角色：解释列表 +
 * 语法点 + 整体说明」、失败句保留原文 + 重试按钮。
 * 模型文本一律 textContent；旧 generation 的消息在入口处丢弃。
 */

import type { HostMessage } from "./bridge";
import { circledNumber, roleColor, roleLabel, structureColor } from "./roles";

const HIDDEN_ATTRIBUTE = "data-english-syntax-hidden";
const CARD_TAG = "div";
const CARD_ATTRIBUTE = "data-english-syntax-card";

interface BlockRecord {
  blockId: string;
  element: HTMLElement;
  card: HTMLElement | null;
  sentences: Map<string, SentenceRecord>;
}

interface SentenceRecord {
  analysis: CorePayload | null;
  provisional: ComponentPayload[] | null;
  failed: boolean;
}

interface CorePayload {
  sentenceId: string;
  components: ComponentPayload[];
}

interface ComponentPayload {
  startToken: number;
  endToken: number;
  role: string;
  translation: string;
  /** Kotlin 侧按 token 区间回填的英文原文；缺失时英文行为空。 */
  text?: string;
}

interface DetailPayload {
  sentenceId: string;
  focus: { startToken: number; endToken: number };
  structures: Array<{
    startToken: number;
    endToken: number;
    role: string;
    explanation: string;
    translation?: string;
  }>;
  grammarPoints: string[];
  explanation: string;
}

export type DetailRequestHandler = (
  sentenceId: string,
  focusStart: number,
  focusEnd: number,
) => void;

// 16em 封顶按译文字号约等于 16 个汉字；超过则改用铺开模式（Chrome 端同款）。
const WIDE_TRANSLATION_MIN_CHARS = 17;

// 小参数本地模型偶尔把英文原文回填进 translation 字段。与英文等值的「译文」
// 没有信息量，视为无译文，退回两行展示（Chrome 端同款）。
function isEchoTranslation(translation: string, english: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/gu, " ").trim();
  return normalize(translation) === normalize(english);
}

// 模型错误码 → 用户可读文案。Kotlin 侧 error.message 可能带着模型原始 JSON
// （如余额不足 `{"error":{"message":"Insufficient Balance",...}}`），
// 直接上屏既看不懂又泄露内部信息——这里按 code 出友好文案，原始 message 只留日志。
const ERROR_TEXT: Readonly<Record<string, string>> = {
  AUTH_FAILED: "模型配置鉴权失败，请检查 API Key 或账户状态",
  MODEL_NOT_FOUND: "找不到配置的模型，请检查模型名/服务地址",
  RATE_LIMITED: "模型服务限流，请稍后重试",
  NETWORK_ERROR: "模型请求失败，请检查网络或模型地址",
  REQUEST_TIMEOUT: "模型请求超时",
  INVALID_MODEL_OUTPUT: "模型返回结果无法解析",
  SENTENCE_TOO_LONG: "句子过长，超出单次解析长度上限",
  REQUEST_CANCELLED: "请求已取消",
  CONFIG_MISSING: "尚未配置可用的模型",
  DETAIL_FAILED: "详解解析失败",
};

function friendlyErrorMessage(code: string, fallback: string): string {
  return ERROR_TEXT[code] ?? `${code}：${fallback}`;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  owner: Document,
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = owner.createElement(name);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function translationElement(owner: Document, className: string, text: string): HTMLSpanElement {
  const element = createElement(owner, "span", className, text);
  if ([...text].length >= WIDE_TRANSLATION_MIN_CHARS) {
    element.classList.add("english-syntax-translation-wide");
  }
  return element;
}

export class PreviewRenderer {
  readonly #blocks = new Map<string, BlockRecord>();
  readonly #sentences = new Map<string, { blockId: string; record: SentenceRecord }>();
  readonly #blockSentenceOrder = new Map<string, string[]>();
  #currentDetail: { sentenceId: string; focusStart: number; focusEnd: number } | null = null;
  readonly #onDetailRequest: DetailRequestHandler;

  constructor(onDetailRequest: DetailRequestHandler) {
    this.#onDetailRequest = onDetailRequest;
  }

  registerBlock(blockId: string, element: HTMLElement): void {
    this.#blocks.set(blockId, { blockId, element, card: null, sentences: new Map() });
    this.#blockSentenceOrder.set(blockId, []);
  }

  /** 宿主消息统一入口：旧 generation 已由 bridge 层过滤，这里按类型分发。 */
  handleHostMessage(message: HostMessage): void {
    switch (message.type) {
      case "CORE_STREAM":
        this.renderCoreStream(
          message.sentenceId,
          message.blockId,
          JSON.parse(message.componentsJson) as ComponentPayload[],
        );
        break;
      case "CORE_RESULT":
        this.renderCoreResult(message.sentenceId, message.blockId, JSON.parse(message.analysisJson) as CorePayload);
        break;
      case "CORE_ERROR":
        this.renderCoreError(message.sentenceId, message.blockId, message.code, message.message);
        break;
      case "DETAIL_STREAM":
      case "DETAIL_RESULT": {
        const payload = JSON.parse(
          message.type === "DETAIL_RESULT" ? message.analysisJson : message.structuresJson,
        ) as DetailPayload | Array<DetailPayload["structures"][number]>;
        if (message.type === "DETAIL_RESULT") {
          this.renderDetailResult(payload as DetailPayload);
        } else {
          this.renderDetailStream(
            message.sentenceId,
            message.focusStart,
            message.focusEnd,
            payload as DetailPayload["structures"],
          );
        }
        break;
      }
      case "RESTORE_ALL":
        this.restoreAll();
        break;
      default:
        break;
    }
  }

  renderCoreStream(sentenceId: string, blockId: string, components: ComponentPayload[]): void {
    this.#ensureSentence(blockId, sentenceId);
    const entry = this.#sentences.get(sentenceId);
    if (entry === undefined) return;
    entry.record.provisional = components;
    const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
    if (!order.includes(sentenceId)) order.push(sentenceId);
    this.#blockSentenceOrder.set(entry.blockId, order);
    this.#repaintBlock(entry.blockId);
  }

  renderCoreResult(sentenceId: string, blockId: string, analysis: CorePayload): void {
    this.#ensureSentence(blockId, sentenceId);
    const entry = this.#sentences.get(sentenceId);
    if (entry === undefined) return;
    entry.record.analysis = analysis;
    entry.record.provisional = null;
    entry.record.failed = false;
    this.#sentences.set(sentenceId, entry);
    // 登记句子顺序并重画。
    const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
    if (!order.includes(sentenceId)) order.push(sentenceId);
    this.#blockSentenceOrder.set(entry.blockId, order);
    this.#repaintBlock(entry.blockId);
  }

  renderCoreError(sentenceId: string, blockId: string, code: string, message: string): void {
    this.#ensureSentence(blockId, sentenceId);
    const entry = this.#sentences.get(sentenceId);
    if (entry === undefined) return;
    entry.record.failed = true;
    entry.record.analysis = null;
    entry.record.provisional = null;
    this.#repaintBlock(entry.blockId, {
      errorSentenceId: sentenceId,
      message: friendlyErrorMessage(code, message),
    });
  }

  /**
   * 惰性注册句子：sentenceId 由 Kotlin 侧权威生成（s-{blockId}-{index}），
   * JS 端不做分句，CORE_* 消息首次到达时按消息里的 blockId 注册即可渲染。
   * 若 blockId 尚未 registerBlock（极端乱序），则忽略——下一轮 VISIBLE_BLOCKS 会补上。
   */
  #ensureSentence(blockId: string, sentenceId: string): void {
    if (this.#sentences.has(sentenceId)) return;
    const record = this.#blocks.get(blockId);
    if (record === undefined) return;
    record.sentences.set(sentenceId, { analysis: null, provisional: null, failed: false });
    this.#sentences.set(sentenceId, { blockId, record: record.sentences.get(sentenceId)! });
  }

  renderDetailStream(sentenceId: string, focusStart: number, focusEnd: number, structures: DetailPayload["structures"]): void {
    this.#showDetailPanel(sentenceId, structures, focusStart, focusEnd);
  }

  renderDetailResult(detail: DetailPayload): void {
    this.#showDetailPanel(detail.sentenceId, detail.structures, detail.focus.startToken, detail.focus.endToken, detail);
  }

  requestDetail(sentenceId: string, focusStart: number, focusEnd: number): void {
    this.#onDetailRequest(sentenceId, focusStart, focusEnd);
  }

  /**
   * 点击成分后立即显示「加载中」占位面板（不等模型返回）。
   * 行锚定在模型返回后由 renderDetailStream / renderDetailResult 的精确锚定替换；
   * 占位先插在被点句子之后，让点击有即时反馈，消除「卡一下才显示」。
   */
  #showDetailLoading(sentenceId: string, focusStart: number, focusEnd: number): void {
    const entry = this.#sentences.get(sentenceId);
    if (entry == null) return;
    this.#closeAllDetailPanels();
    this.#currentDetail = { sentenceId, focusStart, focusEnd };
    const record = this.#blocks.get(entry.blockId);
    const card = record?.card;
    if (card == null) return;
    const sentence = card.querySelector<HTMLElement>(
      `.english-syntax-sentence[data-sentence-id="${sentenceId}"]`,
    );
    if (sentence == null) return;
    const panel = createElement(sentence.ownerDocument, "div", "english-syntax-detail english-syntax-detail-loading");
    panel.dataset.sentenceId = sentenceId;
    panel.textContent = "正在加载详解…";
    sentence.classList.add("english-syntax-has-detail");
    sentence.after(panel);
  }

  #showDetailPanel(
    sentenceId: string,
    structures: DetailPayload["structures"],
    focusStart?: number,
    focusEnd?: number,
    detail?: DetailPayload,
  ): void {
    const entry = this.#sentences.get(sentenceId);
    if (entry == null) return;
    // 同时只保留一个详解面板：打开新的前先关掉所有已显示的（含加载占位），
    // 否则点击其他成分时旧面板不收起、页面越积越多（Chrome 端 setDetailLoading
    // 开头 closeDetails 同款语义）。
    this.#closeAllDetailPanels();
    this.#currentDetail = {
      sentenceId,
      focusStart: focusStart ?? detail?.focus.startToken ?? 0,
      focusEnd: focusEnd ?? detail?.focus.endToken ?? 0,
    };
    this.#repaintBlock(entry.blockId, { detailStructures: structures, detail });
  }

  /** 关闭预览页里所有已打开的详解面板（含加载占位）。 */
  #closeAllDetailPanels(): void {
    for (const panel of document.querySelectorAll(".english-syntax-detail")) {
      panel.remove();
    }
  }

  closeDetail(): void {
    if (this.#currentDetail === null) return;
    const entry = this.#sentences.get(this.#currentDetail.sentenceId);
    this.#currentDetail = null;
    if (entry != null) this.#repaintBlock(entry.blockId);
  }

  #repaintBlock(
    blockId: string,
    options: {
      errorSentenceId?: string;
      message?: string;
      detailStructures?: DetailPayload["structures"];
      detail?: DetailPayload;
    } = {},
  ): void {
    const record = this.#blocks.get(blockId);
    if (record === undefined) return;
    const order = this.#blockSentenceOrder.get(blockId) ?? [];
    const hasContent = order.some((id) => {
      const sentence = record.sentences.get(id);
      return (
        sentence !== undefined && (sentence.analysis !== null || sentence.provisional !== null)
      );
    });
    if (
      !hasContent &&
      options.errorSentenceId === undefined &&
      options.detailStructures === undefined
    ) {
      this.#restoreBlock(record);
      return;
    }
    if (record.card === null) {
      record.card = record.element.ownerDocument.createElement(CARD_TAG);
      record.card.setAttribute(CARD_ATTRIBUTE, "true");
      record.element.after(record.card);
    }
    record.element.setAttribute(HIDDEN_ATTRIBUTE, "true");
    this.#renderCard(record, order, options);
  }

  #renderCard(
    record: BlockRecord,
    order: string[],
    options: {
      errorSentenceId?: string;
      message?: string;
      detailStructures?: DetailPayload["structures"];
      detail?: DetailPayload;
    },
  ): void {
    const card = record.card!;
    const owner = record.element.ownerDocument;
    // 整卡重建：流式分片给的是累积列表，全量重画语义最简单。
    card.replaceChildren();
    const container = createElement(owner, "div", "english-syntax-sentences");
    for (const sentenceId of order) {
      const sentence = record.sentences.get(sentenceId);
      if (sentence === undefined) continue;
      const section = createElement(owner, "section", "english-syntax-sentence");
      section.dataset.sentenceId = sentenceId;
      const components = sentence.analysis?.components ?? sentence.provisional ?? [];
      if (sentenceId === options.errorSentenceId) {
        // 失败句：原文 + 错误 + 重试（Chrome 端 sentence-failure 同款）。
        const failure = createElement(owner, "div", "english-syntax-sentence-failure");
        failure.append(
          createElement(owner, "span", "english-syntax-original", this.#originalText(sentenceId)),
          createElement(owner, "span", "english-syntax-error", options.message ?? "解析失败"),
        );
        failure.append(this.#createRetry(owner, sentenceId));
        container.append(failure);
        continue;
      }
      const coordinateClauseTotal = components.filter(
        (component) => component.role === "COORDINATE_CLAUSE",
      ).length;
      let coordinateClauseIndex = 0;
      for (const component of components) {
        let label = roleLabel(component.role);
        if (component.role === "COORDINATE_CLAUSE" && coordinateClauseTotal >= 2) {
          coordinateClauseIndex += 1;
          label = `${label}${circledNumber(coordinateClauseIndex)}`;
        }
        const button = createElement(owner, "button", "english-syntax-component");
        button.type = "button";
        button.dataset.startToken = String(component.startToken);
        button.dataset.endToken = String(component.endToken);
        button.style.setProperty("--english-syntax-role-color", roleColor(component.role));
        const role = createElement(owner, "span", "english-syntax-role", label);
        const english = createElement(owner, "span", "english-syntax-english");
        english.textContent = component.text ?? "";
        button.append(role, english);
        if (!isEchoTranslation(component.translation, english.textContent ?? "")) {
          button.append(translationElement(owner, "english-syntax-translation", component.translation));
        }
        button.addEventListener("click", () => {
          if (this.#currentDetail?.sentenceId === sentenceId) {
            this.closeDetail();
            return;
          }
          // 点击立即显示「加载中」占位（不等模型返回），消除「卡一下才显示」；
          // 后续 renderDetailStream / renderDetailResult 会精确锚定替换。
          this.#showDetailLoading(sentenceId, component.startToken, component.endToken);
          this.requestDetail(sentenceId, component.startToken, component.endToken);
        });
        section.append(button);
      }
      if (sentence.analysis === null && sentence.provisional !== null) {
        section.classList.add("english-syntax-provisional");
      }
      container.append(section);
    }
    card.append(container);
    // 详解面板锚定：DOM 挂载后才有真实布局，行判定（Chrome 端 setDetailLoading 同款）
    // 需要 getBoundingClientRect——被点成分若不在视觉行末，面板插到该行末尾；
    // 否则插到句子之后。
    if (
      this.#currentDetail !== null &&
      (options.detailStructures !== undefined || options.detail !== undefined)
    ) {
      this.#placeDetailPanel(
        card,
        options.detailStructures ?? options.detail?.structures ?? [],
        options.detail,
      );
    }
  }

  /**
   * 详解面板行锚定（移植 Chrome 端 `setDetailLoading` 的行判定）：
   * 面板落在**被点成分所在视觉行**的正下方。
   *  * 被点成分下面还有同句成分（长句折行）：插在句内、该行最后一个成分之后；
   *  * 是最后一行：插到句子之后（短句常与邻句共行，放句内会逼句子变块级挤走邻居）。
   * 行判定依赖真实布局，零尺寸环境（单测）退化为插在句子之后。
   */
  #placeDetailPanel(
    card: HTMLElement,
    structures: DetailPayload["structures"],
    detail?: DetailPayload,
  ): void {
    const current = this.#currentDetail;
    if (current === null) return;
    const sentence = card.querySelector<HTMLElement>(
      `.english-syntax-sentence[data-sentence-id="${current.sentenceId}"]`,
    );
    if (sentence === null) return;
    const panel = this.#renderDetailPanel(sentence.ownerDocument, structures, detail);
    sentence.classList.add("english-syntax-has-detail");

    const component = sentence.querySelector<HTMLElement>(
      `.english-syntax-component[data-start-token="${current.focusStart}"][data-end-token="${current.focusEnd}"]`,
    );
    const clickedRect = component?.getBoundingClientRect();
    // 显式判断有没有真实布局：happy-dom 等零尺寸环境里所有矩形都是 0，靠数值比较
    // 会误判成「下面还有成分」而选错分支（Chrome 端同款守卫）。
    const hasLayout = clickedRect !== undefined && clickedRect.height > 0;
    const hasComponentBelow =
      hasLayout &&
      [...sentence.querySelectorAll<HTMLElement>(".english-syntax-component")].some(
        (other) => other.getBoundingClientRect().top >= clickedRect.bottom,
      );

    if (component !== null && hasComponentBelow) {
      const clickedBottom = clickedRect.bottom;
      let anchor: Element = component;
      for (let next = anchor.nextElementSibling; next !== null; next = next.nextElementSibling) {
        if (next.getBoundingClientRect().top >= clickedBottom) break;
        anchor = next;
      }
      anchor.after(panel);
      return;
    }
    sentence.after(panel);
  }

  /** 详解面板：标注行（①角色 + 英文摘录）+ 解释列表 + 语法点 + 整体说明。 */
  #renderDetailPanel(
    owner: Document,
    structures: DetailPayload["structures"],
    detail?: DetailPayload,
  ): HTMLElement {
    const panel = createElement(owner, "div", "english-syntax-detail");
    const annotations = createElement(owner, "div", "english-syntax-detail-annotations");
    for (const [index, structure] of structures.entries()) {
      const label = `${circledNumber(index + 1)} ${structure.role}`;
      const annotation = createElement(owner, "span", "english-syntax-annotation");
      annotation.style.setProperty("--english-syntax-role-color", structureColor(structure.role));
      annotation.append(
        createElement(owner, "span", "english-syntax-annotation-role", label),
        createElement(owner, "span", "english-syntax-annotation-english", this.#structureText(structure)),
      );
      if (
        structure.translation !== undefined &&
        structure.translation.trim().length > 0
      ) {
        annotation.append(
          translationElement(owner, "english-syntax-annotation-translation", structure.translation),
        );
      }
      annotations.append(annotation);
    }
    panel.append(annotations);
    for (const [index, structure] of structures.entries()) {
      const row = createElement(owner, "div", "english-syntax-detail-structure");
      const strong = createElement(owner, "strong", "english-syntax-detail-role");
      strong.textContent = `${circledNumber(index + 1)} ${structure.role}`;
      row.append(
        strong,
        owner.createTextNode("："),
        createElement(owner, "span", "english-syntax-detail-explanation", structure.explanation),
      );
      panel.append(row);
    }
    if (detail?.grammarPoints?.length) {
      panel.append(
        createElement(owner, "div", "english-syntax-grammar-points", detail.grammarPoints.join("、")),
      );
    }
    if (detail?.explanation) {
      panel.append(createElement(owner, "div", "english-syntax-detail-summary", detail.explanation));
    }
    return panel;
  }

  #createRetry(owner: Document, sentenceId: string): HTMLButtonElement {
    const retry = createElement(owner, "button", "english-syntax-retry", "重新解析");
    retry.type = "button";
    retry.dataset.sentenceId = sentenceId;
    retry.dataset.englishSyntaxRetry = "";
    retry.addEventListener("click", () => {
      if (retry.disabled) return;
      retry.disabled = true;
      retry.textContent = "解析中…";
      // 失败句的重新解析走 RETRY_SENTENCE 通道（bootstrap-entry 的全局监听接手）。
    });
    return retry;
  }

  #originalText(sentenceId: string): string {
    // 失败句保留原文：从该块已注册的句子文本兜底（Kotlin 侧未提供原文时退化为空串）。
    void sentenceId;
    return "";
  }

  #structureText(structure: { startToken: number; endToken: number; text?: string }): string {
    return typeof structure.text === "string" ? structure.text : "";
  }

  #restoreBlock(record: BlockRecord): void {
    record.element.removeAttribute(HIDDEN_ATTRIBUTE);
    record.card?.remove();
    record.card = null;
  }

  /**
   * 当前呈现元素：已替换为卡片时是卡片，否则是原文块。解析中标记打在它上面，
   * 流式换卡片后标记跟着走（Chrome 端 BlockReplacement.currentElement 同款语义）。
   */
  currentElement(blockId: string): HTMLElement | null {
    const record = this.#blocks.get(blockId);
    if (record === undefined) return null;
    return record.card ?? record.element;
  }

  /** 供 bootstrap 在 VISIBLE_BLOCKS 后对可见块打「解析中」标记。 */
  markActive(blockId: string): HTMLElement | null {
    return this.currentElement(blockId);
  }

  restoreAll(): void {
    for (const record of this.#blocks.values()) this.#restoreBlock(record);
  }

  /** 测试辅助：注册句子（生产路径由会话层把分词结果喂进来）。 */
  registerSentence(blockId: string, sentenceId: string): void {
    const record = this.#blocks.get(blockId);
    if (record === undefined) return;
    record.sentences.set(sentenceId, { analysis: null, provisional: null, failed: false });
    this.#sentences.set(sentenceId, { blockId, record: record.sentences.get(sentenceId)! });
  }

  /** 测试辅助：确认某句是否已被替换渲染。 */
  isSentenceRendered(sentenceId: string): boolean {
    const entry = this.#sentences.get(sentenceId);
    return entry?.record.analysis !== null && entry?.record.analysis !== undefined;
  }
}
