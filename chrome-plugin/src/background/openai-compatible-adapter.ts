import type { ExtensionError, ExtensionErrorCode } from "../shared/errors";
import { chatCompletionsUrl } from "./base-url";
import type { ModelProfile } from "./config-repository";
import { CoreStreamParser, type StreamedComponent } from "./core-stream-parser";
import { DetailStreamParser } from "./detail-stream-parser";
import { salvageTruncatedJson } from "./lenient-json";
import { SSE_DONE, SseDecoder } from "./sse";

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatMessage {
  /** assistant 轮次只有追问对话（chat 面板）会用：多轮历史回传给模型。 */
  role: "system" | "user" | "assistant";
  content: string;
}

export class ModelRequestError extends Error implements ExtensionError {
  constructor(
    public readonly code: ExtensionErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly details: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}

export interface OpenAiCompatibleAdapterOptions {
  fetch?: typeof globalThis.fetch;
  persistJsonSchemaSupport?: (
    profileId: string,
    support: ModelProfile["jsonSchemaSupport"],
  ) => Promise<void>;
  persistStreamSupport?: (profileId: string, support: "unsupported") => Promise<void>;
  persistReasoningControl?: (profileId: string, support: "unsupported") => Promise<void>;
}

/** Reports each component the stream completed, before the sentence is verified. */
export type StreamedComponentHandler = (streamed: StreamedComponent) => void;

/** Reports each detail structure the stream completed, before it is verified. */
export type StreamedStructureHandler = (structure: Record<string, unknown>) => void;

interface ChatCompletionEnvelope {
  choices?: Array<{ message?: { content?: unknown } }>;
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: unknown } }>;
}

function deltaContent(payload: string): string | undefined {
  try {
    const chunk = JSON.parse(payload) as ChatCompletionChunk;
    const content = chunk.choices?.[0]?.delta?.content;
    return typeof content === "string" && content.length > 0 ? content : undefined;
  } catch {
    // A malformed keep-alive frame must not kill an otherwise healthy stream.
    return undefined;
  }
}

/**
 * 默认下发。思考模型会为一句话生成上万 token 推理(实测 deepseek-v4-flash 单句
 * 153 秒 / 14789 tok,超过 120 秒超时上限;带 "none" 后 1.41 秒 / 135 tok),而
 * DeepSeek 现存的两个模型都是思考模型——靠用户自己去勾选并不可靠。
 *
 * 部分端点(OpenAI 官方只收 low/medium/high)会因此 400,所以走与 response_format
 * 相同的降级:被拒一次就记 reasoningControl="unsupported",之后不再下发。
 */
function reasoningOverride(profile: ModelProfile): Record<string, unknown> {
  return profile.reasoningControl === "unsupported" ? {} : { reasoning_effort: "none" };
}

function responseFormat(schema: JsonSchemaSpec): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      strict: schema.strict ?? true,
      schema: schema.schema,
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Stream aborted", "AbortError");
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function stripSingleJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function invalidOutput(message: string): ModelRequestError {
  return new ModelRequestError("INVALID_MODEL_OUTPUT", message, false);
}

/**
 * 解析模型吐出来的 JSON 正文。少吐收尾括号、或撞上 max_tokens 断在半句上是常态,
 * 此时先按截断救一遍:救回来的对象若缺字段，由上层逐句校验判无效并进修复轮——
 * 那远好过整块判死(此前这里直接抛 INVALID_MODEL_OUTPUT，同一批句子全军覆没,
 * 而其中前几句往往是完整的，且修复轮压根不会跑)。
 */
function parseModelContent(content: string, message: string): unknown {
  const text = stripSingleJsonFence(content);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const salvaged = salvageTruncatedJson(text);
    if (salvaged !== undefined) return salvaged;
    throw invalidOutput(message);
  }
}

function mapHttpError(status: number, retryAfter: string | null, body: string): ModelRequestError {
  const message = body.trim() || `模型服务返回 HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new ModelRequestError("AUTH_FAILED", message, false, { status });
  }
  // Some providers (e.g. DeepSeek) reject an unknown model with 400 "Model
  // Not Exist" instead of 404, so sniff the body as well.
  if (
    status === 404 ||
    (status === 400 && /model[\s\S]{0,40}?(?:not exist|not found)/i.test(body))
  ) {
    return new ModelRequestError("MODEL_NOT_FOUND", message, false, { status });
  }
  if (status === 429) {
    const delay = retryAfterMilliseconds(retryAfter);
    return new ModelRequestError(
      "RATE_LIMITED",
      message,
      true,
      delay === undefined ? { status } : { status, retryAfterMs: delay },
    );
  }
  return new ModelRequestError("NETWORK_ERROR", message, status >= 500, { status });
}

export class OpenAiCompatibleAdapter {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly persistJsonSchemaSupport: NonNullable<
    OpenAiCompatibleAdapterOptions["persistJsonSchemaSupport"]
  >;
  private readonly persistStreamSupport: NonNullable<
    OpenAiCompatibleAdapterOptions["persistStreamSupport"]
  >;
  private readonly persistReasoningControl: NonNullable<
    OpenAiCompatibleAdapterOptions["persistReasoningControl"]
  >;

  constructor(options: OpenAiCompatibleAdapterOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.persistJsonSchemaSupport = options.persistJsonSchemaSupport ?? (() => Promise.resolve());
    this.persistStreamSupport = options.persistStreamSupport ?? (() => Promise.resolve());
    this.persistReasoningControl = options.persistReasoningControl ?? (() => Promise.resolve());
  }

  /**
   * Same contract as {@link completeJson} — the resolved value is the complete,
   * still-unvalidated envelope — but reports each component as soon as the
   * stream closes it, so a paragraph can render before the model finishes.
   *
   * Streaming is best-effort: an endpoint that rejects `stream` (some reject it
   * only in combination with `response_format`) is marked unsupported once and
   * never retried, and the call finishes as an ordinary buffered request.
   */
  async completeJsonStreaming(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    signal: AbortSignal,
    onComponent: StreamedComponentHandler,
  ): Promise<unknown> {
    return this.streamWithExtractor(profile, messages, schema, signal, () => {
      const parser = new CoreStreamParser();
      return (delta) => {
        for (const streamed of parser.push(delta)) onComponent(streamed);
      };
    });
  }

  /**
   * 详解路径的流式版本。实测本地 9B 上单次详解要 10 秒以上，首个结构约 5 秒
   * 到达——面板不必从头干等到尾。
   */
  async completeDetailStreaming(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    signal: AbortSignal,
    onStructure: StreamedStructureHandler,
  ): Promise<unknown> {
    return this.streamWithExtractor(profile, messages, schema, signal, () => {
      const parser = new DetailStreamParser();
      return (delta) => {
        for (const structure of parser.push(delta)) onStructure(structure);
      };
    });
  }

  /**
   * 追问对话面板的纯文本缓冲路径：与 completeJson 同体的非流式请求
   * （stream:false、reasoningOverride 默认下发、被拒降级重发一次），但
   * **不做 JSON 解析**——自由文本过 parseModelContent 会被整块判成
   * INVALID_MODEL_OUTPUT。
   */
  async completeText(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    try {
      return await this.requestContent(profile, messages, null, signal);
    } catch (error) {
      if (error instanceof UnsupportedReasoningControlError && !signal.aborted) {
        await this.persistReasoningControl(profile.id, "unsupported");
        const downgraded = { ...profile, reasoningControl: "unsupported" as const };
        return this.requestContent(downgraded, messages, null, signal);
      }
      throw error;
    }
  }

  /**
   * 追问对话面板的纯文本流式路径：SSE delta 逐段回调 onDelta，返回完整回答。
   * 降级链与 streamWithExtractor 同款——reasoning 被拒去掉字段重发（仍流式），
   * stream 被拒记 unsupported 并回落 completeText（不是 request()，那要 JSON）。
   */
  async completeTextStreaming(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    signal: AbortSignal,
    onDelta: (chunk: string) => void,
  ): Promise<string> {
    if (profile.streamSupport === "unsupported") {
      return this.completeText(profile, messages, signal);
    }
    for (;;) {
      try {
        return await this.readStream(profile, messages, null, signal, onDelta);
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof UnsupportedReasoningControlError) {
          await this.persistReasoningControl(profile.id, "unsupported");
          profile = { ...profile, reasoningControl: "unsupported" as const };
          continue;
        }
        if (error instanceof UnsupportedStreamError) {
          await this.persistStreamSupport(profile.id, "unsupported");
          return this.completeText(profile, messages, signal);
        }
        throw error;
      }
    }
  }

  private async streamWithExtractor(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    signal: AbortSignal,
    createExtractor: () => (delta: string) => void,
  ): Promise<unknown> {
    if (profile.streamSupport === "unsupported") {
      return this.completeJson(profile, messages, schema, signal);
    }
    let useSchema = profile.jsonSchemaSupport !== "unsupported";
    for (;;) {
      try {
        return await this.streamRequest(
          profile,
          messages,
          schema,
          signal,
          useSchema,
          createExtractor(),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof UnsupportedResponseFormatError && useSchema) {
          await this.persistJsonSchemaSupport(profile.id, "unsupported");
          useSchema = false;
          continue;
        }
        if (error instanceof UnsupportedStreamError) {
          await this.persistStreamSupport(profile.id, "unsupported");
          // schema 能力沿用上面刚探到的结果，别再白探一次。
          return this.request(profile, messages, schema, signal, useSchema);
        }
        if (error instanceof UnsupportedReasoningControlError) {
          await this.persistReasoningControl(profile.id, "unsupported");
          profile = { ...profile, reasoningControl: "unsupported" as const };
          continue;
        }
        throw error;
      }
    }
  }

  private async streamRequest(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    callerSignal: AbortSignal,
    useSchema: boolean,
    consume: (delta: string) => void,
  ): Promise<unknown> {
    const content = await this.readStream(
      profile,
      messages,
      useSchema ? schema : null,
      callerSignal,
      consume,
    );
    return parseModelContent(content, "模型流式返回的正文不是合法 JSON");
  }

  /**
   * 共享的 SSE 读循环，返回**未解析的累积正文**。JSON 路径由 streamRequest
   * 拿去 parseModelContent；追问对话（chat）的纯文本路径直接原样返回——
   * 自由文本绝不能过 JSON 解析。schema 传 null 即文本模式：不带
   * response_format，也不做 response_format 嗅探。
   */
  private async readStream(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec | null,
    callerSignal: AbortSignal,
    consume: (delta: string) => void,
  ): Promise<string> {
    const controller = new AbortController();
    let abortCause: "caller" | "timeout" | undefined;
    const onCallerAbort = () => {
      abortCause ??= "caller";
      controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal.aborted) onCallerAbort();

    // 流式下总时长没有意义:一段长响应本来就会超过单次请求的超时值。改成静默超时——
    // 每收到一片就重置，只有真的卡住才判超时。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        abortCause ??= "timeout";
        controller.abort(new DOMException("Request timed out", "TimeoutError"));
      }, profile.timeoutMs);
    };
    armTimeout();

    try {
      const body: Record<string, unknown> = {
        model: profile.model,
        messages,
        temperature: 0,
        stream: true,
        ...reasoningOverride(profile),
      };
      if (schema !== null) body.response_format = responseFormat(schema);
      const headers = new Headers(profile.headers);
      headers.set("Content-Type", "application/json");
      headers.set("Authorization", `Bearer ${profile.apiKey}`);
      const response = await this.fetchImplementation(chatCompletionsUrl(profile.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const validationRejection = response.status === 400 || response.status === 422;
        if (
          schema !== null &&
          validationRejection &&
          /response[_ ]?format|json[_ ]?schema/i.test(text)
        ) {
          throw new UnsupportedResponseFormatError();
        }
        // 与缓冲 request() 同款嗅探：流式默认也下发 reasoning_effort，端点拒绝
        // （OpenAI 官方只收 low/medium/high）必须能降级重发，否则被 mapHttpError
        // 永久映射成不可重试的 NETWORK_ERROR。
        if (
          profile.reasoningControl !== "unsupported" &&
          validationRejection &&
          /reasoning[_ ]?effort/i.test(text)
        ) {
          throw new UnsupportedReasoningControlError();
        }
        if (validationRejection && /stream/i.test(text)) throw new UnsupportedStreamError();
        throw mapHttpError(response.status, response.headers.get("Retry-After"), text);
      }
      if (response.body === null) throw new UnsupportedStreamError();

      const reader = response.body.getReader();
      const utf8 = new TextDecoder();
      const events = new SseDecoder();
      // 不能只靠 fetch 把 abort 传播进 body 流:读循环自己盯着信号，卡死的流才会
      // 真的被超时掐断。
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(abortReason(controller.signal));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      aborted.catch(() => undefined);
      let content = "";
      let finished = false;
      while (!finished) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        armTimeout();
        for (const payload of events.push(utf8.decode(value, { stream: true }))) {
          if (payload === SSE_DONE) {
            finished = true;
            break;
          }
          const delta = deltaContent(payload);
          if (delta === undefined) continue;
          content += delta;
          consume(delta);
        }
      }

      // 连一个内容分片都没有:这个端点的流式没法用，回落非流式而不是报解析失败。
      if (content.length === 0) throw new UnsupportedStreamError();
      return content;
    } catch (error) {
      if (
        error instanceof ModelRequestError ||
        error instanceof UnsupportedResponseFormatError ||
        error instanceof UnsupportedStreamError ||
        error instanceof UnsupportedReasoningControlError
      ) {
        throw error;
      }
      if (abortCause === "timeout") {
        throw new ModelRequestError("REQUEST_TIMEOUT", "模型请求超时", true);
      }
      if (abortCause === "caller") {
        throw new ModelRequestError("REQUEST_CANCELLED", "模型请求已取消", false);
      }
      throw new ModelRequestError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "模型网络请求失败",
        true,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }

  async completeJson(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    signal: AbortSignal,
  ): Promise<unknown> {
    const useSchema = profile.jsonSchemaSupport !== "unsupported";
    try {
      return await this.request(profile, messages, schema, signal, useSchema);
    } catch (error) {
      if (useSchema && error instanceof UnsupportedResponseFormatError && !signal.aborted) {
        await this.persistJsonSchemaSupport(profile.id, "unsupported");
        return this.request(profile, messages, schema, signal, false);
      }
      if (error instanceof UnsupportedReasoningControlError && !signal.aborted) {
        await this.persistReasoningControl(profile.id, "unsupported");
        const downgraded = { ...profile, reasoningControl: "unsupported" as const };
        return this.request(downgraded, messages, schema, signal, useSchema);
      }
      throw error;
    }
  }

  async probeJsonCapability(
    profile: ModelProfile,
    signal: AbortSignal,
  ): Promise<"supported" | "unsupported"> {
    const messages: readonly ChatMessage[] = [
      { role: "system", content: "Return only the requested JSON object." },
      { role: "user", content: 'Return exactly {"ok":true}.' },
    ];
    const schema: JsonSchemaSpec = {
      name: "connection_probe",
      strict: true,
      schema: {
        type: "object",
        properties: { ok: { const: true } },
        required: ["ok"],
        additionalProperties: false,
      },
    };
    let support: "supported" | "unsupported" = "supported";
    let value: unknown;
    try {
      value = await this.request(profile, messages, schema, signal, true);
    } catch (error) {
      if (!(error instanceof UnsupportedResponseFormatError) || signal.aborted) throw error;
      support = "unsupported";
      await this.persistJsonSchemaSupport(profile.id, "unsupported");
      value = await this.request(profile, messages, schema, signal, false);
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      (value as Record<string, unknown>).ok !== true
    ) {
      throw invalidOutput("模型没有按连通性探测的 JSON 指令作答");
    }
    if (support === "supported") {
      await this.persistJsonSchemaSupport(profile.id, "supported");
    }
    return support;
  }

  private async request(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec,
    callerSignal: AbortSignal,
    useSchema: boolean,
  ): Promise<unknown> {
    const content = await this.requestContent(
      profile,
      messages,
      useSchema ? schema : null,
      callerSignal,
    );
    return parseModelContent(content, "模型返回的正文不是合法 JSON");
  }

  /**
   * 缓冲请求的共享体，返回**未解析的正文**。schema 传 null 即纯文本模式
   * （completeText）：不带 response_format、不做 JSON 解析——追问对话的
   * 自由文本过 parseModelContent 会被整块判成 INVALID_MODEL_OUTPUT。
   */
  private async requestContent(
    profile: ModelProfile,
    messages: readonly ChatMessage[],
    schema: JsonSchemaSpec | null,
    callerSignal: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController();
    let abortCause: "caller" | "timeout" | undefined;
    const onCallerAbort = () => {
      abortCause ??= "caller";
      controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal.aborted) onCallerAbort();
    const timeout = setTimeout(() => {
      abortCause ??= "timeout";
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, profile.timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: profile.model,
        messages,
        temperature: 0,
        stream: false,
        ...reasoningOverride(profile),
      };
      if (schema !== null) body.response_format = responseFormat(schema);
      const headers = new Headers(profile.headers);
      headers.set("Content-Type", "application/json");
      headers.set("Authorization", `Bearer ${profile.apiKey}`);
      const response = await this.fetchImplementation(chatCompletionsUrl(profile.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        // Providers phrase the rejection differently: "response_format is not
        // supported", DeepSeek's serde error "response_format: unknown variant
        // `json_schema`", etc. Any 4xx validation error that names the field
        // is treated as a capability downgrade — the schema-free retry either
        // succeeds or surfaces the real error.
        if (
          schema !== null &&
          (response.status === 400 || response.status === 422) &&
          /response[_ ]?format|json[_ ]?schema/i.test(text)
        ) {
          throw new UnsupportedResponseFormatError();
        }
        if (
          profile.reasoningControl !== "unsupported" &&
          (response.status === 400 || response.status === 422) &&
          /reasoning[_ ]?effort/i.test(text)
        ) {
          throw new UnsupportedReasoningControlError();
        }
        throw mapHttpError(response.status, response.headers.get("Retry-After"), text);
      }

      let envelope: ChatCompletionEnvelope;
      try {
        envelope = JSON.parse(text) as ChatCompletionEnvelope;
      } catch {
        throw invalidOutput("模型响应信封不是合法 JSON");
      }
      const content = envelope.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw invalidOutput("模型响应缺少 choices[0].message.content");
      }
      return content;
    } catch (error) {
      if (
        error instanceof ModelRequestError ||
        error instanceof UnsupportedResponseFormatError ||
        error instanceof UnsupportedReasoningControlError
      ) {
        throw error;
      }
      if (abortCause === "timeout") {
        throw new ModelRequestError("REQUEST_TIMEOUT", "模型请求超时", true);
      }
      if (abortCause === "caller") {
        throw new ModelRequestError("REQUEST_CANCELLED", "模型请求已取消", false);
      }
      throw new ModelRequestError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "模型网络请求失败",
        true,
      );
    } finally {
      clearTimeout(timeout);
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}

class UnsupportedResponseFormatError extends Error {}

/** 端点拒绝 reasoning_effort(OpenAI 官方只收 low/medium/high)——去掉该字段重发一次。 */
class UnsupportedReasoningControlError extends Error {}

class UnsupportedStreamError extends Error {}
