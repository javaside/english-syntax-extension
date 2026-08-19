/**
 * 预览页句法卡片渲染：可逆替换、流式暂定卡、详解面板。
 *
 * 模型文本一律走 textContent；卡片 Shadow DOM 隔离预览样式；
 * 旧 generation 的消息在入口处丢弃。
 */

import type { HostMessage } from "./bridge";

const HIDDEN_ATTRIBUTE = "data-english-syntax-hidden";
const CARD_TAG = "div";
const CARD_ATTRIBUTE = "data-english-syntax-card";
const BLOCK_ID_ATTRIBUTE = "data-english-syntax-block";

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
  /** 可选英文原文（Kotlin 侧分词后回填；缺失时渲染层不显示英文行）。 */
  text?: string;
}

interface DetailPayload {
  sentenceId: string;
  focus: { startToken: number; endToken: number };
  structures: Array<{ startToken: number; endToken: number; role: string; explanation: string; translation?: string }>;
  grammarPoints: string[];
  explanation: string;
}

export type DetailRequestHandler = (sentenceId: string, focusStart: number, focusEnd: number) => void;

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
        this.renderCoreStream(message.sentenceId, JSON.parse(message.componentsJson) as ComponentPayload[]);
        break;
      case "CORE_RESULT":
        this.renderCoreResult(message.sentenceId, JSON.parse(message.analysisJson) as CorePayload);
        break;
      case "CORE_ERROR":
        this.renderCoreError(message.sentenceId, message.code, message.message);
        break;
      case "DETAIL_STREAM":
      case "DETAIL_RESULT": {
        const payload = JSON.parse(
          message.type === "DETAIL_RESULT" ? message.analysisJson : message.structuresJson,
        ) as DetailPayload | Array<DetailPayload["structures"][number]>;
        if (message.type === "DETAIL_RESULT") {
          this.renderDetailResult(payload as DetailPayload);
        } else {
          this.renderDetailStream(message.sentenceId, payload as DetailPayload["structures"]);
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

  renderCoreStream(sentenceId: string, components: ComponentPayload[]): void {
    const entry = this.#sentences.get(sentenceId);
    if (entry === undefined) return;
    entry.record.provisional = components;
    const order = this.#blockSentenceOrder.get(entry.blockId) ?? [];
    if (!order.includes(sentenceId)) order.push(sentenceId);
    this.#blockSentenceOrder.set(entry.blockId, order);
    this.#repaintBlock(entry.blockId);
  }

  renderCoreResult(sentenceId: string, analysis: CorePayload): void {
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

  renderCoreError(sentenceId: string, code: string, message: string): void {
    void code;
    const entry = this.#sentences.get(sentenceId);
    if (entry === undefined) return;
    entry.record.failed = true;
    entry.record.analysis = null;
    entry.record.provisional = null;
    this.#repaintBlock(entry.blockId, { errorSentenceId: sentenceId, message });
  }

  renderDetailStream(sentenceId: string, structures: DetailPayload["structures"]): void {
    this.#showDetailPanel(sentenceId, structures);
  }

  renderDetailResult(detail: DetailPayload): void {
    this.#showDetailPanel(detail.sentenceId, detail.structures, detail);
  }

  requestDetail(sentenceId: string, focusStart: number, focusEnd: number): void {
    this.#onDetailRequest(sentenceId, focusStart, focusEnd);
  }

  #showDetailPanel(
    sentenceId: string,
    structures: DetailPayload["structures"],
    detail?: DetailPayload,
  ): void {
    const entry = this.#sentences.get(sentenceId);
    if (entry == null) return;
    this.#currentDetail = { sentenceId, focusStart: detail?.focus.startToken ?? 0, focusEnd: detail?.focus.endToken ?? 0 };
    this.#repaintBlock(entry.blockId, { detailStructures: structures, detail });
  }

  closeDetail(): void {
    if (this.#currentDetail === null) return;
    const entry = this.#sentences.get(this.#currentDetail.sentenceId);
    this.#currentDetail = null;
    if (entry != null) this.#repaintBlock(entry.blockId);
  }

  #repaintBlock(
    blockId: string,
    options: { errorSentenceId?: string; message?: string; detailStructures?: DetailPayload["structures"]; detail?: DetailPayload } = {},
  ): void {
    const record = this.#blocks.get(blockId);
    if (record === undefined) return;
    const order = this.#blockSentenceOrder.get(blockId) ?? [];
    const hasContent = order.some((id) => {
      const sentence = record.sentences.get(id);
      return sentence !== undefined && (sentence.analysis !== null || sentence.provisional !== null);
    });
    if (!hasContent && options.errorSentenceId === undefined && options.detailStructures === undefined) {
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
    options: { errorSentenceId?: string; message?: string; detailStructures?: DetailPayload["structures"]; detail?: DetailPayload },
  ): void {
    const card = record.card!;
    const owner = record.element.ownerDocument;
    // 整卡重建：流式分片给的是累积列表，全量重画语义最简单。
    card.replaceChildren();
    const container = owner.createElement("div");
    container.className = "english-syntax-sentences";
    for (const sentenceId of order) {
      const sentence = record.sentences.get(sentenceId);
      if (sentence === undefined) continue;
      const section = owner.createElement("section");
      section.className = "english-syntax-sentence";
      section.dataset.sentenceId = sentenceId;
      const components = sentence.analysis?.components ?? sentence.provisional ?? [];
      if (sentenceId === options.errorSentenceId) {
        const error = owner.createElement("div");
        error.className = "english-syntax-error";
        error.textContent = options.message ?? "解析失败";
        const retry = owner.createElement("button");
        retry.className = "english-syntax-retry";
        retry.type = "button";
        retry.textContent = "重试";
        retry.addEventListener("click", () => this.requestDetail(sentenceId, 0, 0));
        section.append(error, retry);
        container.append(section);
        continue;
      }
      for (const component of components) {
        const button = owner.createElement("button");
        button.type = "button";
        button.className = "english-syntax-component";
        button.dataset.startToken = String(component.startToken);
        button.dataset.endToken = String(component.endToken);
        button.addEventListener("click", () => {
          if (this.#currentDetail?.sentenceId === sentenceId) {
            this.closeDetail();
            return;
          }
          this.requestDetail(sentenceId, component.startToken, component.endToken);
        });
        const role = owner.createElement("span");
        role.className = "english-syntax-role";
        role.textContent = component.role;
        const english = owner.createElement("span");
        english.className = "english-syntax-english";
        english.textContent = this.#componentText(record, sentenceId, component);
        const translation = owner.createElement("span");
        translation.className = "english-syntax-translation";
        translation.textContent = component.translation;
        button.append(role, english, translation);
        section.append(button);
      }
      if (sentence.analysis === null && sentence.provisional !== null) {
        section.classList.add("english-syntax-provisional");
      }
      container.append(section);
    }
    if (options.detailStructures !== undefined || options.detail !== undefined) {
      const panel = owner.createElement("div");
      panel.className = "english-syntax-detail";
      const structures = options.detailStructures ?? options.detail?.structures ?? [];
      for (const structure of structures) {
        const row = owner.createElement("div");
        row.className = "english-syntax-detail-row";
        const role = owner.createElement("span");
        role.className = "english-syntax-detail-role";
        role.textContent = structure.role;
        const english = owner.createElement("span");
        english.className = "english-syntax-detail-english";
        english.textContent = this.#componentText(record, this.#currentDetail?.sentenceId ?? "", structure);
        const translation = owner.createElement("span");
        translation.className = "english-syntax-detail-translation";
        translation.textContent = structure.translation ?? "";
        row.append(role, english, translation);
        panel.append(row);
      }
      if (options.detail?.grammarPoints?.length) {
        const points = owner.createElement("div");
        points.className = "english-syntax-grammar-points";
        points.textContent = options.detail.grammarPoints.join("；");
        panel.append(points);
      }
      if (options.detail?.explanation) {
        const explanation = owner.createElement("div");
        explanation.className = "english-syntax-explanation";
        explanation.textContent = options.detail.explanation;
        panel.append(explanation);
      }
      container.append(panel);
    }
    card.append(container);
  }

  #componentText(record: BlockRecord, sentenceId: string, component: { startToken: number; endToken: number; text?: string }): string {
    // 预览层优先使用 Kotlin 侧回填的 text；缺失时留空（后续由会话层补 token 文本）。
    void record;
    void sentenceId;
    return typeof component.text === "string" ? component.text : "";
  }

  #restoreBlock(record: BlockRecord): void {
    record.element.removeAttribute(HIDDEN_ATTRIBUTE);
    record.card?.remove();
    record.card = null;
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
