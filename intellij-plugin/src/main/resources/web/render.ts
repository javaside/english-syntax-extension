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

/**
 * 句子在卡片里的排列顺序 = 原文出现顺序（源序），而不是消息到达顺序。
 * sentenceId 由 Kotlin 权威生成，形如 `s-{blockId}-{index}`，index（最后一个连字符之后
 * 的数字）就是该句在块内的源序下标。流式分片按模型输出到达，可能先吐后半句——
 * #blockSentenceOrder 若按到达顺序累积，final 卡片就会照此错排（英文和原文对不上）。
 * 渲染前按 index 数值升序重排，无论分片/结果乱序与否都恢复源序（chrome 端
 * setExpectedSentenceIds 同语义，这里直接从 sentenceId 推断，无需宿主额外传序）。
 */
function bySourceOrder(sentenceIdA: string, sentenceIdB: string): number {
  const indexOf = (id: string) => {
    // 生产：s-{blockId}-{index} → 末尾 index；也兼容 s1/s2（测试）这类裸编号。
    const match = /(\d+)$/.exec(id);
    return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]!);
  };
  return indexOf(sentenceIdA) - indexOf(sentenceIdB);
}

interface BlockRecord {
  blockId: string;
  element: HTMLElement;
  card: HTMLElement | null;
  sentences: Map<string, SentenceRecord>;
}

interface SentenceRecord {
  analysis: CorePayload | null;
  provisional: ComponentPayload[] | null;
  tokens: TokenPayload[];
  failed: boolean;
}

interface TokenPayload {
  id: number;
  text: string;
  leadingWhitespace: string;
  punctuation: boolean;
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

  /**
   * 注册（或重新注册）一个块。**重新注册必须连旧句子一起丢掉**：`#sentences` 是
   * 全局映射，`#blocks` 里换了新 BlockRecord 而它还留着旧条目时，`#ensureSentence`
   * 会因「这句已存在」提前返回，新记录的 `sentences` 永远拿不到这一句——`#repaintBlock`
   * 于是算出 `hasContent=false` 并走 `#restoreBlock`，卡片一张都画不出来。
   *
   * 「停止并恢复原文 → 再点开始」正是这条路径：`initialize` 清空防重扫描注册表后
   * 重扫同一批元素，blockId 由元素上的 `data-english-syntax-block` 属性沿用，
   * sentenceId（`s-{blockId}-{index}`）也照旧复用，于是新旧条目精确相撞。
   * （官方 updateDom 重渲染不会撞：整个 body 被换掉，blockId 全部重新分配。）
   */
  registerBlock(blockId: string, element: HTMLElement): void {
    const previous = this.#blocks.get(blockId);
    if (previous !== undefined) {
      for (const sentenceId of previous.sentences.keys()) this.#sentences.delete(sentenceId);
    }
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
          JSON.parse(message.tokensJson ?? "[]") as TokenPayload[],
        );
        break;
      case "CORE_RESULT":
        this.renderCoreResult(
          message.sentenceId,
          message.blockId,
          JSON.parse(message.analysisJson) as CorePayload,
          JSON.parse(message.tokensJson ?? "[]") as TokenPayload[],
        );
        break;
      case "CORE_ERROR":
        this.renderCoreError(
          message.sentenceId,
          message.blockId,
          message.code,
          message.message,
          JSON.parse(message.tokensJson) as TokenPayload[],
        );
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

  renderCoreStream(
    sentenceId: string,
    blockId: string,
    components: ComponentPayload[],
    tokens: TokenPayload[] = [],
  ): void {
    this.#ensureSentence(blockId, sentenceId);
    const entry = this.#sentences.get(sentenceId);
    if (entry === undefined) return;
    entry.record.provisional = components;
    if (tokens.length > 0) entry.record.tokens = tokens;
    const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
    if (!order.includes(sentenceId)) order.push(sentenceId);
    this.#blockSentenceOrder.set(entry.blockId, order);
    this.#repaintBlock(entry.blockId);
  }

  renderCoreResult(
    sentenceId: string,
    blockId: string,
    analysis: CorePayload,
    tokens: TokenPayload[] = [],
  ): void {
    this.#ensureSentence(blockId, sentenceId);
    const entry = this.#sentences.get(sentenceId);
    if (entry === undefined) return;
    entry.record.analysis = analysis;
    if (tokens.length > 0) entry.record.tokens = tokens;
    entry.record.provisional = null;
    entry.record.failed = false;
    this.#sentences.set(sentenceId, entry);
    // 登记句子顺序并重画。
    const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
    if (!order.includes(sentenceId)) order.push(sentenceId);
    this.#blockSentenceOrder.set(entry.blockId, order);
    this.#repaintBlock(entry.blockId);
  }

  renderCoreError(
    sentenceId: string,
    blockId: string,
    code: string,
    message: string,
    tokens: TokenPayload[] = [],
  ): void {
    this.#ensureSentence(blockId, sentenceId);
    const entry = this.#sentences.get(sentenceId);
    if (entry === undefined) return;
    entry.record.failed = true;
    entry.record.analysis = null;
    entry.record.provisional = null;
    if (tokens.length > 0) entry.record.tokens = tokens;
    const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
    if (!order.includes(sentenceId)) order.push(sentenceId);
    this.#blockSentenceOrder.set(entry.blockId, order);
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
    record.sentences.set(sentenceId, { analysis: null, provisional: null, tokens: [], failed: false });
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
   * 占位一出生就走 #anchorDetail 的行判定,和模型返回后那次落位用的是同一套规则——
   * 曾经占位图省事插在句尾(`sentence.after`),详解回来才精确锚定,于是面板先出现在整句
   * 之后、内容到了又跳到被点成分那一行,回归过一次的老毛病就是这个。
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
    this.#anchorDetail(sentence, panel, focusStart, focusEnd);
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

  /** 关闭预览页里所有已打开的详解面板（含加载占位）,并摘掉句子上的块级标记。 */
  #closeAllDetailPanels(): void {
    for (const panel of document.querySelectorAll(".english-syntax-detail")) {
      panel.remove();
    }
    // 块级标记只在「面板插在句内」时才加(见 #anchorDetail)。面板撤了还留着它,句子就一直
    // 撑满整行,把本该与它共行的短句一直压在下一行。
    for (const marked of document.querySelectorAll(".english-syntax-has-detail")) {
      marked.classList.remove("english-syntax-has-detail");
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
    const order = (this.#blockSentenceOrder.get(blockId) ?? []).slice().sort(bySourceOrder);
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
      let nextToken = 0;
      let lastEnglish: HTMLElement | null = null;
      for (const component of components) {
        this.#appendPunctuation(lastEnglish ?? section, sentence.tokens, nextToken, component.startToken - 1);
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
        // cursor 逐元素生效：官方 Markdown 预览页对 span/body 有 cursor:text/default 之类
        // 的全局规则，stylesheet 的 cursor:pointer 无论如何都会被压过（连 !important 也不行）。
        // 唯有 JS 内联样式 + !important 是优先级最高、任何 stylesheet 都压不过的。
        button.style.setProperty("cursor", "pointer", "important");
        for (const child of button.querySelectorAll("*")) {
          child.style.setProperty("cursor", "pointer", "important");
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
        lastEnglish = english;
        nextToken = component.endToken + 1;
      }
      this.#appendPunctuation(lastEnglish ?? section, sentence.tokens, nextToken, sentence.tokens.length - 1);
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
   * 详解面板落位:模型返回后整卡重建，把面板按行判定放回被点成分那一行下面。
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
    this.#anchorDetail(sentence, panel, current.focusStart, current.focusEnd);
  }

  /**
   * 详解面板行锚定（与 Chrome 端 `learning-block.ts#setDetailLoading` 同一套判定）:
   * 面板落在**被点成分所在视觉行**的正下方,两种插法取决于那一行是不是整句最后一行:
   *  * 不是最后一行（长句折行）:插在句内、该行最后一个成分之后。这种句子已经占满栏宽、
   *    不可能与别的句子共行,所以让它变块级(english-syntax-has-detail)没有视觉代价。
   *  * 是最后一行:插到句外、**该视觉行最后一句之后**。短句常与邻句共行,只插在被点句正
   *    后方会把同行的邻句压到面板下面;这一支也绝不能加块级类,否则被点句自己撑满整行,
   *    同样把邻居挤走——两者的表现都是用户看到的「本来一行,点一下变两行」。
   * 行判定依赖真实布局,零尺寸环境（单测）退化为插在句子之后。
   */
  #anchorDetail(
    sentence: HTMLElement,
    panel: HTMLElement,
    focusStart: number,
    focusEnd: number,
  ): void {
    const component = sentence.querySelector<HTMLElement>(
      `.english-syntax-component[data-start-token="${focusStart}"][data-end-token="${focusEnd}"]`,
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
      sentence.classList.add("english-syntax-has-detail");
      anchor.after(panel);
      return;
    }

    sentence.classList.remove("english-syntax-has-detail");
    const sentenceBottom = sentence.getBoundingClientRect().bottom;
    let anchor: Element = sentence;
    for (let next = anchor.nextElementSibling; next !== null; next = next.nextElementSibling) {
      if (!next.classList.contains("english-syntax-sentence")) break;
      if (next.getBoundingClientRect().top >= sentenceBottom) break;
      anchor = next;
    }
    anchor.after(panel);
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
    const tokens = this.#sentences.get(sentenceId)?.record.tokens ?? [];
    return tokens.map(({ leadingWhitespace, text }) => leadingWhitespace + text).join("");
  }

  #structureText(structure: { startToken: number; endToken: number; text?: string }): string {
    return typeof structure.text === "string" ? structure.text : "";
  }

  #appendPunctuation(
    target: HTMLElement,
    tokens: readonly TokenPayload[],
    startToken: number,
    endToken: number,
  ): void {
    for (let index = startToken; index <= endToken; index += 1) {
      const token = tokens[index];
      if (token?.punctuation === true) {
        target.append(
          createElement(
            target.ownerDocument,
            "span",
            "english-syntax-punctuation",
            token.leadingWhitespace + token.text,
          ),
        );
      }
    }
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
    record.sentences.set(sentenceId, { analysis: null, provisional: null, tokens: [], failed: false });
    this.#sentences.set(sentenceId, { blockId, record: record.sentences.get(sentenceId)! });
  }

  /** 测试辅助：确认某句是否已被替换渲染。 */
  isSentenceRendered(sentenceId: string): boolean {
    const entry = this.#sentences.get(sentenceId);
    return entry?.record.analysis !== null && entry?.record.analysis !== undefined;
  }
}
