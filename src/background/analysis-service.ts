import type { ExtensionError } from "../shared/errors";
import { GrammarRole } from "../shared/grammar";
import type {
  CoreAnalysis,
  CoreComponent,
  DetailAnalysis,
  DetailStructure,
  TokenRange,
} from "../shared/grammar";
import { MAX_SENTENCES_PER_REQUEST } from "../shared/protocol";
import { isLoopbackBaseUrl } from "./base-url";
import type { SentenceInput } from "../shared/protocol";
import { CORE_SCHEMA_VERSION } from "../shared/versions";
import { validateCoreBatch, validateDetail } from "../language/analysis-validator";
import type { ValidationError } from "../language/analysis-validator";
import { createCoreCacheKey, createCorrectionCacheKey } from "./analysis-cache";
import type { ModelProfile } from "./config-repository";
import { ModelRequestError } from "./openai-compatible-adapter";
import type { ChatMessage, JsonSchemaSpec } from "./openai-compatible-adapter";
import {
  buildCorePrompt,
  buildDetailPrompt,
  buildRepairPrompt,
  buildSentenceDetailsPrompt,
  CORE_OUTPUT_SHAPE,
  PROMPT_FIRST_LINES,
  serialize,
  serializeSentence,
} from "./prompts";
import type { StreamedComponent } from "./core-stream-parser";
import type { ScheduledRequest, SchedulerPriority } from "./request-scheduler";

/**
 * 云端 API 的耗时几乎只由输出 token 决定——实测 TTFT 恒定 ~0.65s 且与输入大小
 * 无关,总时 ≈ 0.65s + 输出token/190。把多句塞进一条请求,就是让这些输出排成
 * 一队串行生成:同样 6 句,1 条 6 句 8.0s,3 条 2 句并发 3.1s。
 *
 * 本地(loopback)模型的取舍相反:它串行处理请求,请求数才是杠杆,合并成大块才快
 * (CHANGELOG 1.0.4 记录的收益)。所以这里按端点分流,不能一刀切。
 */
export const CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT = 2;
const CLOUD_SENTENCES_PER_REQUEST = CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT;

function sentencesPerRequest(baseUrl: string): number {
  return isLoopbackBaseUrl(baseUrl) ? MAX_SENTENCES_PER_REQUEST : CLOUD_SENTENCES_PER_REQUEST;
}

export interface AnalysisCachePort {
  getCore<T>(key: string): Promise<T | undefined>;
  putCore<T>(key: string, profileId: string, value: T): Promise<void>;
  getDetail<T>(key: string): Promise<T | undefined>;
  putDetail<T>(key: string, profileId: string, value: T): Promise<void>;
  getCorrection<T>(key: string): Promise<T | undefined>;
  putCorrection<T>(key: string, profileId: string, value: T): Promise<void>;
}

export interface AnalysisAdapter {
  completeJson(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    signal: AbortSignal,
  ): Promise<unknown>;
  completeJsonStreaming?(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    signal: AbortSignal,
    onComponent: (streamed: StreamedComponent) => void,
  ): Promise<unknown>;
  completeDetailStreaming?(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    signal: AbortSignal,
    onStructure: (structure: Record<string, unknown>) => void,
  ): Promise<unknown>;
}

/** 累积上报某次详解已完成的结构;每次给的都是完整列表，渲染端整块重画即可。 */
export type StreamedStructureSink = (
  sentenceId: string,
  focus: TokenRange,
  structures: readonly DetailStructure[],
) => void;

/** 累积上报某句已接受的暂定成分;每次给的都是完整列表，渲染端整句重画即可。 */
export type StreamedComponentSink = (
  sentenceId: string,
  components: readonly CoreComponent[],
) => void;

export interface AnalysisModelWork {
  profile: ModelProfile;
  messages: readonly ChatMessage[];
  schema: JsonSchemaSpec;
  requestedAt: number;
  run(signal: AbortSignal): Promise<unknown>;
}

export type AnalysisScheduledRequest = ScheduledRequest<AnalysisModelWork>;

export interface AnalysisScheduler {
  schedule(request: AnalysisScheduledRequest): Promise<unknown>;
  cancelDocument(documentId: string): void;
}

interface AnalysisInputBase {
  profile: ModelProfile;
  documentId: string;
}

export interface CoreBatchInput extends AnalysisInputBase {
  sentences: readonly SentenceInput[];
  priority?: Extract<SchedulerPriority, "visible-core" | "prefetch-core">;
  /** 「重新解析」置位:跳过读缓存,结果照常覆盖写回。 */
  bypassCache?: boolean;
  /** 给出即走流式:边生成边上报暂定成分。缺省保持原来的整块缓冲路径。 */
  onStreamedComponent?: StreamedComponentSink;
}

export interface DetailInput extends AnalysisInputBase {
  sentence: SentenceInput;
  core: CoreAnalysis;
  focus: TokenRange;
  /** 给出即走流式:边生成边上报已完成的结构。缺省保持整段缓冲路径。 */
  onStreamedStructure?: StreamedStructureSink;
}

export interface DetailLookupInput {
  sentence: SentenceInput;
  focus: TokenRange;
}

export interface SentenceDetailsInput extends AnalysisInputBase {
  sentence: SentenceInput;
  core: CoreAnalysis;
}

export interface SentenceDetailsOutcome {
  succeeded: number;
  failed: number;
}

export interface CorrectionInput extends AnalysisInputBase {
  sentence: SentenceInput;
  core: CoreAnalysis;
  pageUrl: string;
  sentenceInstanceId: string;
  feedback: string;
}

export interface AnalysisFailure {
  sentenceId: string;
  error: ModelRequestError;
}

export interface CoreBatchOutcome {
  result: CoreAnalysis[];
  failures: AnalysisFailure[];
  cacheHit: boolean;
}

export interface CoreOutcome {
  result: CoreAnalysis;
  cacheHit: boolean;
}

export interface DetailOutcome {
  result: DetailAnalysis;
  cacheHit: boolean;
}

export interface AnalysisService {
  analyzeCore(input: CoreBatchInput, signal: AbortSignal): Promise<CoreBatchOutcome>;
  analyzeDetail(input: DetailInput, signal: AbortSignal): Promise<DetailOutcome>;
  reanalyzeWithFeedback(input: CorrectionInput, signal: AbortSignal): Promise<CoreOutcome>;
  /** 纯缓存查找:只回命中,不进调度器、不需要 profile(popup「查看缓存」模式)。 */
  lookupCore(sentences: readonly SentenceInput[]): Promise<CoreAnalysis[]>;
  lookupDetail(input: DetailLookupInput): Promise<DetailAnalysis | undefined>;
  /** 详解预载(按句合批):只补缺失成分,一次整句请求,结果逐成分写入现有缓存键。 */
  analyzeSentenceDetails(
    input: SentenceDetailsInput,
    signal: AbortSignal,
  ): Promise<SentenceDetailsOutcome>;
}

export interface CachedAnalysisServiceOptions {
  cache: AnalysisCachePort;
  adapter: AnalysisAdapter;
  scheduler: AnalysisScheduler;
  now?: () => number;
}

/** 纯缓存模式没有真实 profile,命中值统一改写为该占位 id。 */
const CACHE_ONLY_PROFILE_ID = "cached";

interface InvalidCoreSentence {
  sentence: SentenceInput;
  errors: ValidationError[];
}

const CORE_SCHEMA: JsonSchemaSpec = {
  name: "core_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sentences"],
    properties: {
      sentences: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sentenceId", "components"],
          properties: {
            sentenceId: { type: "string" },
            components: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["startToken", "endToken", "role", "translation"],
                properties: {
                  startToken: { type: "integer", minimum: 0 },
                  endToken: { type: "integer", minimum: 0 },
                  role: { type: "string", enum: Object.values(GrammarRole) },
                  translation: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
      },
    },
  },
};

const DETAIL_SCHEMA: JsonSchemaSpec = {
  name: "detail_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sentenceId", "focus", "structures", "grammarPoints", "explanation"],
    properties: {
      sentenceId: { type: "string" },
      focus: {
        type: "object",
        additionalProperties: false,
        required: ["startToken", "endToken"],
        properties: {
          startToken: { type: "integer", minimum: 0 },
          endToken: { type: "integer", minimum: 0 },
        },
      },
      structures: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["startToken", "endToken", "role", "explanation"],
          properties: {
            startToken: { type: "integer", minimum: 0 },
            endToken: { type: "integer", minimum: 0 },
            role: { type: "string", minLength: 1 },
            explanation: { type: "string", minLength: 1 },
            // 译文由提示词强制要求，但 schema 层不列入 required：兼容模式下模型
            // 偶发缺失时按渐进增强降级为两行标注，而非整次 INVALID_MODEL_OUTPUT。
            translation: { type: "string", minLength: 1, maxLength: 120 },
          },
        },
      },
      grammarPoints: {
        type: "array",
        maxItems: 12,
        items: { type: "string", minLength: 1, maxLength: 300 },
      },
      explanation: { type: "string", minLength: 1 },
    },
  },
};

const SENTENCE_DETAILS_SCHEMA: JsonSchemaSpec = {
  name: "sentence_details_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["details"],
    properties: {
      details: { type: "array", items: DETAIL_SCHEMA.schema },
    },
  },
};

const GRAMMAR_ROLES: ReadonlySet<string> = new Set(Object.values(GrammarRole));

/**
 * 流式分片是未校验的模型输出:role 可能不在枚举里、区间可能越界或与前一个成分重叠。
 * 渲染层要求成分有序、不重叠、在 token 界内，违反会直接抛错，所以这里逐个把关，
 * 只放行能安全画出来的。整句覆盖率仍然只能等完整响应到齐后校验。
 */
class ProvisionalComponents {
  readonly #accepted: CoreComponent[] = [];
  #lastEnd = -1;

  constructor(private readonly tokenCount: number) {}

  /** 接受则返回累积列表，否则返回 undefined。 */
  accept(raw: Record<string, unknown>): readonly CoreComponent[] | undefined {
    const { startToken, endToken, role, translation } = raw;
    if (
      !Number.isSafeInteger(startToken) ||
      !Number.isSafeInteger(endToken) ||
      typeof role !== "string" ||
      !GRAMMAR_ROLES.has(role)
    ) {
      return undefined;
    }
    const start = startToken as number;
    const end = endToken as number;
    if (start < 0 || end < start || end >= this.tokenCount || start <= this.#lastEnd) {
      return undefined;
    }
    this.#lastEnd = end;
    this.#accepted.push({
      startToken: start,
      endToken: end,
      role: role as GrammarRole,
      translation: typeof translation === "string" ? translation : "",
    });
    return [...this.#accepted];
  }
}

/**
 * 流式结构同样是未校验输出。渲染层要求区间在句子 token 界内、解释非空，
 * 违反会画不出来。整次详解的完整性仍只能等完整响应后由 validateDetail 判定。
 */
class ProvisionalStructures {
  readonly #accepted: DetailStructure[] = [];

  constructor(private readonly tokenCount: number) {}

  accept(raw: Record<string, unknown>): readonly DetailStructure[] | undefined {
    const { startToken, endToken, role, explanation, translation } = raw;
    if (
      !Number.isSafeInteger(startToken) ||
      !Number.isSafeInteger(endToken) ||
      typeof role !== "string" ||
      role.trim().length === 0 ||
      typeof explanation !== "string" ||
      explanation.trim().length === 0
    ) {
      return undefined;
    }
    const start = startToken as number;
    const end = endToken as number;
    if (start < 0 || end < start || end >= this.tokenCount) return undefined;
    this.#accepted.push({
      startToken: start,
      endToken: end,
      role,
      explanation,
      ...(typeof translation === "string" && translation.length > 0 ? { translation } : {}),
    });
    return [...this.#accepted];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedSentenceText(sentence: SentenceInput): string {
  return sentence.text.trim().replace(/\s+/gu, " ");
}

function cancellationError(): ModelRequestError {
  return new ModelRequestError("REQUEST_CANCELLED", "Analysis request was cancelled", false);
}

/**
 * 分块后一块失败不得连坐:兄弟块已拿到的译文要保住,失败块转成 failures。
 * SW 靠 failures 里的 AUTH_FAILED 暂停 profile,所以错误码必须原样带过去。
 */
function asModelRequestError(error: unknown): ModelRequestError {
  if (error instanceof ModelRequestError) return error;
  if (typeof error === "object" && error !== null) {
    const shape = error as Partial<ExtensionError>;
    if (typeof shape.code === "string") {
      return new ModelRequestError(
        shape.code,
        shape.message ?? "Model request failed",
        shape.retryable === true,
      );
    }
  }
  return new ModelRequestError(
    "NETWORK_ERROR",
    error instanceof Error ? error.message : "Model request failed",
    true,
  );
}

function invalidOutput(errors: readonly ValidationError[]): ModelRequestError {
  const summary = errors.map(({ path, message }) => `${path || "output"}: ${message}`).join("; ");
  return new ModelRequestError(
    "INVALID_MODEL_OUTPUT",
    `Model output remained invalid after one repair${summary.length === 0 ? "" : `: ${summary}`}`,
    false,
  );
}

function rawSentences(raw: unknown): readonly unknown[] {
  return isRecord(raw) && Array.isArray(raw.sentences) ? raw.sentences : [];
}

/**
 * 模型偶发把纯标点（多是逗号或句号）单独切成一个成分。这是覆盖率规则明令禁止的，
 * 但也是**本地就能判定并修掉**的:规则只要求非标点 token 被覆盖恰好一次，标点可以
 * 不被覆盖，所以丢掉这种成分即合法，渲染层的未覆盖标点处理本来就会把它画回原位。
 *
 * 不这么做的话，实测每碰上一次就要多跑一整轮模型（本地 6–23 秒）。
 */
function dropPunctuationOnlyComponents(raw: unknown, sentence: SentenceInput): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.components)) return raw;
  const isPunctuation = (id: number): boolean =>
    sentence.tokens.find((token) => token.id === id)?.punctuation === true;
  const kept = raw.components.filter((component) => {
    if (!isRecord(component)) return true;
    const { startToken, endToken } = component;
    if (!Number.isSafeInteger(startToken) || !Number.isSafeInteger(endToken)) return true;
    for (let id = startToken as number; id <= (endToken as number); id += 1) {
      if (!isPunctuation(id)) return true;
    }
    // 区间内全是标点:丢掉。
    return false;
  });
  return kept.length === raw.components.length ? raw : { ...raw, components: kept };
}

function matchingRawSentences(raw: unknown, sentenceId: string): unknown[] {
  return rawSentences(raw).filter(
    (candidate) => isRecord(candidate) && candidate.sentenceId === sentenceId,
  );
}

function invalidRawSubset(raw: unknown, sentenceIds: ReadonlySet<string>): unknown {
  return {
    sentences: rawSentences(raw).filter(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.sentenceId === "string" &&
        sentenceIds.has(candidate.sentenceId),
    ),
  };
}

function validateCachedCore(
  cached: unknown,
  sentence: SentenceInput,
  modelProfileId: string,
): CoreAnalysis | undefined {
  const validation = validateCoreBatch(
    {
      sentences: [
        {
          sentenceId: sentence.sentenceId,
          components: isRecord(cached) ? cached.components : undefined,
        },
      ],
    },
    [sentence],
    modelProfileId,
  );
  return validation.ok ? validation.value[0] : undefined;
}

function isMatchingFocus(value: unknown, focus: TokenRange): boolean {
  return (
    isRecord(value) && value.startToken === focus.startToken && value.endToken === focus.endToken
  );
}

function validateCachedDetail(
  cached: unknown,
  sentence: SentenceInput,
  focus: TokenRange,
  modelProfileId: string,
): DetailAnalysis | undefined {
  if (!isRecord(cached) || !isMatchingFocus(cached.focus, focus)) return undefined;
  const validation = validateDetail(
    {
      sentenceId: sentence.sentenceId,
      focus,
      structures: cached.structures,
      grammarPoints: cached.grammarPoints,
      explanation: cached.explanation,
    },
    sentence,
    focus,
    modelProfileId,
  );
  return validation.ok ? validation.value : undefined;
}

function correctionPrompt(input: CorrectionInput): string {
  return [
    "Reanalyze the supplied sentence using the reader's correction feedback.",
    "Keep the sentence ID and Tokens unchanged. Return core-analysis JSON only.",
    CORE_OUTPUT_SHAPE,
    `Sentence and Tokens:\n${serializeSentence(input.sentence)}`,
    `Previously verified core analysis:\n${serialize(input.core)}`,
    `Reader feedback:\n${input.feedback}`,
  ].join("\n\n");
}

function correctionRepairPrompt(
  input: CorrectionInput,
  errors: readonly ValidationError[],
  invalidJson: unknown,
): string {
  return [
    "Repair only the structure of the invalid correction analysis while preserving the entire correction context below.",
    correctionPrompt(input),
    `Validation errors:\n${serialize(errors)}`,
    `Invalid JSON:\n${serialize(invalidJson)}`,
    "Return the repaired core-analysis JSON only. Do not add sentences or change sentence IDs or Tokens.",
  ].join("\n\n");
}

function detailRepairPrompt(
  input: DetailInput,
  errors: readonly ValidationError[],
  invalidJson: unknown,
): string {
  return [
    PROMPT_FIRST_LINES.detailRepair,
    "Keep the sentence ID, Tokens, verified core analysis, and focus unchanged. Return JSON only.",
    `Sentence and Tokens:\n${serializeSentence(input.sentence)}`,
    `Verified core analysis:\n${serialize(input.core)}`,
    `Focus:\n${serialize(input.focus)}`,
    `Validation errors:\n${serialize(errors)}`,
    `Invalid JSON:\n${serialize(invalidJson)}`,
  ].join("\n\n");
}

function sentenceDetailsRepairPrompt(
  input: SentenceDetailsInput,
  focuses: readonly TokenRange[],
  errors: readonly ValidationError[],
  invalidJson: unknown,
): string {
  return [
    "Repair only the structure of the invalid sentence-details JSON so every requested focus has one valid entry.",
    "Keep the sentence ID, Tokens, verified core analysis, and focus ranges unchanged. Return JSON only.",
    `Sentence and Tokens:\n${serializeSentence(input.sentence)}`,
    `Verified core analysis:\n${serialize(input.core)}`,
    `Validation errors:\n${serialize(errors)}`,
    `Invalid JSON:\n${serialize(invalidJson)}`,
    `Requested focus ranges:\n${serialize(focuses)}`,
  ].join("\n\n");
}

export class CachedAnalysisService implements AnalysisService {
  private readonly now: () => number;

  constructor(private readonly options: CachedAnalysisServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async analyzeCore(input: CoreBatchInput, signal: AbortSignal): Promise<CoreBatchOutcome> {
    if (signal.aborted) throw cancellationError();
    const keyedSentences = await Promise.all(
      input.sentences.map(async (sentence) => ({
        sentence,
        key: await this.coreKey(sentence),
      })),
    );
    const cached =
      input.bypassCache === true
        ? keyedSentences.map(() => undefined)
        : await Promise.all(
            keyedSentences.map(({ key }) => this.options.cache.getCore<unknown>(key)),
          );
    if (signal.aborted) throw cancellationError();

    const resultsById = new Map<string, CoreAnalysis>();
    const missing: Array<{ sentence: SentenceInput; key: string }> = [];
    keyedSentences.forEach((entry, index) => {
      const value = validateCachedCore(cached[index], entry.sentence, input.profile.id);
      if (value === undefined) missing.push(entry);
      else resultsById.set(entry.sentence.sentenceId, value);
    });
    if (missing.length === 0) {
      return {
        result: input.sentences.map(({ sentenceId }) => resultsById.get(sentenceId)!),
        failures: [],
        cacheHit: true,
      };
    }

    const perRequest = sentencesPerRequest(input.profile.baseUrl);
    const chunks: Array<typeof missing> = [];
    for (let index = 0; index < missing.length; index += perRequest) {
      chunks.push(missing.slice(index, index + perRequest));
    }
    const settled = await Promise.allSettled(
      chunks.map((chunk) => this.analyzeCoreChunk(input, chunk, signal)),
    );
    // 每块都失败时按原样抛出首个原因:单块(绝大多数)场景与分块前的行为完全一致。
    const firstRejection = settled.find((outcome) => outcome.status === "rejected");
    if (
      firstRejection?.status === "rejected" &&
      !settled.some(({ status }) => status === "fulfilled")
    ) {
      throw firstRejection.reason;
    }

    const failuresById = new Map<string, AnalysisFailure>();
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        outcome.value.valid.forEach((analysis) => resultsById.set(analysis.sentenceId, analysis));
        for (const { sentence, errors } of outcome.value.invalid) {
          failuresById.set(sentence.sentenceId, {
            sentenceId: sentence.sentenceId,
            error: invalidOutput(errors),
          });
        }
        return;
      }
      const error = asModelRequestError(outcome.reason);
      for (const { sentence } of chunks[index]!) {
        failuresById.set(sentence.sentenceId, { sentenceId: sentence.sentenceId, error });
      }
    });
    return {
      result: input.sentences.flatMap(({ sentenceId }) => {
        const result = resultsById.get(sentenceId);
        return result === undefined ? [] : [result];
      }),
      failures: input.sentences.flatMap(({ sentenceId }) => {
        const failure = failuresById.get(sentenceId);
        return failure === undefined ? [] : [failure];
      }),
      cacheHit: false,
    };
  }

  /** 一块的首轮 + 至多一次修复;块之间互不影响,各自并行经调度器。 */
  private async analyzeCoreChunk(
    input: CoreBatchInput,
    chunk: readonly { sentence: SentenceInput; key: string }[],
    signal: AbortSignal,
  ): Promise<{ valid: CoreAnalysis[]; invalid: InvalidCoreSentence[] }> {
    const priority = input.priority ?? "visible-core";
    const chunkKey = chunk.map(({ key }) => key).join(":");
    const firstRaw = await this.requestModel(
      input.profile,
      input.documentId,
      priority,
      chunkKey,
      chunk.length,
      [{ role: "user", content: buildCorePrompt(chunk.map(({ sentence }) => sentence)) }],
      CORE_SCHEMA,
      signal,
      false,
      this.streamHandler(input, chunk),
    );
    const firstPass = await this.validateAndCacheCore(input.profile, chunk, firstRaw);
    const valid = [...firstPass.valid];

    let remaining = firstPass.invalid;
    if (remaining.length > 0) {
      const failedIds = new Set(remaining.map(({ sentence }) => sentence.sentenceId));
      const repairRaw = await this.requestModel(
        input.profile,
        input.documentId,
        priority,
        `${chunkKey}:repair`,
        remaining.length,
        [
          {
            role: "user",
            content: buildRepairPrompt(
              remaining.map(({ sentence }) => sentence),
              remaining.flatMap(({ errors }) => errors),
              invalidRawSubset(firstRaw, failedIds),
            ),
          },
        ],
        CORE_SCHEMA,
        signal,
        true,
      );
      const keysById = new Map(chunk.map(({ sentence, key }) => [sentence.sentenceId, key]));
      const repairEntries = remaining.map(({ sentence }) => ({
        sentence,
        key: keysById.get(sentence.sentenceId)!,
      }));
      const repaired = await this.validateAndCacheCore(input.profile, repairEntries, repairRaw);
      valid.push(...repaired.valid);
      remaining = repaired.invalid;
    }
    return { valid, invalid: remaining };
  }

  /** 无 sink 或适配器不支持详解流式时返回 undefined，requestModel 便退回缓冲路径。 */
  private detailStreamHandler(
    input: DetailInput,
  ): ((structure: Record<string, unknown>) => void) | undefined {
    const sink = input.onStreamedStructure;
    if (sink === undefined || this.options.adapter.completeDetailStreaming === undefined) {
      return undefined;
    }
    const provisional = new ProvisionalStructures(input.sentence.tokens.length);
    return (structure) => {
      const accepted = provisional.accept(structure);
      if (accepted !== undefined) sink(input.sentence.sentenceId, input.focus, accepted);
    };
  }

  /** 无 sink 或适配器不支持流式时返回 undefined，requestModel 便退回缓冲路径。 */
  private streamHandler(
    input: CoreBatchInput,
    chunk: readonly { sentence: SentenceInput; key: string }[],
  ): ((streamed: StreamedComponent) => void) | undefined {
    const sink = input.onStreamedComponent;
    if (sink === undefined || this.options.adapter.completeJsonStreaming === undefined) {
      return undefined;
    }
    const provisional = new Map<string, ProvisionalComponents>(
      chunk.map(({ sentence }) => [
        sentence.sentenceId,
        new ProvisionalComponents(sentence.tokens.length),
      ]),
    );
    return ({ sentenceId, component }) => {
      const accepted = provisional.get(sentenceId)?.accept(component);
      if (accepted !== undefined) sink(sentenceId, accepted);
    };
  }

  async analyzeDetail(input: DetailInput, signal: AbortSignal): Promise<DetailOutcome> {
    if (signal.aborted) throw cancellationError();
    const key = await this.detailKey(input);
    const cached = validateCachedDetail(
      await this.options.cache.getDetail<unknown>(key),
      input.sentence,
      input.focus,
      input.profile.id,
    );
    if (signal.aborted) throw cancellationError();
    if (cached !== undefined) return { result: cached, cacheHit: true };

    const raw = await this.requestModel(
      input.profile,
      input.documentId,
      "detail-click",
      key,
      1,
      [{ role: "user", content: buildDetailPrompt(input.sentence, input.core, input.focus) }],
      DETAIL_SCHEMA,
      signal,
      false,
      undefined,
      this.detailStreamHandler(input),
    );
    let validation = validateDetail(raw, input.sentence, input.focus, input.profile.id);
    if (!validation.ok) {
      const repairRaw = await this.requestModel(
        input.profile,
        input.documentId,
        "detail-click",
        `${key}:repair`,
        1,
        [{ role: "user", content: detailRepairPrompt(input, validation.errors, raw) }],
        DETAIL_SCHEMA,
        signal,
        true,
      );
      validation = validateDetail(repairRaw, input.sentence, input.focus, input.profile.id);
    }
    if (!validation.ok) throw invalidOutput(validation.errors);
    await this.options.cache.putDetail(key, input.profile.id, validation.value);
    return { result: validation.value, cacheHit: false };
  }

  async lookupCore(sentences: readonly SentenceInput[]): Promise<CoreAnalysis[]> {
    const cached = await Promise.all(
      sentences.map(async (sentence) => ({
        sentence,
        value: await this.options.cache.getCore<unknown>(await this.coreKey(sentence)),
      })),
    );
    return cached.flatMap(({ sentence, value }) => {
      const analysis = validateCachedCore(value, sentence, CACHE_ONLY_PROFILE_ID);
      return analysis === undefined ? [] : [analysis];
    });
  }

  async lookupDetail(input: DetailLookupInput): Promise<DetailAnalysis | undefined> {
    const key = await this.detailKey(input);
    return validateCachedDetail(
      await this.options.cache.getDetail<unknown>(key),
      input.sentence,
      input.focus,
      CACHE_ONLY_PROFILE_ID,
    );
  }

  async analyzeSentenceDetails(
    input: SentenceDetailsInput,
    signal: AbortSignal,
  ): Promise<SentenceDetailsOutcome> {
    if (signal.aborted) throw cancellationError();
    const targets = await Promise.all(
      input.core.components.map(async (component) => {
        const focus = { startToken: component.startToken, endToken: component.endToken };
        const key = await this.detailKey({ sentence: input.sentence, focus });
        const cached = validateCachedDetail(
          await this.options.cache.getDetail<unknown>(key),
          input.sentence,
          focus,
          input.profile.id,
        );
        return { focus, key, cached };
      }),
    );
    if (signal.aborted) throw cancellationError();
    let missing: { focus: TokenRange; key: string }[] = targets.filter(
      ({ cached }) => cached === undefined,
    );
    let succeeded = targets.length - missing.length;
    if (missing.length === 0) return { succeeded, failed: 0 };

    const cacheKey = `${missing.map(({ key }) => key).join(":")}:sentence-details`;
    const raw = await this.requestModel(
      input.profile,
      input.documentId,
      "prefetch-detail",
      cacheKey,
      1,
      [
        {
          role: "user",
          content: buildSentenceDetailsPrompt(
            input.sentence,
            input.core,
            missing.map(({ focus }) => focus),
          ),
        },
      ],
      SENTENCE_DETAILS_SCHEMA,
      signal,
    );
    const firstPass = await this.validateAndCacheDetails(input, missing, raw);
    succeeded += firstPass.valid;
    missing = firstPass.invalid;
    if (missing.length > 0) {
      const repairRaw = await this.requestModel(
        input.profile,
        input.documentId,
        "prefetch-detail",
        `${cacheKey}:repair`,
        1,
        [
          {
            role: "user",
            content: sentenceDetailsRepairPrompt(
              input,
              missing.map(({ focus }) => focus),
              firstPass.errors,
              raw,
            ),
          },
        ],
        SENTENCE_DETAILS_SCHEMA,
        signal,
        true,
      );
      const secondPass = await this.validateAndCacheDetails(input, missing, repairRaw);
      succeeded += secondPass.valid;
      missing = secondPass.invalid;
    }
    return { succeeded, failed: missing.length };
  }

  /** 逐 focus 从原始响应里捞对应条目、校验并写缓存;返回合格数与失败目标。 */
  private async validateAndCacheDetails(
    input: SentenceDetailsInput,
    targets: readonly { focus: TokenRange; key: string }[],
    raw: unknown,
  ): Promise<{
    valid: number;
    invalid: { focus: TokenRange; key: string }[];
    errors: ValidationError[];
  }> {
    const rawDetails =
      isRecord(raw) && Array.isArray(raw.details) ? (raw.details as unknown[]) : [];
    let valid = 0;
    const invalid: { focus: TokenRange; key: string }[] = [];
    const errors: ValidationError[] = [];
    for (const target of targets) {
      const candidate = rawDetails.find(
        (item) => isRecord(item) && isMatchingFocus(item.focus, target.focus),
      );
      const validation =
        candidate === undefined
          ? undefined
          : validateDetail(candidate, input.sentence, target.focus, input.profile.id);
      if (validation !== undefined && validation.ok) {
        await this.options.cache.putDetail(target.key, input.profile.id, validation.value);
        valid += 1;
        continue;
      }
      invalid.push(target);
      if (validation !== undefined) errors.push(...validation.errors);
      else
        errors.push({
          path: `details[focus ${target.focus.startToken}-${target.focus.endToken}]`,
          message: "missing entry for requested focus",
        });
    }
    return { valid, invalid, errors };
  }

  async reanalyzeWithFeedback(input: CorrectionInput, signal: AbortSignal): Promise<CoreOutcome> {
    if (signal.aborted) throw cancellationError();
    const key = await this.correctionKey(input);
    const cached = validateCachedCore(
      await this.options.cache.getCorrection<unknown>(key),
      input.sentence,
      input.profile.id,
    );
    if (signal.aborted) throw cancellationError();
    if (cached !== undefined) return { result: cached, cacheHit: true };

    const raw = await this.requestModel(
      input.profile,
      input.documentId,
      "user-retry",
      key,
      1,
      [{ role: "user", content: correctionPrompt(input) }],
      CORE_SCHEMA,
      signal,
    );
    let validation = validateCoreBatch(raw, [input.sentence], input.profile.id);
    if (!validation.ok) {
      const repairRaw = await this.requestModel(
        input.profile,
        input.documentId,
        "user-retry",
        `${key}:repair`,
        1,
        [
          {
            role: "user",
            content: correctionRepairPrompt(input, validation.errors, raw),
          },
        ],
        CORE_SCHEMA,
        signal,
        true,
      );
      validation = validateCoreBatch(repairRaw, [input.sentence], input.profile.id);
    }
    if (!validation.ok) throw invalidOutput(validation.errors);
    const result = validation.value[0]!;
    await this.options.cache.putCorrection(key, input.profile.id, result);
    return { result, cacheHit: false };
  }

  private async validateAndCacheCore(
    profile: ModelProfile,
    entries: readonly { sentence: SentenceInput; key: string }[],
    raw: unknown,
  ): Promise<{ valid: CoreAnalysis[]; invalid: InvalidCoreSentence[] }> {
    const valid: CoreAnalysis[] = [];
    const invalid: InvalidCoreSentence[] = [];
    for (const { sentence, key } of entries) {
      const validation = validateCoreBatch(
        {
          sentences: matchingRawSentences(raw, sentence.sentenceId).map((candidate) =>
            dropPunctuationOnlyComponents(candidate, sentence),
          ),
        },
        [sentence],
        profile.id,
      );
      if (validation.ok) {
        const analysis = validation.value[0]!;
        valid.push(analysis);
        await this.options.cache.putCore(key, profile.id, analysis);
      } else {
        invalid.push({ sentence, errors: validation.errors });
      }
    }
    return { valid, invalid };
  }

  private async requestModel(
    profile: ModelProfile,
    documentId: string,
    priority: SchedulerPriority,
    cacheKey: string,
    sentenceCount: number,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    signal: AbortSignal,
    jumpQueue = false,
    onComponent?: (streamed: StreamedComponent) => void,
    onStructure?: (structure: Record<string, unknown>) => void,
  ): Promise<unknown> {
    if (signal.aborted) throw cancellationError();
    const work: AnalysisModelWork = {
      profile,
      messages,
      schema,
      requestedAt: this.now(),
      run: (schedulerSignal) => {
        if (onComponent !== undefined) {
          return this.options.adapter.completeJsonStreaming!(
            profile,
            messages,
            schema,
            schedulerSignal,
            onComponent,
          );
        }
        if (onStructure !== undefined) {
          return this.options.adapter.completeDetailStreaming!(
            profile,
            messages,
            schema,
            schedulerSignal,
            onStructure,
          );
        }
        return this.options.adapter.completeJson(profile, messages, schema, schedulerSignal);
      },
    };
    const onAbort = () => this.options.scheduler.cancelDocument(documentId);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.options.scheduler.schedule({
        cacheKey,
        documentId,
        priority,
        sentenceCount,
        input: work,
        ...(jumpQueue ? { jumpQueue: true as const } : {}),
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private coreKey(sentence: SentenceInput): Promise<string> {
    return createCoreCacheKey({
      normalizedSentence: normalizedSentenceText(sentence),
      schemaVersion: CORE_SCHEMA_VERSION,
    });
  }

  private detailKey(input: { sentence: SentenceInput; focus: TokenRange }): Promise<string> {
    return createCoreCacheKey({
      normalizedSentence: normalizedSentenceText(input.sentence),
      schemaVersion: CORE_SCHEMA_VERSION,
      focus: input.focus,
    });
  }

  private correctionKey(input: CorrectionInput): Promise<string> {
    return createCorrectionCacheKey({
      normalizedSentence: normalizedSentenceText(input.sentence),
      schemaVersion: CORE_SCHEMA_VERSION,
      pageUrl: input.pageUrl,
      sentenceInstanceId: input.sentenceInstanceId,
      correctionContext: input.feedback,
    });
  }
}
