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

export type PageMessage =
  | PreviewReady
  | VisibleBlocks
  | DetailRequest
  | RetrySentence
  | PreviewRendered
  | ParseBlock;

export type HostMessage =
  | ({ type: "SESSION_STATE"; state: string; ready: number; discovered: number; failed: number } & PageMessageBase)
  | ({ type: "CORE_STREAM"; sentenceId: string; blockId: string; componentsJson: string; tokensJson: string } & PageMessageBase)
  | ({ type: "CORE_RESULT"; sentenceId: string; blockId: string; analysisJson: string; tokensJson: string } & PageMessageBase)
  | ({ type: "CORE_ERROR"; sentenceId: string; blockId: string; code: string; message: string; tokensJson: string } & PageMessageBase)
  | ({ type: "DETAIL_STREAM"; sentenceId: string; focusStart: number; focusEnd: number; structuresJson: string } & PageMessageBase)
  | ({ type: "DETAIL_RESULT"; sentenceId: string; analysisJson: string } & PageMessageBase)
  | ({ type: "RESTORE_ALL" } & PageMessageBase);

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
    default:
      return null;
  }
}
