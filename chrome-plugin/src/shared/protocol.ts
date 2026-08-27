import type { ExtensionError } from "./errors";
import { GrammarRole } from "./grammar";
import type {
  CoreAnalysis,
  CoreComponent,
  DetailAnalysis,
  DetailStructure,
  Token,
  TokenRange,
} from "./grammar";
import { CORE_SCHEMA_VERSION, MESSAGE_VERSION } from "./versions";

interface MessageBase {
  version: typeof MESSAGE_VERSION;
  requestId: string;
}

interface PageRequestBase extends MessageBase {
  tabId: number;
  documentId: string;
}

/**
 * 一条 ANALYZE_CORE 最多带几句。三处共用同一个数字:content 侧按它攒批、
 * 后台按它切块、调度器按它做单请求上限。任一侧自己写一个常量都会漂移。
 */
export const MAX_SENTENCES_PER_REQUEST = 6;

export interface SentenceInput {
  sentenceId: string;
  text: string;
  tokens: Token[];
}

export type RequestMessage =
  | (PageRequestBase & { type: "START_SESSION"; prefetchDetail?: true })
  | (PageRequestBase & { type: "PAUSE_SESSION" })
  | (PageRequestBase & { type: "STOP_SESSION" })
  | (PageRequestBase & { type: "GET_SESSION_STATUS" })
  | (PageRequestBase & { type: "REANALYZE_VISIBLE" })
  | (PageRequestBase & {
      type: "ANALYZE_CORE";
      sentences: SentenceInput[];
      bypassCache?: true;
      /** 视口观察器带 100% rootMargin，会放出屏外一屏的段落：置位让 SW 降为 prefetch-core。 */
      offscreen?: true;
    })
  | (PageRequestBase & {
      type: "ANALYZE_DETAIL";
      sentence: SentenceInput;
      core: CoreAnalysis;
      focus: TokenRange;
    })
  | (PageRequestBase & {
      type: "PREFETCH_SENTENCE_DETAILS";
      sentence: SentenceInput;
      core: CoreAnalysis;
    })
  | (PageRequestBase & {
      type: "REANALYZE_WITH_FEEDBACK";
      sentence: SentenceInput;
      core: CoreAnalysis;
      feedback: string;
    })
  | (PageRequestBase & { type: "SWITCH_PROFILE"; profileId: string })
  | (MessageBase & { type: "TEST_PROFILE"; profileId: string })
  | (MessageBase & { type: "GET_CACHE_STATS" })
  | (MessageBase & { type: "CLEAR_CACHE" })
  | (PageRequestBase & { type: "PARSE_SELECTION"; selectionText: string })
  | (PageRequestBase & { type: "PARSE_CONTEXT_BLOCK" })
  | (PageRequestBase & { type: "PARSE_HOVERED_BLOCK" });

export type SessionState = "stopped" | "running" | "paused";

export interface SessionStatus {
  state: SessionState;
  discovered: number;
  queued: number;
  ready: number;
  failed: number;
  /** 纯缓存会话中未命中而保持原文的句数。 */
  skipped?: number;
  /** 无可用模型配置:本次只查缓存，没有任何模型请求。影响进度提示的措辞。 */
  cacheOnly?: true;
  /** 详解预载:已就绪句子的成分总数(仅预载开启的会话出现)。 */
  /** 在飞的句子数(cache-check + requesting + validating)。判定「当前是否还有工作」用。 */
  inFlight?: number;
  detailTotal?: number;
  /** 详解预载:已确认入缓存的成分数(含预载前已命中缓存的)。 */
  detailReady?: number;
  /** 详解预载:repair 后仍失败的成分数。 */
  detailFailed?: number;
  profileId?: string;
}

/**
 * 「已经出过结果,且当前没有在飞的工作」,而不是「所有发现的句子都出了结果」。
 *
 * discovered 含屏外尚未触发的句子——它们要滚动到可见才入队。按旧口径要求全部
 * 达终态,长页面就永远停在「解析中…」,主按钮不会变成「恢复网页原文」。
 * queued 单独不够:cache-check / requesting / validating 不在它里面,所以要有 inFlight。
 *
 * 又必须要求「至少落地一句」:光有 discovered > 0 挡不住派发之前那些状态——扫描
 * 登记完(全部 discovered 相位)、视口回调还没回来时,queued 与 inFlight 都是 0,
 * 进度胶囊会在 t=0 闪一下「✓ 解析完成」再退回「解析中」。ready/failed/skipped
 * 三者之和 > 0 才说明这一趟真的有句子跑完过。
 */
export function isSessionComplete(status: SessionStatus): boolean {
  const settled = status.ready + status.failed + (status.skipped ?? 0);
  return settled > 0 && status.queued === 0 && (status.inFlight ?? 0) === 0;
}

export interface CacheStats {
  entries: number;
  estimatedBytes: number;
  limitBytes: number;
}

/**
 * SW → content 的单向推送，走 content 已建立的 syntax-learning 端口而不是
 * sendMessage 响应通道。承载的是**未经整句校验**的暂定成分:覆盖率只能在完整响应
 * 到齐后校验，所以这只用于渲染，不写缓存、不改句子相位。
 */
export interface CoreStreamPush {
  version: typeof MESSAGE_VERSION;
  type: "CORE_STREAM";
  documentId: string;
  sentenceId: string;
  components: CoreComponent[];
}

export function isCoreStreamPush(value: unknown): value is CoreStreamPush {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["version", "type", "documentId", "sentenceId", "components"]) &&
    value.version === MESSAGE_VERSION &&
    value.type === "CORE_STREAM" &&
    isNonBlankString(value.documentId) &&
    isNonBlankString(value.sentenceId) &&
    Array.isArray(value.components) &&
    value.components.every(isCoreComponent)
  );
}

/** 详解面板的流式分片。与 CoreStreamPush 同样是未校验的展示态数据。 */
export interface DetailStreamPush {
  version: typeof MESSAGE_VERSION;
  type: "DETAIL_STREAM";
  documentId: string;
  sentenceId: string;
  focus: TokenRange;
  structures: DetailStructure[];
}

function isDetailStructure(value: unknown): value is DetailStructure {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["startToken", "endToken", "role", "explanation", "translation"]) &&
    isNonNegativeSafeInteger(value.startToken) &&
    isNonNegativeSafeInteger(value.endToken) &&
    value.startToken <= value.endToken &&
    isNonBlankString(value.role) &&
    isNonBlankString(value.explanation) &&
    (value.translation === undefined || typeof value.translation === "string")
  );
}

export function isDetailStreamPush(value: unknown): value is DetailStreamPush {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["version", "type", "documentId", "sentenceId", "focus", "structures"]) &&
    value.version === MESSAGE_VERSION &&
    value.type === "DETAIL_STREAM" &&
    isNonBlankString(value.documentId) &&
    isNonBlankString(value.sentenceId) &&
    isTokenRange(value.focus) &&
    Array.isArray(value.structures) &&
    value.structures.every(isDetailStructure)
  );
}

export type ResponseMessage =
  | (MessageBase & { type: "ACK"; acknowledgedType: RequestMessage["type"] })
  | (MessageBase & { type: "SESSION_STATUS"; status: SessionStatus })
  // error：批级失败（如鉴权失败）时仍携带已取得的缓存命中；未命中句由 content 按该错误标失败。
  | (MessageBase & {
      type: "CORE_RESULT";
      analyses: CoreAnalysis[];
      cacheOnly?: true;
      error?: ExtensionError;
    })
  | (MessageBase & { type: "DETAIL_RESULT"; analysis: DetailAnalysis })
  | (MessageBase & { type: "SENTENCE_DETAILS_RESULT"; succeeded: number; failed: number })
  | (MessageBase & { type: "CACHE_STATS"; stats: CacheStats })
  | (MessageBase & {
      type: "PROFILE_TEST_RESULT";
      profileId: string;
      success: boolean;
      latencyMs?: number;
      jsonSchemaSupport?: "supported" | "unsupported";
      error?: ExtensionError;
    })
  | (MessageBase & { type: "ERROR"; error: ExtensionError });

const pageOnlyKeys = ["version", "requestId", "type", "tabId", "documentId"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasPageContext(value: Record<string, unknown>): boolean {
  return isNonNegativeSafeInteger(value.tabId) && isNonBlankString(value.documentId);
}

function isTokenRange(value: unknown): value is TokenRange {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["startToken", "endToken"]) &&
    isNonNegativeSafeInteger(value.startToken) &&
    isNonNegativeSafeInteger(value.endToken) &&
    value.startToken <= value.endToken
  );
}

function isToken(value: unknown): value is Token {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "text", "start", "end", "leadingWhitespace", "punctuation"]) &&
    isNonNegativeSafeInteger(value.id) &&
    typeof value.text === "string" &&
    isNonNegativeSafeInteger(value.start) &&
    isNonNegativeSafeInteger(value.end) &&
    value.start <= value.end &&
    typeof value.leadingWhitespace === "string" &&
    typeof value.punctuation === "boolean"
  );
}

function isSentenceInput(value: unknown): value is SentenceInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["sentenceId", "text", "tokens"]) &&
    isNonBlankString(value.sentenceId) &&
    typeof value.text === "string" &&
    Array.isArray(value.tokens) &&
    value.tokens.every(isToken)
  );
}

const grammarRoles: ReadonlySet<string> = new Set(Object.values(GrammarRole));

function isCoreComponent(value: unknown): value is CoreComponent {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["startToken", "endToken", "role", "translation"]) &&
    isNonNegativeSafeInteger(value.startToken) &&
    isNonNegativeSafeInteger(value.endToken) &&
    value.startToken <= value.endToken &&
    typeof value.role === "string" &&
    grammarRoles.has(value.role) &&
    typeof value.translation === "string"
  );
}

function isCoreAnalysis(value: unknown): value is CoreAnalysis {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["schemaVersion", "sentenceId", "components", "modelProfileId"]) &&
    value.schemaVersion === CORE_SCHEMA_VERSION &&
    isNonBlankString(value.sentenceId) &&
    Array.isArray(value.components) &&
    value.components.every(isCoreComponent) &&
    isNonBlankString(value.modelProfileId)
  );
}

export function isRequestMessage(value: unknown): value is RequestMessage {
  if (
    !isRecord(value) ||
    value.version !== MESSAGE_VERSION ||
    !isNonBlankString(value.requestId) ||
    !isNonBlankString(value.type)
  ) {
    return false;
  }

  switch (value.type) {
    case "PAUSE_SESSION":
    case "STOP_SESSION":
    case "GET_SESSION_STATUS":
    case "REANALYZE_VISIBLE":
    case "PARSE_CONTEXT_BLOCK":
    case "PARSE_HOVERED_BLOCK":
      return hasOnlyKeys(value, pageOnlyKeys) && hasPageContext(value);
    case "START_SESSION":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "prefetchDetail"]) &&
        hasPageContext(value) &&
        (value.prefetchDetail === undefined || value.prefetchDetail === true)
      );
    case "PREFETCH_SENTENCE_DETAILS":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "sentence", "core"]) &&
        hasPageContext(value) &&
        isSentenceInput(value.sentence) &&
        isCoreAnalysis(value.core)
      );
    case "ANALYZE_CORE":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "sentences", "bypassCache", "offscreen"]) &&
        hasPageContext(value) &&
        (value.bypassCache === undefined || value.bypassCache === true) &&
        (value.offscreen === undefined || value.offscreen === true) &&
        Array.isArray(value.sentences) &&
        value.sentences.every(isSentenceInput)
      );
    case "ANALYZE_DETAIL":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "sentence", "core", "focus"]) &&
        hasPageContext(value) &&
        isSentenceInput(value.sentence) &&
        isCoreAnalysis(value.core) &&
        isTokenRange(value.focus)
      );
    case "REANALYZE_WITH_FEEDBACK":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "sentence", "core", "feedback"]) &&
        hasPageContext(value) &&
        isSentenceInput(value.sentence) &&
        isCoreAnalysis(value.core) &&
        isNonBlankString(value.feedback)
      );
    case "SWITCH_PROFILE":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "profileId"]) &&
        hasPageContext(value) &&
        isNonBlankString(value.profileId)
      );
    case "TEST_PROFILE":
      return (
        hasOnlyKeys(value, ["version", "requestId", "type", "profileId"]) &&
        isNonBlankString(value.profileId)
      );
    case "GET_CACHE_STATS":
    case "CLEAR_CACHE":
      return hasOnlyKeys(value, ["version", "requestId", "type"]);
    case "PARSE_SELECTION":
      return (
        hasOnlyKeys(value, [...pageOnlyKeys, "selectionText"]) &&
        hasPageContext(value) &&
        isNonBlankString(value.selectionText)
      );
    default:
      return false;
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
