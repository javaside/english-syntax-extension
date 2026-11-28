/**
 * JCEF 预览页 ↔ Kotlin 的桥接协议（TypeScript 侧）。
 *
 * 与 Kotlin `BridgeProtocol.kt` 镜像：键白名单、字段守卫、generation 门槛。
 * Kotlin → JS 的回调同样复检 generation——旧代次响应直接丢弃，不触碰新 DOM。
 */

export const BRIDGE_VERSION = 1;
// 整页翻译一次上报全文所有段，长文档可达上百段；与 Kotlin BridgeProtocol.MAX_BLOCKS 同步。
export const MAX_BLOCKS = 2000;
export const MAX_BLOCK_TEXT = 20_000;
// 追问对话入站上限（与 Kotlin BridgeProtocol 同步；Chrome 版面板/SW 同值）。
export const MAX_CHAT_HISTORY_TURNS = 6;
export const MAX_CHAT_HISTORY_CHARACTERS = 8000;
export const MAX_CHAT_QUESTION_CHARACTERS = 2000;
// 追问对话段落上下文封顶（与 Kotlin BridgeProtocol 同步；Chrome protocol.ts 同值，
// 五处同值见该文件注释）：current 是提问句所在段、预算最大，before/after 是相邻
// 参考段、预算依次收紧。… 截断标记计入各自上限——门按裸 length ≤ cap 判，不做
// 标记感知；值原样透传不 trim（web 侧计算时已封顶，门只兜底把关）。
export const MAX_CHAT_SURROUNDING_BEFORE_CHARS = 1200;
export const MAX_CHAT_SURROUNDING_CURRENT_CHARS = 4000;
export const MAX_CHAT_SURROUNDING_AFTER_CHARS = 800;
// 纠正反馈入站上限（与 Kotlin BridgeProtocol.MAX_FEEDBACK_CHARACTERS 同步；CHAT_ASK question 同值同款）。
export const MAX_FEEDBACK_CHARACTERS = 2000;

// 朗读文本入站上限（与 Kotlin BridgeProtocol.MAX_TTS_TEXT_CHARACTERS 同步；feedback/question 同值同款）。
export const MAX_TTS_TEXT_CHARACTERS = 2000;

export interface PageMessageBase {
  version: number;
  previewId: string;
  generation: number;
}

export interface PreviewReady extends PageMessageBase {
  type: "PREVIEW_READY";
}

export interface VisibleBlockText {
  blockId: string;
  text: string;
}

export interface VisibleBlocks extends PageMessageBase {
  type: "VISIBLE_BLOCKS";
  blocks: VisibleBlockText[];
}

export interface DetailRequest extends PageMessageBase {
  type: "DETAIL_REQUEST";
  sentenceId: string;
  focus: { startToken: number; endToken: number };
}

export interface RetrySentence extends PageMessageBase {
  type: "RETRY_SENTENCE";
  sentenceId: string;
}

export interface PreviewRendered extends PageMessageBase {
  type: "PREVIEW_RENDERED";
}

/**
 * 显式手势：页面已定位好段落，只解析这一段（快捷键悬停解析）。
 * 与 [VisibleBlocks] 分开是有意的——后者是自动扫描的批量上报，前者是用户手势，
 * Kotlin 侧的优先级、合批与暂停语义都不同。
 */
export interface ParseBlock extends PageMessageBase {
  type: "PARSE_BLOCK";
  blockId: string;
  text: string;
}

/** 追问对话的一轮历史：用户提问或模型回答（不含 system——系统指令由 Kotlin 侧拼）。 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * 追问对话的段落级参考上下文：提问句所在段（current）与前后段（before/after）的
 * 原文。三键全部可选，但 parse 门要求至少一键在场；值由页面侧计算时已封顶截断
 * （… 标记计入上限），过桥只校验不改写——与 question 在门里 trim 的做法刻意不同：
 * 机器输出只校验，用户输入才规范化。与 Kotlin `PageMessage.ChatAsk.ChatSurroundings`
 * 镜像。
 */
export interface ChatSurroundings {
  before?: string;
  current?: string;
  after?: string;
}

/**
 * 追问对话（JS→Kotlin）：基于该句已核实分析继续多轮提问。句子锚点上下文不过桥——
 * Kotlin 侧从 SentenceRecord 重建；surroundings 是可选的段落级参考上下文（本段 +
 * 前后邻段原文），桥门只校验不改写。question 为 trim 后 1..2000、history ≤6 项/
 * ≤8000 字符、surroundings 各键 trim 后非空且 ≤ 对应封顶的上限在 parse 里结构化
 * 校验（防伪造门）。
 */
export interface ChatAskPageMessage extends PageMessageBase {
  type: "CHAT_ASK";
  conversationId: string;
  sentenceId: string;
  history: ChatTurn[];
  question: string;
  surroundings?: ChatSurroundings;
}

/**
 * 纠正反馈（JS→Kotlin，F2）：对已核实划分的一次性纠正请求。成功结果复用
 * CORE_RESULT（blockId = 句所在块），失败回 FEEDBACK_ERROR——都不在本类型里。
 * feedback 为 trim 后 1..2000 的上限在 parse 里结构化校验（CHAT_ASK 同款）。
 */
export interface FeedbackRequestPageMessage extends PageMessageBase {
  type: "FEEDBACK_REQUEST";
  sentenceId: string;
  feedback: string;
}

/**
 * 朗读（JS→Kotlin）：text 为待朗读英文，trim 后 1..MAX_TTS_TEXT_CHARACTERS 在
 * parse 里结构化校验（feedback 同款防伪造门）。失败结果走 TTS_ERROR host 消息。
 */
export interface TtsSpeakPageMessage extends PageMessageBase {
  type: "TTS_SPEAK";
  sentenceId: string;
  text: string;
}

/** 停止当前朗读（JS→Kotlin）。 */
export interface TtsStopPageMessage extends PageMessageBase {
  type: "TTS_STOP";
}

// CHAT_* 三条 host 消息均带 generation（parseHostMessage 顶部的等值门槛自动过滤
// 旧代次）与 conversationId（面板侧第二道防线按它丢弃非本会话的迟到消息）。
// CHAT_STREAM.text 是「截至目前的完整回答」而非增量——全量替换渲染，重试安全。
export interface ChatStreamHostMessage extends PageMessageBase {
  type: "CHAT_STREAM";
  conversationId: string;
  text: string;
}

/** 追问对话的最终全文（以缓冲答案为准收尾，防流式尾片丢失）。 */
export interface ChatResultHostMessage extends PageMessageBase {
  type: "CHAT_RESULT";
  conversationId: string;
  answer: string;
}

/** 追问对话失败（无 profile / 请求失败 / 原句失效）：人类可读文案，无 code 字段。 */
export interface ChatErrorHostMessage extends PageMessageBase {
  type: "CHAT_ERROR";
  conversationId: string;
  message: string;
}

/**
 * 纠正反馈失败（F2）：与 CHAT_ERROR 平行、按 sentenceId 关联（不混淆会话）。
 * 带 generation（parseHostMessage 顶部的等值门槛自动过滤旧代次）；无 code 字段。
 */
export interface FeedbackErrorHostMessage extends PageMessageBase {
  type: "FEEDBACK_ERROR";
  sentenceId: string;
  message: string;
}

/** 朗读失败（命令不存在/进程异常）：复位该句按下态并提示，无 code 字段。 */
export interface TtsErrorHostMessage extends PageMessageBase {
  type: "TTS_ERROR";
  sentenceId: string;
  message: string;
}

export type PageMessage =
  | PreviewReady
  | VisibleBlocks
  | DetailRequest
  | RetrySentence
  | PreviewRendered
  | ParseBlock
  | ChatAskPageMessage
  | FeedbackRequestPageMessage
  | TtsSpeakPageMessage
  | TtsStopPageMessage;

export type HostMessage =
  | ({ type: "SESSION_STATE"; state: string; ready: number; discovered: number; failed: number } & PageMessageBase)
  | ({ type: "CORE_STREAM"; sentenceId: string; blockId: string; componentsJson: string; tokensJson: string } & PageMessageBase)
  | ({ type: "CORE_RESULT"; sentenceId: string; blockId: string; analysisJson: string; tokensJson: string } & PageMessageBase)
  | ({ type: "CORE_ERROR"; sentenceId: string; blockId: string; code: string; message: string; tokensJson: string } & PageMessageBase)
  | ({ type: "DETAIL_STREAM"; sentenceId: string; focusStart: number; focusEnd: number; structuresJson: string } & PageMessageBase)
  | ({ type: "DETAIL_RESULT"; sentenceId: string; analysisJson: string } & PageMessageBase)
  | ({ type: "RESTORE_ALL" } & PageMessageBase)
  | ChatStreamHostMessage
  | ChatResultHostMessage
  | ChatErrorHostMessage
  | FeedbackErrorHostMessage
  | TtsErrorHostMessage;

const FORBIDDEN_KEYS = new Set(["apiKey", "headers", "baseUrl"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const PAGE_KEYS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  PREVIEW_READY: ["version", "type", "previewId", "generation"],
  VISIBLE_BLOCKS: ["version", "type", "previewId", "generation", "blocks"],
  DETAIL_REQUEST: ["version", "type", "previewId", "generation", "sentenceId", "focus"],
  RETRY_SENTENCE: ["version", "type", "previewId", "generation", "sentenceId"],
  PREVIEW_RENDERED: ["version", "type", "previewId", "generation"],
  PARSE_BLOCK: ["version", "type", "previewId", "generation", "blockId", "text"],
  CHAT_ASK: ["version", "type", "previewId", "generation", "conversationId", "sentenceId", "history", "question", "surroundings"],
  FEEDBACK_REQUEST: ["version", "type", "previewId", "generation", "sentenceId", "feedback"],
  TTS_SPEAK: ["version", "type", "previewId", "generation", "sentenceId", "text"],
  TTS_STOP: ["version", "type", "previewId", "generation"],
};

/** JS → Kotlin 方向：白名单校验后返回封闭联合，或 null 表示拒绝。 */
export function parsePageMessage(value: unknown): PageMessage | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key))) return null;
  if (value.version !== BRIDGE_VERSION) return null;
  if (!isNonEmptyString(value.previewId)) return null;
  if (!isNonNegativeInt(value.generation)) return null;

  switch (value.type) {
    case "PREVIEW_READY": {
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.PREVIEW_READY!)) return null;
      return {
        version: BRIDGE_VERSION,
        type: "PREVIEW_READY",
        previewId: value.previewId,
        generation: value.generation,
      };
    }
    case "VISIBLE_BLOCKS": {
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.VISIBLE_BLOCKS!)) return null;
      if (
        !Array.isArray(value.blocks) ||
        value.blocks.length === 0 ||
        value.blocks.length > MAX_BLOCKS
      )
        return null;
      const blocks: VisibleBlockText[] = [];
      for (const block of value.blocks) {
        if (!isRecord(block)) return null;
        if (!hasOnlyKeys(block, ["blockId", "text"])) return null;
        if (!isNonEmptyString(block.blockId)) return null;
        if (typeof block.text !== "string" || block.text.length > MAX_BLOCK_TEXT) return null;
        blocks.push({ blockId: block.blockId, text: block.text });
      }
      return {
        version: BRIDGE_VERSION,
        type: "VISIBLE_BLOCKS",
        previewId: value.previewId,
        generation: value.generation,
        blocks,
      };
    }
    case "DETAIL_REQUEST": {
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.DETAIL_REQUEST!)) return null;
      if (!isNonEmptyString(value.sentenceId)) return null;
      if (!isRecord(value.focus)) return null;
      if (!hasOnlyKeys(value.focus, ["startToken", "endToken"])) return null;
      const { startToken, endToken } = value.focus;
      if (!isNonNegativeInt(startToken) || !isNonNegativeInt(endToken) || endToken < startToken)
        return null;
      return {
        version: BRIDGE_VERSION,
        type: "DETAIL_REQUEST",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        focus: { startToken, endToken },
      };
    }
    case "RETRY_SENTENCE": {
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.RETRY_SENTENCE!)) return null;
      if (!isNonEmptyString(value.sentenceId)) return null;
      return {
        version: BRIDGE_VERSION,
        type: "RETRY_SENTENCE",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
      };
    }
    case "PREVIEW_RENDERED": {
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.PREVIEW_RENDERED!)) return null;
      return {
        version: BRIDGE_VERSION,
        type: "PREVIEW_RENDERED",
        previewId: value.previewId,
        generation: value.generation,
      };
    }
    case "PARSE_BLOCK": {
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.PARSE_BLOCK!)) return null;
      if (!isNonEmptyString(value.blockId)) return null;
      if (typeof value.text !== "string" || value.text.length > MAX_BLOCK_TEXT) return null;
      return {
        version: BRIDGE_VERSION,
        type: "PARSE_BLOCK",
        previewId: value.previewId,
        generation: value.generation,
        blockId: value.blockId,
        text: value.text,
      };
    }
    case "CHAT_ASK": {
      // 防伪造门（与 Kotlin parseChatAsk 镜像）：形状 + 数量上限都在这里判。
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.CHAT_ASK!)) return null;
      if (!isNonEmptyString(value.conversationId)) return null;
      if (!isNonEmptyString(value.sentenceId)) return null;
      if (typeof value.question !== "string") return null;
      // trim 在门里做掉（Chrome SW 同款）：1..2000 按 trim 后计。
      const question = value.question.trim();
      if (question.length === 0 || question.length > MAX_CHAT_QUESTION_CHARACTERS) return null;
      if (!Array.isArray(value.history)) return null;
      if (value.history.length > MAX_CHAT_HISTORY_TURNS) return null;
      const history: ChatTurn[] = [];
      let historyCharacters = 0;
      for (const turn of value.history) {
        if (!isRecord(turn)) return null;
        if (!hasOnlyKeys(turn, ["role", "content"])) return null;
        if (turn.role !== "user" && turn.role !== "assistant") return null;
        if (typeof turn.content !== "string" || turn.content.trim().length === 0) return null;
        historyCharacters += turn.content.length;
        if (historyCharacters > MAX_CHAT_HISTORY_CHARACTERS) return null;
        history.push({ role: turn.role, content: turn.content });
      }
      // 段落上下文封顶门（与 Kotlin parseChatAsk 的 surroundings 分支镜像）：
      // 键缺席即无上下文（合法）；在场须为 record、键集恰为 before/current/after 的
      // 子集且至少一键在场、每个在场键是 trim() 非空且不超对应封顶的 string。
      // 值原样透传不 trim——surroundings 是机器算好的已封顶文本（… 标记计入上限），
      // question 在门里 trim 的做法刻意不复制。
      let surroundings: ChatSurroundings | undefined;
      if (value.surroundings !== undefined) {
        const raw = value.surroundings;
        if (!isRecord(raw)) return null;
        if (!hasOnlyKeys(raw, ["before", "current", "after"])) return null;
        const { before, current, after } = raw;
        if (before === undefined && current === undefined && after === undefined) return null;
        const parsed: ChatSurroundings = {};
        if (before !== undefined) {
          if (
            typeof before !== "string" ||
            before.trim().length === 0 ||
            before.length > MAX_CHAT_SURROUNDING_BEFORE_CHARS
          )
            return null;
          parsed.before = before;
        }
        if (current !== undefined) {
          if (
            typeof current !== "string" ||
            current.trim().length === 0 ||
            current.length > MAX_CHAT_SURROUNDING_CURRENT_CHARS
          )
            return null;
          parsed.current = current;
        }
        if (after !== undefined) {
          if (
            typeof after !== "string" ||
            after.trim().length === 0 ||
            after.length > MAX_CHAT_SURROUNDING_AFTER_CHARS
          )
            return null;
          parsed.after = after;
        }
        surroundings = parsed;
      }
      return {
        version: BRIDGE_VERSION,
        type: "CHAT_ASK",
        previewId: value.previewId,
        generation: value.generation,
        conversationId: value.conversationId,
        sentenceId: value.sentenceId,
        history,
        question,
        surroundings,
      };
    }
    case "FEEDBACK_REQUEST": {
      // 防伪造门（与 Kotlin parseFeedbackRequest 镜像）：键白名单 + trim 后 1..2000。
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.FEEDBACK_REQUEST!)) return null;
      if (!isNonEmptyString(value.sentenceId)) return null;
      if (typeof value.feedback !== "string") return null;
      const feedback = value.feedback.trim();
      if (feedback.length === 0 || feedback.length > MAX_FEEDBACK_CHARACTERS) return null;
      return {
        version: BRIDGE_VERSION,
        type: "FEEDBACK_REQUEST",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        feedback,
      };
    }
    case "TTS_SPEAK": {
      // 防伪造门（与 Kotlin parseTtsSpeak 镜像）：六键白名单 + trim 后 1..2000。
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.TTS_SPEAK!)) return null;
      if (!isNonEmptyString(value.sentenceId)) return null;
      if (typeof value.text !== "string") return null;
      const text = value.text.trim();
      if (text.length === 0 || text.length > MAX_TTS_TEXT_CHARACTERS) return null;
      return {
        version: BRIDGE_VERSION,
        type: "TTS_SPEAK",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        text,
      };
    }
    case "TTS_STOP": {
      if (!hasOnlyKeys(value, PAGE_KEYS_BY_TYPE.TTS_STOP!)) return null;
      return {
        version: BRIDGE_VERSION,
        type: "TTS_STOP",
        previewId: value.previewId,
        generation: value.generation,
      };
    }
    default:
      return null;
  }
}

const HOST_KEYS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  SESSION_STATE: ["version", "type", "previewId", "generation", "state", "ready", "discovered", "failed"],
  CORE_STREAM: ["version", "type", "previewId", "generation", "sentenceId", "blockId", "componentsJson", "tokensJson"],
  CORE_RESULT: ["version", "type", "previewId", "generation", "sentenceId", "blockId", "analysisJson", "tokensJson"],
  CORE_ERROR: ["version", "type", "previewId", "generation", "sentenceId", "blockId", "code", "message", "tokensJson"],
  DETAIL_STREAM: ["version", "type", "previewId", "generation", "sentenceId", "focusStart", "focusEnd", "structuresJson"],
  DETAIL_RESULT: ["version", "type", "previewId", "generation", "sentenceId", "analysisJson"],
  RESTORE_ALL: ["version", "type", "previewId", "generation"],
  CHAT_STREAM: ["version", "type", "previewId", "generation", "conversationId", "text"],
  CHAT_RESULT: ["version", "type", "previewId", "generation", "conversationId", "answer"],
  CHAT_ERROR: ["version", "type", "previewId", "generation", "conversationId", "message"],
  FEEDBACK_ERROR: ["version", "type", "previewId", "generation", "sentenceId", "message"],
  TTS_ERROR: ["version", "type", "previewId", "generation", "sentenceId", "message"],
};

/** Kotlin → JS 方向：同款白名单 + generation 复检。 */
export function parseHostMessage(value: unknown, currentGeneration: number): HostMessage | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key))) return null;
  if (value.version !== BRIDGE_VERSION) return null;
  if (!isNonEmptyString(value.previewId)) return null;
  if (!isNonNegativeInt(value.generation)) return null;
  // 旧代次响应一律丢弃——新 DOM 不能被上一轮预览的迟到消息污染。
  if (value.generation !== currentGeneration) return null;

  const allowed = HOST_KEYS_BY_TYPE[value.type as string];
  if (!allowed || !hasOnlyKeys(value, allowed)) return null;

  switch (value.type) {
    case "SESSION_STATE":
      if (!isNonEmptyString(value.state)) return null;
      if (!isNonNegativeInt(value.ready) || !isNonNegativeInt(value.discovered)) return null;
      // failed 为可选（旧版本消息不带），兼容。
      if (value.failed !== undefined && !isNonNegativeInt(value.failed)) return null;
      return {
        version: BRIDGE_VERSION,
        type: "SESSION_STATE",
        previewId: value.previewId,
        generation: value.generation,
        state: value.state,
        ready: value.ready,
        discovered: value.discovered,
        failed: value.failed ?? 0,
      };
    case "CORE_STREAM":
    case "CORE_RESULT":
      if (!isNonEmptyString(value.sentenceId) || !isNonEmptyString(value.blockId)) return null;
      if (typeof value.tokensJson !== "string") return null;
      if (value.type === "CORE_STREAM") {
        if (typeof value.componentsJson !== "string") return null;
        return {
          version: BRIDGE_VERSION,
          type: "CORE_STREAM",
          previewId: value.previewId,
          generation: value.generation,
          sentenceId: value.sentenceId,
          blockId: value.blockId,
          componentsJson: value.componentsJson,
          tokensJson: value.tokensJson,
        };
      }
      if (typeof value.analysisJson !== "string") return null;
      return {
        version: BRIDGE_VERSION,
        type: "CORE_RESULT",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        blockId: value.blockId,
        analysisJson: value.analysisJson,
        tokensJson: value.tokensJson,
      };
    case "DETAIL_RESULT":
      if (!isNonEmptyString(value.sentenceId) || typeof value.analysisJson !== "string") return null;
      return {
        version: BRIDGE_VERSION,
        type: "DETAIL_RESULT",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        analysisJson: value.analysisJson,
      };
    case "DETAIL_STREAM":
      if (!isNonEmptyString(value.sentenceId) || typeof value.structuresJson !== "string")
        return null;
      if (!isNonNegativeInt(value.focusStart) || !isNonNegativeInt(value.focusEnd)) return null;
      if (value.focusEnd < value.focusStart) return null;
      return {
        version: BRIDGE_VERSION,
        type: "DETAIL_STREAM",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        focusStart: value.focusStart,
        focusEnd: value.focusEnd,
        structuresJson: value.structuresJson,
      };
    case "CORE_ERROR":
      if (
        !isNonEmptyString(value.sentenceId) ||
        !isNonEmptyString(value.blockId) ||
        !isNonEmptyString(value.code)
      )
        return null;
      if (typeof value.message !== "string" || typeof value.tokensJson !== "string") return null;
      return {
        version: BRIDGE_VERSION,
        type: "CORE_ERROR",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        blockId: value.blockId,
        code: value.code,
        message: value.message,
        tokensJson: value.tokensJson,
      };
    case "RESTORE_ALL":
      return {
        version: BRIDGE_VERSION,
        type: "RESTORE_ALL",
        previewId: value.previewId,
        generation: value.generation,
      };
    // CHAT_* 三条：generation 等值门槛已在函数顶部统一生效，这里只补各自字段守卫。
    case "CHAT_STREAM":
      if (!isNonEmptyString(value.conversationId)) return null;
      if (typeof value.text !== "string") return null;
      return {
        version: BRIDGE_VERSION,
        type: "CHAT_STREAM",
        previewId: value.previewId,
        generation: value.generation,
        conversationId: value.conversationId,
        text: value.text,
      };
    case "CHAT_RESULT":
      if (!isNonEmptyString(value.conversationId)) return null;
      if (typeof value.answer !== "string") return null;
      return {
        version: BRIDGE_VERSION,
        type: "CHAT_RESULT",
        previewId: value.previewId,
        generation: value.generation,
        conversationId: value.conversationId,
        answer: value.answer,
      };
    case "CHAT_ERROR":
      if (!isNonEmptyString(value.conversationId)) return null;
      if (typeof value.message !== "string") return null;
      return {
        version: BRIDGE_VERSION,
        type: "CHAT_ERROR",
        previewId: value.previewId,
        generation: value.generation,
        conversationId: value.conversationId,
        message: value.message,
      };
    // F2 纠正反馈失败：generation 等值门槛已在函数顶部统一生效，这里补 sentenceId/message 守卫。
    case "FEEDBACK_ERROR":
      if (!isNonEmptyString(value.sentenceId)) return null;
      if (typeof value.message !== "string") return null;
      return {
        version: BRIDGE_VERSION,
        type: "FEEDBACK_ERROR",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        message: value.message,
      };
    case "TTS_ERROR":
      if (!isNonEmptyString(value.sentenceId)) return null;
      if (typeof value.message !== "string") return null;
      return {
        version: BRIDGE_VERSION,
        type: "TTS_ERROR",
        previewId: value.previewId,
        generation: value.generation,
        sentenceId: value.sentenceId,
        message: value.message,
      };
    default:
      return null;
  }
}
