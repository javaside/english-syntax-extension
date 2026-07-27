import type { ExtensionError } from "../shared/errors";
import type {
  CoreAnalysis,
  CoreComponent,
  DetailStructure,
  DetailAnalysis,
  Token,
  TokenRange,
} from "../shared/grammar";
import { MAX_SENTENCES_PER_REQUEST } from "../shared/protocol";
import type {
  CoreStreamPush,
  DetailStreamPush,
  RequestMessage,
  ResponseMessage,
  SentenceInput,
  SessionStatus,
} from "../shared/protocol";
import { CORE_SCHEMA_VERSION, MESSAGE_VERSION } from "../shared/versions";
import { createSentenceId, segmentBlock, tokenize } from "../language/segmenter";
import { BlockReplacement } from "./block-replacement";
import type { SentenceFailure } from "./block-replacement";
import { nearestSafeBlock, scanDocument } from "./document-scanner";
import type { CandidateBlock } from "./document-scanner";
import { DetailPrefetcher } from "./detail-prefetcher";
import type { PrefetchSendResult } from "./detail-prefetcher";
import type { SyntaxFocusEventDetail } from "./learning-block";
import { SyntaxLearningBlock } from "./learning-block";
import { ViewportObserver } from "./viewport-observer";

export type SentencePhase =
  | "discovered"
  | "cache-check"
  | "queued"
  | "requesting"
  | "validating"
  | "ready"
  | "failed"
  | "skipped"
  | "stale";

export interface ControllerBlock {
  setExpectedSentenceIds(ids: readonly string[]): void;
  renderCore(sentence: string, tokens: readonly Token[], analysis: CoreAnalysis): void;
  renderFailure(sentenceId: string, sentence: string, message: string): void;
  renderSkipped(sentenceId: string, sentence: string): void;
  setDetailLoading(sentenceId: string, focus: TokenRange): void;
  closeDetails(): void;
  renderDetail(analysis: DetailAnalysis): void;
  renderDetailStructures(
    sentenceId: string,
    focus: TokenRange,
    structures: readonly DetailStructure[],
  ): void;
  renderError(sentenceId: string, focus: TokenRange, message: string): void;
  resetRetry(sentenceId: string, hint?: string): void;
  isReadyToReplace(): boolean;
}

export interface ControllerReplacement {
  show(original: HTMLElement, block: ControllerBlock): void;
  /** 流式预览:跳过"全句齐备"闸门，先把已有的成分放到页面上。 */
  showPreview(original: HTMLElement, block: ControllerBlock): void;
  readonly active: boolean;
  showPartialFailure(
    original: HTMLElement,
    block: ControllerBlock,
    failures: readonly SentenceFailure[],
  ): void;
  restore(): void;
  currentElement(original: HTMLElement): Element;
}

export interface ViewportPort {
  observe(blocks: readonly CandidateBlock[]): void;
  invalidate(blockId: string): void;
  isVisible(element: Element): boolean;
  disconnect(): void;
}

export interface RuntimeTransport {
  send(message: RequestMessage): Promise<ResponseMessage>;
  cancelDocument(documentId: string): void;
  onDisconnect?(handler: () => void): () => void;
  onStream?(handler: (push: CoreStreamPush | DetailStreamPush) => void): () => void;
  reconnect?(): void | Promise<void>;
  dispose?(): void;
}

interface SentenceRecord {
  input: SentenceInput;
  phase: SentencePhase;
  core?: CoreAnalysis;
}

interface BlockRecord {
  candidate: CandidateBlock & { element: HTMLElement };
  sentences: SentenceRecord[];
  learningBlock: ControllerBlock;
  replacement: ControllerReplacement;
  operationVersion: number;
  /** 「重新解析」一次性标记:下次 analyzeBlock 携带 bypassCache 后即清除。 */
  bypassCacheOnce?: boolean;
}

export interface SessionControllerOptions {
  tabId: number;
  documentId?: string;
  document?: Document;
  transport: RuntimeTransport;
  scan?: (root: ParentNode) => CandidateBlock[];
  createSentenceId?: typeof createSentenceId;
  viewportFactory?: (callback: (candidate: CandidateBlock) => void) => ViewportPort;
  learningBlockFactory?: () => ControllerBlock;
  replacementFactory?: () => ControllerReplacement;
  now?: () => number;
  yieldNow?: () => Promise<void>;
  randomUUID?: () => string;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  onTransition?: (sentenceId: string, phase: SentencePhase) => void;
  onStatus?: (status: SessionStatus) => void;
  requestFeedback?: (sentenceId: string) => string | null | Promise<string | null>;
  /** 测试注入：返回当前鼠标悬停的最深元素；默认查询 CSS :hover 链。 */
  hoverTarget?: () => Element | null;
  /** 攒批窗口:视口一次放出的多个段落在这段时间内合并成一条请求。 */
  batchWindowMs?: number;
}

const CONTEXT_ERROR: ExtensionError = {
  code: "UNSAFE_CONTENT_BLOCK",
  message: "请先启动学习模式，或选中文字后解析",
  retryable: false,
};
const HOVER_ERROR: ExtensionError = {
  code: "UNSAFE_CONTENT_BLOCK",
  message: "未找到可解析的段落，请将鼠标悬停在正文段落上",
  retryable: false,
};
const TOO_LONG_MESSAGE = "SENTENCE_TOO_LONG：句子超过 2,000 个规范化字符";
const MISSING_RESULT_MESSAGE = "INVALID_MODEL_OUTPUT：模型未返回此句的解析结果";

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isHTMLElement(element: Element): element is HTMLElement {
  return element instanceof HTMLElement;
}

function normalizedLength(text: string): number {
  return text.trim().replace(/\s+/gu, " ").length;
}

function responseErrorMessage(response: ResponseMessage): string {
  // CORE_RESULT 的批级 error：部分命中时未命中句沿用该错误说明（如鉴权失败），
  // 而不是笼统的"结果缺失"。
  const error =
    response.type === "ERROR"
      ? response.error
      : response.type === "CORE_RESULT"
        ? response.error
        : undefined;
  return error === undefined ? MISSING_RESULT_MESSAGE : `${error.code}：${error.message}`;
}

export class SessionController {
  readonly documentId: string;

  private readonly document: Document;
  private readonly scan: (root: ParentNode) => CandidateBlock[];
  private readonly sentenceIdFactory: typeof createSentenceId;
  private readonly viewport: ViewportPort;
  private readonly now: () => number;
  private readonly yieldNow: () => Promise<void>;
  private readonly scheduleTimeout: NonNullable<SessionControllerOptions["setTimeout"]>;
  private readonly cancelTimeout: NonNullable<SessionControllerOptions["clearTimeout"]>;
  private readonly blocks = new Map<string, BlockRecord>();
  private readonly sentences = new Map<string, SentenceRecord>();
  private readonly pendingRequestIds = new Map<string, number>();
  private readonly pausedBlocks = new Set<string>();
  private readonly changedBlockIds = new Set<string>();
  private readonly mutationRoots = new Set<ParentNode>();
  private readonly ephemeralSelectionAnchors = new Set<HTMLElement>();
  private readonly detailVersions = new Map<string, number>();
  private prefetcher?: DetailPrefetcher;
  private readonly correctionVersions = new Map<string, number>();
  private readonly reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private state: SessionStatus["state"] = "stopped";
  private requestCounter = 0;
  private operationVersion = 0;
  private contextTarget: EventTarget | null = null;
  private mutationObserver?: MutationObserver;
  private mutationTimer?: ReturnType<typeof setTimeout>;
  private removeDisconnectListener?: () => void;
  private removeStreamListener?: () => void;
  private selectedProfileId?: string;
  private scanned = false;
  private cacheOnly = false;
  private readonly batchWindowMs: number;
  /**
   * 待发的可见块，按「是否屏外 × 是否跳过缓存」分桶:前者决定调度优先级，后者是
   * 请求级标记，混进同一条请求会波及别的块。
   */
  private readonly pendingBatches = new Map<
    string,
    {
      blocks: BlockRecord[];
      sentences: number;
      offscreen: boolean;
      bypassCache: boolean;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly hoverTarget: () => Element | null;

  constructor(private readonly options: SessionControllerOptions) {
    this.document = options.document ?? document;
    this.hoverTarget =
      options.hoverTarget ??
      (() => {
        const chain = this.document.querySelectorAll(":hover");
        return chain.length > 0 ? (chain[chain.length - 1] ?? null) : null;
      });
    this.scan = options.scan ?? scanDocument;
    this.batchWindowMs = options.batchWindowMs ?? 120;
    this.sentenceIdFactory = options.createSentenceId ?? createSentenceId;
    this.now = options.now ?? performance.now.bind(performance);
    this.yieldNow = options.yieldNow ?? defaultYield;
    // Wrap the global timers: storing them and calling through `this` would
    // throw "Illegal invocation" in a real Chrome content-script world.
    this.scheduleTimeout = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.documentId =
      options.documentId ?? (options.randomUUID ?? crypto.randomUUID.bind(crypto))();
    this.viewport = (options.viewportFactory ?? ((callback) => new ViewportObserver(callback)))(
      (candidate) => this.queueVisibleBlock(candidate.id),
    );
  }

  get status(): SessionStatus {
    const records = [...this.sentences.values()];
    return {
      state: this.state,
      discovered: records.length,
      queued: records.filter(({ phase }) => phase === "queued").length,
      ready: records.filter(({ phase }) => phase === "ready").length,
      failed: records.filter(({ phase }) => phase === "failed").length,
      skipped: records.filter(({ phase }) => phase === "skipped").length,
      ...(this.cacheOnly ? { cacheOnly: true as const } : {}),
      ...(this.selectedProfileId === undefined ? {} : { profileId: this.selectedProfileId }),
      ...(this.prefetcher === undefined
        ? {}
        : (() => {
            const counts = this.prefetcher.counts();
            return {
              detailTotal: counts.total,
              detailReady: counts.ready,
              detailFailed: counts.failed,
            };
          })()),
    };
  }

  async start(options?: { prefetchDetail?: boolean; scan?: boolean }): Promise<void> {
    const wantScan = options?.scan !== false;
    if (this.state === "running") {
      // 轻量会话（快捷键冷启动）后用户点图标：补建预载器并补做全页扫描，升级为完整会话。
      this.ensurePrefetcher(options);
      if (wantScan) {
        await this.performScan();
        this.emitStatus();
      }
      return;
    }
    if (this.state === "paused") {
      this.resume();
      this.ensurePrefetcher(options);
      if (wantScan) {
        await this.performScan();
        this.emitStatus();
      }
      return;
    }
    this.state = "running";
    this.ensurePrefetcher(options);
    this.document.addEventListener("contextmenu", this.recordContextTarget, true);
    this.document.addEventListener("syntax-detail-request", this.handleDetailEvent);
    this.document.addEventListener("syntax-reanalyze-request", this.handleCorrectionEvent);
    this.document.addEventListener("syntax-correction-request", this.handleExplicitCorrectionEvent);
    this.installMutationObserver();
    this.removeDisconnectListener = this.options.transport.onDisconnect?.(
      this.handleTransportDisconnect,
    );
    this.removeStreamListener = this.options.transport.onStream?.(this.handleStreamPush);
    if (wantScan) await this.performScan();
    this.emitStatus();
  }

  private ensurePrefetcher(options?: { prefetchDetail?: boolean }): void {
    if (options?.prefetchDetail !== true || this.prefetcher !== undefined) return;
    this.prefetcher = new DetailPrefetcher({
      send: (item) => this.sendPrefetch(item.sentence, item.core),
      onChange: () => this.emitStatus(),
    });
  }

  private async performScan(): Promise<void> {
    if (this.scanned) return;
    this.scanned = true;
    const candidates = this.scan(this.document);
    // 升级路径下扫描会以相同 id 重新发现悬停块：重复注册会覆盖 BlockRecord，
    // 让孤儿记录的在途分析多渲染一张卡片、多发一次 ANALYZE_CORE。
    const fresh = candidates.filter(({ id }) => !this.blocks.has(id));
    await this.registerCandidates(fresh);
    this.viewport.observe(candidates);
  }

  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.prefetcher?.pause();
    this.emitStatus();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.prefetcher?.resume();
    const waiting = [...this.pausedBlocks];
    this.pausedBlocks.clear();
    for (const blockId of waiting) this.queueVisibleBlock(blockId);
    this.emitStatus();
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.scanned = false;
    this.cacheOnly = false;
    this.operationVersion += 1;
    this.options.transport.cancelDocument(this.documentId);
    this.prefetcher = undefined;
    this.viewport.disconnect();
    this.mutationObserver?.disconnect();
    this.mutationObserver = undefined;
    if (this.mutationTimer !== undefined) this.cancelTimeout(this.mutationTimer);
    this.mutationTimer = undefined;
    this.removeDisconnectListener?.();
    this.removeDisconnectListener = undefined;
    this.removeStreamListener?.();
    this.removeStreamListener = undefined;
    this.options.transport.dispose?.();
    this.document.removeEventListener("contextmenu", this.recordContextTarget, true);
    this.document.removeEventListener("syntax-detail-request", this.handleDetailEvent);
    this.document.removeEventListener("syntax-reanalyze-request", this.handleCorrectionEvent);
    this.document.removeEventListener(
      "syntax-correction-request",
      this.handleExplicitCorrectionEvent,
    );
    for (const timer of this.reconnectTimers) this.cancelTimeout(timer);
    this.reconnectTimers.clear();
    // 挂起的合批窗口必须取消，否则会话停掉之后还会冒出一条请求。
    for (const pending of this.pendingBatches.values()) this.cancelTimeout(pending.timer);
    this.pendingBatches.clear();
    for (const block of this.blocks.values()) block.replacement.restore();
    for (const anchor of this.ephemeralSelectionAnchors) anchor.remove();
    this.ephemeralSelectionAnchors.clear();
    this.pendingRequestIds.clear();
    this.detailVersions.clear();
    this.correctionVersions.clear();
    this.pausedBlocks.clear();
    this.contextTarget = null;
    this.emitStatus();
  }

  async parseSelection(selectionText: string): Promise<ExtensionError | undefined> {
    const text = selectionText.trim().replace(/\s+/gu, " ");
    if (text.length === 0) return CONTEXT_ERROR;
    if (this.state === "stopped") await this.start();
    const target = this.selectionTarget() ?? this.contextTarget;
    const candidate = nearestSafeBlock(target, { selection: true });
    const element = candidate?.element ?? this.createSelectionAnchor(text);
    const id = `selection-${++this.operationVersion}`;
    const selectionCandidate: CandidateBlock = { id, element, text };
    await this.registerCandidates([selectionCandidate]);
    this.queueVisibleBlock(id, true);
    return undefined;
  }

  async parseContextBlock(): Promise<ExtensionError | undefined> {
    if (this.state === "stopped" || this.contextTarget === null) return CONTEXT_ERROR;
    const candidate = nearestSafeBlock(this.contextTarget);
    if (candidate === null) return CONTEXT_ERROR;
    if (!this.blocks.has(candidate.id)) await this.registerCandidates([candidate]);
    this.queueVisibleBlock(candidate.id, true);
    return undefined;
  }

  async parseHoveredBlock(): Promise<ExtensionError | undefined> {
    // 快捷键可作为页面冷启动入口：轻量启动，不做全页扫描。
    if (this.state === "stopped") await this.start({ scan: false });
    const candidate = nearestSafeBlock(this.hoverTarget());
    if (candidate === null) return HOVER_ERROR;
    if (!this.blocks.has(candidate.id)) await this.registerCandidates([candidate]);
    this.queueVisibleBlock(candidate.id, true);
    return undefined;
  }

  switchProfile(profileId: string): void {
    this.selectedProfileId = profileId;
    this.emitStatus();
  }

  reanalyzeVisible(): void {
    if (this.state === "stopped") return;
    const visibleBlockIds = [...this.blocks.entries()]
      .filter(([, block]) =>
        this.viewport.isVisible(block.replacement.currentElement(block.candidate.element)),
      )
      .map(([blockId]) => blockId);
    for (const blockId of visibleBlockIds) {
      const block = this.blocks.get(blockId);
      if (block !== undefined) block.bypassCacheOnce = true;
      this.invalidateBlock(blockId);
      // 整屏批量操作:绕过暂停门，但合批发送——逐块单发会把请求数放大到块数。
      this.queueVisibleBlock(blockId, true, false);
    }
  }

  async requestDetail(detail: SyntaxFocusEventDetail): Promise<void> {
    const located = this.locateSentence(detail.sentenceId);
    if (located === undefined || located.sentence.core === undefined) {
      return;
    }
    if (this.state !== "running") {
      located.block.learningBlock.resetRetry(detail.sentenceId, "会话已暂停");
      return;
    }
    // Only one explanation panel is open at a time across the whole page, so
    // every open panel closes when this one opens.
    for (const block of this.blocks.values()) {
      block.learningBlock.closeDetails();
    }
    located.block.learningBlock.setDetailLoading(detail.sentenceId, detail.focus);
    const version = ++this.operationVersion;
    const detailKey = `${detail.sentenceId}:${detail.focus.startToken}:${detail.focus.endToken}`;
    this.detailVersions.set(detailKey, version);
    const request = this.pageRequest({
      type: "ANALYZE_DETAIL",
      sentence: located.sentence.input,
      core: located.sentence.core,
      focus: detail.focus,
    });
    const response = await this.send(request, version);
    if (response === undefined || this.detailVersions.get(detailKey) !== version) return;
    this.detailVersions.delete(detailKey);
    if (response.type === "DETAIL_RESULT" && response.analysis.sentenceId === detail.sentenceId) {
      located.block.learningBlock.renderDetail(response.analysis);
    } else {
      located.block.learningBlock.renderError(
        detail.sentenceId,
        detail.focus,
        // NO_CACHE 是纯缓存模式的预期状态而非故障，面板只给中文引导文案、不带错误码前缀。
        response !== undefined && response.type === "ERROR" && response.error.code === "NO_CACHE"
          ? response.error.message
          : response === undefined
            ? "REQUEST_CANCELLED"
            : responseErrorMessage(response),
      );
    }
  }

  /** 预载发送:把 transport 响应归一化为 prefetcher 的三态结果(transport 拒绝由 prefetcher 兜成 failed)。 */
  private async sendPrefetch(
    sentence: SentenceInput,
    core: CoreAnalysis,
  ): Promise<PrefetchSendResult> {
    const response = await this.options.transport.send(
      this.pageRequest({ type: "PREFETCH_SENTENCE_DETAILS", sentence, core }),
    );
    if (response.type === "SENTENCE_DETAILS_RESULT") {
      return { kind: "ok", succeeded: response.succeeded, failed: response.failed };
    }
    if (response.type === "ERROR" && response.error.code === "REQUEST_CANCELLED") {
      return { kind: "cancelled" };
    }
    return { kind: "failed" };
  }

  async submitCorrection(sentenceId: string, feedback: string): Promise<void> {
    const located = this.locateSentence(sentenceId);
    if (
      located === undefined ||
      located.sentence.core === undefined ||
      feedback.trim().length === 0
    ) {
      return;
    }
    if (this.state !== "running") {
      located.block.learningBlock.resetRetry(sentenceId, "会话已暂停");
      return;
    }
    const version = ++this.operationVersion;
    this.correctionVersions.set(sentenceId, version);
    const request = this.pageRequest({
      type: "REANALYZE_WITH_FEEDBACK",
      sentence: located.sentence.input,
      core: located.sentence.core,
      feedback: feedback.trim(),
    });
    const response = await this.send(request, version);
    if (response === undefined || this.correctionVersions.get(sentenceId) !== version) return;
    this.correctionVersions.delete(sentenceId);
    if (response.type === "CORE_RESULT") {
      const corrected = response.analyses.find(({ sentenceId: id }) => id === sentenceId);
      if (corrected !== undefined) {
        located.block.learningBlock.renderCore(
          located.sentence.input.text,
          located.sentence.input.tokens,
          corrected,
        );
        located.sentence.core = corrected;
      }
    }
  }

  invalidateBlock(blockId: string): void {
    const block = this.blocks.get(blockId);
    if (block === undefined) return;
    block.operationVersion = ++this.operationVersion;
    block.replacement.restore();
    this.viewport.invalidate(blockId);
    for (const sentence of block.sentences) {
      sentence.core = undefined;
      this.transition(sentence, "stale");
      this.prefetcher?.discard(sentence.input.sentenceId);
    }
    this.emitStatus();
  }

  private async registerCandidates(candidates: readonly CandidateBlock[]): Promise<void> {
    let windowStartedAt = this.now();
    for (const candidate of candidates) {
      if (!isHTMLElement(candidate.element)) continue;
      const sentenceParts = segmentBlock(candidate.text);
      const sentences: SentenceRecord[] = [];
      for (const [order, part] of sentenceParts.entries()) {
        const sentenceId = await this.sentenceIdFactory({
          sessionId: this.documentId,
          blockId: candidate.id,
          order,
          normalizedText: part.text.trim().replace(/\s+/gu, " "),
        });
        const sentence: SentenceRecord = {
          input: { sentenceId, text: part.text, tokens: tokenize(part.text) },
          phase: "discovered",
        };
        sentences.push(sentence);
        this.sentences.set(sentenceId, sentence);
        this.options.onTransition?.(sentenceId, "discovered");
        if (this.now() - windowStartedAt >= 8) {
          await this.yieldNow();
          windowStartedAt = this.now();
        }
      }
      if (sentences.length === 0) continue;
      const learningBlock = (
        this.options.learningBlockFactory ?? (() => new SyntaxLearningBlock(this.document))
      )();
      learningBlock.setExpectedSentenceIds(sentences.map(({ input }) => input.sentenceId));
      const replacement = (this.options.replacementFactory ?? (() => new BlockReplacement()))();
      this.blocks.set(candidate.id, {
        candidate: { ...candidate, element: candidate.element },
        sentences,
        learningBlock,
        replacement,
        operationVersion: this.operationVersion,
      });
    }
  }

  /**
   * @param force     绕过暂停门（用户显式发起或「重新解析」）
   * @param immediate 跳过合批窗口。单块的用户动作（选中/悬停/右键）要立即发；
   *                  「重新解析」虽然也是用户发起，但它是整屏批量操作，合批更快。
   */
  private queueVisibleBlock(blockId: string, force = false, immediate = force): void {
    const block = this.blocks.get(blockId);
    if (block === undefined || this.state === "stopped") return;
    if (this.state === "paused" && !force) {
      this.pausedBlocks.add(blockId);
      return;
    }
    if (
      block.sentences.every(
        ({ phase }) => phase === "ready" || phase === "failed" || phase === "skipped",
      )
    ) {
      return;
    }
    // 「重新解析」与用户显式发起的解析不进窗口:前者带的 bypassCache 是请求级
    // 标记，混进合批会波及别的块；后者用户正在等，不该为省 token 让他多等。
    if (immediate) {
      void this.analyzeBlocks([block], true);
      return;
    }
    this.enqueueForBatch(block);
  }

  /**
   * 视口的 rootMargin 是 100%，一次会放出十几个段落，而一个段落常常只有 1-2 句。
   * 逐段发的话，2,210 字符的固定指令要在每条请求里重付一遍——单句请求里它占 82%。
   * 攒到上限或窗口到期再发，请求数和总 prefill 都能大幅下降。
   */
  private enqueueForBatch(block: BlockRecord): void {
    const offscreen = !this.viewport.isVisible(
      block.replacement.currentElement(block.candidate.element),
    );
    const bypassCache = block.bypassCacheOnce === true;
    const key = `${String(offscreen)}:${String(bypassCache)}`;
    const sentences = block.sentences.length;
    const pending = this.pendingBatches.get(key);
    if (pending === undefined) {
      // 先入表再起定时器:反过来的话，同步触发的定时器会在条目写入前就跑
      // flushBatch，找不到东西直接返回，这一批就永远发不出去了。
      const entry = {
        blocks: [block],
        sentences,
        offscreen,
        bypassCache,
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
      };
      this.pendingBatches.set(key, entry);
      entry.timer = this.scheduleTimeout(() => this.flushBatch(key), this.batchWindowMs);
    } else {
      pending.blocks.push(block);
      pending.sentences += sentences;
    }
    const current = this.pendingBatches.get(key);
    if (current !== undefined && current.sentences >= MAX_SENTENCES_PER_REQUEST) {
      this.flushBatch(key);
    }
  }

  private flushBatch(key: string): void {
    const pending = this.pendingBatches.get(key);
    if (pending === undefined) return;
    this.pendingBatches.delete(key);
    this.cancelTimeout(pending.timer);
    void this.analyzeBlocks(pending.blocks, false);
  }

  /**
   * 一条 ANALYZE_CORE 覆盖一批块。响应回来后按块分发并各自 finishBlock——
   * 每个块保有自己的 operationVersion 守卫，期间被失效的块会被跳过。
   */
  private async analyzeBlocks(
    blocks: readonly BlockRecord[],
    userInitiated: boolean,
  ): Promise<void> {
    const bypassCache = blocks.some((block) => block.bypassCacheOnce === true);
    for (const block of blocks) block.bypassCacheOnce = undefined;
    const version = ++this.operationVersion;
    for (const block of blocks) block.operationVersion = version;

    // 每块各自的失败清单:超长句在发请求前就判失败，不占用配额。
    const failuresByBlock = new Map<BlockRecord, SentenceFailure[]>(
      blocks.map((block) => [block, []]),
    );
    const outgoingByBlock = new Map<BlockRecord, SentenceRecord[]>();
    for (const block of blocks) {
      const outgoing: SentenceRecord[] = [];
      for (const sentence of block.sentences) {
        this.transition(sentence, "cache-check");
        if (normalizedLength(sentence.input.text) > 2_000) {
          this.transition(sentence, "validating");
          failuresByBlock.get(block)!.push({
            sentenceId: sentence.input.sentenceId,
            sentence: sentence.input.text,
            message: TOO_LONG_MESSAGE,
          });
          this.transition(sentence, "failed");
        } else {
          this.transition(sentence, "queued");
          outgoing.push(sentence);
        }
      }
      outgoingByBlock.set(block, outgoing);
    }

    const allOutgoing = blocks.flatMap((block) => outgoingByBlock.get(block)!);
    if (allOutgoing.length === 0) {
      for (const block of blocks) this.finishBlock(block, failuresByBlock.get(block)!);
      return;
    }
    for (const sentence of allOutgoing) this.transition(sentence, "requesting");

    // 屏外预取块与用户正在读的段落曾同为 visible-core，只按 FIFO 排；从页面中部启动时
    // 上一屏会插在眼前这段之前。显式发起的解析(选中/悬停/右键/重新解析)一律不降级——
    // 选区锚点这类元素可能压根不在视口里。合批时整批同属一个 offscreen 分桶。
    const offscreen =
      !userInitiated &&
      blocks.every(
        (block) =>
          !this.viewport.isVisible(block.replacement.currentElement(block.candidate.element)),
      );
    const request = this.pageRequest({
      type: "ANALYZE_CORE",
      sentences: allOutgoing.map(({ input }) => input),
      ...(bypassCache ? { bypassCache: true as const } : {}),
      ...(offscreen ? { offscreen: true as const } : {}),
    });
    const response = await this.send(request, version);
    if (response === undefined || this.isStopped()) return;

    const analyses = response.type === "CORE_RESULT" ? response.analyses : [];
    const cacheOnly = response.type === "CORE_RESULT" && response.cacheOnly === true;
    if (cacheOnly) this.cacheOnly = true;

    for (const block of blocks) {
      // 逐块校验版本:合批期间某个块被失效(如内容变动)时只跳过它，不连累同批。
      if (block.operationVersion !== version) continue;
      const outgoing = outgoingByBlock.get(block)!;
      const failures = failuresByBlock.get(block)!;
      for (const sentence of outgoing) this.transition(sentence, "validating");
      for (const sentence of outgoing) {
        const analysis = analyses.find(
          ({ sentenceId }) => sentenceId === sentence.input.sentenceId,
        );
        if (analysis === undefined) {
          if (cacheOnly) {
            // 纯缓存会话未命中不算失败：不标红、不给重试。部分命中时未命中句以纯原文
            // 参与替换；整块全未命中则由 finishBlock 的守卫保持页面原始 DOM。
            block.learningBlock.renderSkipped(sentence.input.sentenceId, sentence.input.text);
            this.transition(sentence, "skipped");
            continue;
          }
          failures.push({
            sentenceId: sentence.input.sentenceId,
            sentence: sentence.input.text,
            message: responseErrorMessage(response),
          });
          this.transition(sentence, "failed");
          continue;
        }
        try {
          block.learningBlock.renderCore(sentence.input.text, sentence.input.tokens, analysis);
          sentence.core = analysis;
          this.transition(sentence, "ready");
          this.prefetcher?.enqueue(sentence.input, analysis);
        } catch {
          failures.push({
            sentenceId: sentence.input.sentenceId,
            sentence: sentence.input.text,
            message: MISSING_RESULT_MESSAGE,
          });
          this.transition(sentence, "failed");
        }
      }
      this.finishBlock(block, failures);
    }
  }

  private finishBlock(block: BlockRecord, failures: readonly SentenceFailure[]): void {
    const original = block.candidate.element;
    if (!isHTMLElement(original)) return;
    // 纯缓存会话整块未命中：替换成纯文本副本会丢失页面原有标记，保持原 DOM。
    if (block.sentences.length > 0 && block.sentences.every(({ phase }) => phase === "skipped")) {
      this.emitStatus();
      return;
    }
    if (failures.length > 0) {
      block.replacement.showPartialFailure(original, block.learningBlock, failures);
    } else if (block.learningBlock.isReadyToReplace()) {
      block.replacement.show(original, block.learningBlock);
    }
    this.emitStatus();
  }

  private transition(sentence: SentenceRecord, phase: SentencePhase): void {
    sentence.phase = phase;
    this.options.onTransition?.(sentence.input.sentenceId, phase);
    this.emitStatus();
  }

  private pageRequest<
    T extends Omit<RequestMessage, "version" | "requestId" | "tabId" | "documentId">,
  >(body: T): RequestMessage {
    return {
      ...body,
      version: MESSAGE_VERSION,
      requestId: `${this.documentId}:${++this.requestCounter}`,
      tabId: this.options.tabId,
      documentId: this.documentId,
    } as RequestMessage;
  }

  private async send(
    request: RequestMessage,
    version: number,
  ): Promise<ResponseMessage | undefined> {
    this.pendingRequestIds.set(request.requestId, version);
    try {
      const response = await this.options.transport.send(request);
      if (
        response.version !== MESSAGE_VERSION ||
        response.requestId !== request.requestId ||
        this.pendingRequestIds.get(request.requestId) !== version
      ) {
        return undefined;
      }
      return response;
    } finally {
      this.pendingRequestIds.delete(request.requestId);
    }
  }

  private locateSentence(
    sentenceId: string,
  ): { block: BlockRecord; sentence: SentenceRecord } | undefined {
    const sentence = this.sentences.get(sentenceId);
    if (sentence === undefined) return undefined;
    for (const block of this.blocks.values()) {
      if (block.sentences.includes(sentence)) return { block, sentence };
    }
    return undefined;
  }

  private selectionTarget(): Node | null {
    const selection = this.document.getSelection();
    return selection?.anchorNode ?? null;
  }

  private createSelectionAnchor(text: string): HTMLElement {
    const anchor = this.document.createElement("span");
    anchor.dataset.syntaxLearningSelectionAnchor = "true";
    anchor.textContent = text;
    this.document.body.append(anchor);
    this.ephemeralSelectionAnchors.add(anchor);
    return anchor;
  }

  private readonly recordContextTarget = (event: Event): void => {
    if (this.state !== "stopped") this.contextTarget = event.target;
  };

  private readonly handleDetailEvent = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    void this.requestDetail(event.detail as SyntaxFocusEventDetail);
  };

  private readonly handleCorrectionEvent = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as SyntaxFocusEventDetail;
    const located = this.locateSentence(detail.sentenceId);
    if (located?.sentence.core === undefined) {
      void this.retryCore(detail.sentenceId);
    } else {
      void this.resolveRetryInteraction(detail);
    }
  };

  private async resolveRetryInteraction(detail: SyntaxFocusEventDetail): Promise<void> {
    const feedback = await Promise.resolve(
      this.options.requestFeedback?.(detail.sentenceId) ?? null,
    );
    if (feedback !== null && feedback.trim().length > 0) {
      await this.submitCorrection(detail.sentenceId, feedback);
    } else {
      await this.requestDetail(detail);
    }
  }

  private readonly handleExplicitCorrectionEvent = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as { sentenceId?: unknown; feedback?: unknown };
    if (typeof detail.sentenceId !== "string" || typeof detail.feedback !== "string") return;
    void this.submitCorrection(detail.sentenceId, detail.feedback);
  };

  private async retryCore(sentenceId: string): Promise<void> {
    const located = this.locateSentence(sentenceId);
    if (located === undefined) return;
    if (this.state !== "running") {
      located.block.learningBlock.resetRetry(sentenceId, "会话已暂停");
      return;
    }
    const { block, sentence } = located;
    const version = ++this.operationVersion;
    block.operationVersion = version;
    this.transition(sentence, "queued");
    this.transition(sentence, "requesting");
    const request = this.pageRequest({ type: "ANALYZE_CORE", sentences: [sentence.input] });
    const response = await this.send(request, version);
    if (response === undefined || block.operationVersion !== version || this.isStopped()) {
      return;
    }
    this.transition(sentence, "validating");
    const analysis =
      response.type === "CORE_RESULT"
        ? response.analyses.find(({ sentenceId: id }) => id === sentenceId)
        : undefined;
    if (analysis === undefined) {
      if (response.type === "CORE_RESULT" && response.cacheOnly === true) {
        // 纯缓存会话里重试（如 TOO_LONG 失败句）仍未命中：与 analyzeBlock 同语义，
        // 转 skipped 而非 failed，也不再触发失败替换。
        block.learningBlock.renderSkipped(sentenceId, sentence.input.text);
        this.transition(sentence, "skipped");
        this.finishBlock(block, []);
        return;
      }
      this.transition(sentence, "failed");
      this.finishBlock(block, [
        { sentenceId, sentence: sentence.input.text, message: responseErrorMessage(response) },
      ]);
      return;
    }
    block.learningBlock.renderCore(sentence.input.text, sentence.input.tokens, analysis);
    sentence.core = analysis;
    this.transition(sentence, "ready");
    this.prefetcher?.enqueue(sentence.input, analysis);
    this.finishBlock(block, []);
  }

  private installMutationObserver(): void {
    this.mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target =
          mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (target === null) continue;
        let matchedBlockRoot: ParentNode | null = null;
        for (const [blockId, block] of this.blocks) {
          if (block.candidate.element === target || block.candidate.element.contains(target)) {
            this.changedBlockIds.add(blockId);
            matchedBlockRoot = block.candidate.element.parentElement ?? block.candidate.element;
          }
        }
        const root: ParentNode | null =
          matchedBlockRoot ??
          (mutation.type === "characterData"
            ? (target.parentElement ?? target)
            : (mutation.target as ParentNode));
        if (root !== null) this.mutationRoots.add(root);
      }
      if (
        (this.changedBlockIds.size === 0 && this.mutationRoots.size === 0) ||
        this.mutationTimer !== undefined
      ) {
        return;
      }
      this.mutationTimer = this.scheduleTimeout(() => {
        this.mutationTimer = undefined;
        void this.flushMutations();
      }, 100);
    });
    this.mutationObserver.observe(this.document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  private async flushMutations(): Promise<void> {
    const changed = [...this.changedBlockIds];
    const roots = [...this.mutationRoots];
    this.changedBlockIds.clear();
    this.mutationRoots.clear();
    for (const blockId of changed) {
      const old = this.blocks.get(blockId);
      if (old === undefined) continue;
      this.invalidateBlock(blockId);
      for (const sentence of old.sentences) this.sentences.delete(sentence.input.sentenceId);
      this.blocks.delete(blockId);
    }
    const discovered = new Map<string, CandidateBlock>();
    // 轻量会话（未做全页扫描）只解析悬停那一段：突变不得自动发现新内容并触发解析。
    if (this.scanned) {
      for (const root of roots) {
        for (const candidate of this.scan(root)) {
          if (!this.blocks.has(candidate.id)) discovered.set(candidate.id, candidate);
        }
      }
    }
    const candidates = [...discovered.values()];
    await this.registerCandidates(candidates);
    this.viewport.observe(candidates);
  }

  private async reconnectDelay(delay: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer: { value?: ReturnType<typeof setTimeout> } = {};
      timer.value = this.scheduleTimeout(() => {
        if (timer.value !== undefined) this.reconnectTimers.delete(timer.value);
        resolve();
      }, delay);
      this.reconnectTimers.add(timer.value);
    });
  }

  private unfinishedBlockIds(): string[] {
    return [...this.blocks.values()].flatMap((block) =>
      block.sentences.some(
        ({ phase }) => phase !== "ready" && phase !== "failed" && phase !== "skipped",
      )
        ? [block.candidate.id]
        : [],
    );
  }

  private resumeUnfinishedAfterReconnect(): void {
    for (const blockId of this.unfinishedBlockIds()) {
      if (this.state === "paused") this.pausedBlocks.add(blockId);
      else if (this.state === "running") this.queueVisibleBlock(blockId);
    }
  }

  private readonly handleStreamPush = (push: CoreStreamPush | DetailStreamPush): void => {
    if (push.documentId !== this.documentId) return;
    if (push.type === "CORE_STREAM") {
      this.applyStreamedCore(push.sentenceId, push.components);
      return;
    }
    this.applyStreamedDetail(push.sentenceId, push.focus, push.structures);
  };

  /**
   * 未校验的详解结构:只把已到的标注画进已打开的面板，替换掉"正在加载"。
   * 完整响应到齐后由 renderDetail 覆盖，语法点与整体说明届时才有。
   */
  applyStreamedDetail(
    sentenceId: string,
    focus: TokenRange,
    structures: readonly DetailStructure[],
  ): void {
    if (this.state !== "running" || structures.length === 0) return;
    const detailKey = `${sentenceId}:${focus.startToken}:${focus.endToken}`;
    // 面板已被关闭或已被别的点击取代时，迟到的分片不该再画。
    if (!this.detailVersions.has(detailKey)) return;
    const located = this.locateSentence(sentenceId);
    if (located === undefined) return;
    try {
      located.block.learningBlock.renderDetailStructures(sentenceId, focus, structures);
    } catch {
      // 渲染层拒绝这批暂定结构:放弃预览，等完整结果。
    }
  }

  /**
   * 未经整句校验的暂定成分:只用于让段落尽早出现在页面上。相位保持 requesting，
   * 所以它不计入 ready，也不会让会话被判为已完成;完整响应到齐后会用已校验结果再
   * 渲染一次覆盖掉。
   */
  applyStreamedCore(sentenceId: string, components: readonly CoreComponent[]): void {
    if (this.state !== "running" || components.length === 0) return;
    const located = this.locateSentence(sentenceId);
    if (located === undefined || located.sentence.phase !== "requesting") return;
    const { block, sentence } = located;
    const provisionalAnalysis: CoreAnalysis = {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId,
      components: [...components],
      modelProfileId: this.selectedProfileId ?? "streaming",
    };
    try {
      block.learningBlock.renderCore(
        sentence.input.text,
        sentence.input.tokens,
        provisionalAnalysis,
      );
    } catch {
      // 渲染层拒绝这批暂定成分:放弃预览，等完整结果，不要把异常冒到端口回调里。
      return;
    }
    if (!block.replacement.active) {
      block.replacement.showPreview(block.candidate.element, block.learningBlock);
    }
  }

  private readonly handleTransportDisconnect = (): void => {
    void this.reconnectAndResume();
  };

  private async reconnectAndResume(): Promise<void> {
    if (this.isStopped() || this.options.transport.reconnect === undefined) return;
    const delays = [0, 250, 500, 1_000];
    for (const delay of delays) {
      if (this.isStopped()) return;
      if (delay > 0) await this.reconnectDelay(delay);
      if (this.isStopped()) return;
      try {
        await this.options.transport.reconnect();
        this.resumeUnfinishedAfterReconnect();
        return;
      } catch {
        // The bounded retry schedule handles transient worker startup races.
      }
    }
  }

  private emitStatus(): void {
    this.options.onStatus?.(this.status);
  }

  private isStopped(): boolean {
    return this.state === "stopped";
  }
}
