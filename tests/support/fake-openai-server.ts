import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * A local, deterministic OpenAI-compatible chat-completions server for the
 * end-to-end tests. It binds to 127.0.0.1 on an ephemeral port, records
 * sanitized requests and answers with either an automatic, validator-compliant
 * analysis derived from the prompt's own token data, or a scripted outcome
 * (HTTP errors, rate limits, invalid JSON, coverage gaps, timeouts). It never
 * stores or prints Authorization or other credential header values.
 */

export type RequestKind =
  | "probe"
  | "core"
  | "core-repair"
  | "detail"
  | "detail-repair"
  | "sentence-details"
  | "sentence-details-repair"
  | "correction"
  | "correction-repair"
  | "unknown";

export type ScriptedOutcome =
  | { kind: "auto" }
  | { kind: "http"; status: number; body: string; retryAfter?: string }
  | { kind: "invalid-json" }
  | { kind: "schema-unsupported" }
  | { kind: "coverage-gap" }
  | { kind: "partial" }
  | { kind: "xss"; payload: string }
  | { kind: "compound" }
  | { kind: "compound-detail" }
  | { kind: "timeout" };

export interface RecordedRequest {
  kind: RequestKind;
  model: string;
  url: string;
  /** True when an Authorization header was present; its value is never kept. */
  authorizationPresent: boolean;
  usedResponseFormat: boolean;
  /** True when the client asked for a streamed response. */
  streamed: boolean;
  sentenceTexts: string[];
  promptText: string;
}

/**
 * Mirrors the compact Token shape the prompts actually send: character offsets
 * and the whitespace prefix are not transmitted, and `punctuation` appears only
 * when it is true.
 */
interface PromptToken {
  id: number;
  text: string;
  punctuation?: true;
}

interface PromptSentence {
  sentenceId: string;
  text: string;
  tokens: PromptToken[];
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function completion(content: string): string {
  return jsonBody({ choices: [{ message: { content } }] });
}

function detectKind(text: string): RequestKind {
  if (text.includes('Return exactly {"ok":true}')) return "probe";
  if (text.startsWith("Analyze the numbered English sentences")) return "core";
  if (text.startsWith("Repair only the structure of the invalid core-analysis JSON")) {
    return "core-repair";
  }
  if (text.startsWith("Explain only the selected grammatical component")) return "detail";
  if (text.startsWith("Repair only the structure of the invalid detail-analysis JSON")) {
    return "detail-repair";
  }
  if (text.startsWith("Explain each requested grammatical component")) return "sentence-details";
  if (text.startsWith("Repair only the structure of the invalid sentence-details JSON")) {
    return "sentence-details-repair";
  }
  if (text.startsWith("Reanalyze the supplied sentence")) return "correction";
  if (text.startsWith("Repair only the structure of the invalid correction analysis")) {
    return "correction-repair";
  }
  return "unknown";
}

/** Extract every balanced JSON value embedded in free-form prompt text. */
function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const opener = text[index];
    if (opener !== "{" && opener !== "[") continue;
    const end = scanBalanced(text, index);
    if (end === -1) continue;
    try {
      values.push(JSON.parse(text.slice(index, end + 1)));
      index = end;
    } catch {
      // Not standalone JSON; keep scanning from the next character.
    }
  }
  return values;
}

function scanBalanced(text: string, start: number): number {
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (
      character === open ||
      (character === "{" && open === "[") ||
      (character === "[" && open === "{")
    ) {
      depth += 1;
    } else if (character === close || character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isPromptToken(value: unknown): value is PromptToken {
  if (typeof value !== "object" || value === null) return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.id === "number" &&
    typeof token.text === "string" &&
    (token.punctuation === undefined || token.punctuation === true)
  );
}

function isPromptSentence(value: unknown): value is PromptSentence {
  if (typeof value !== "object" || value === null) return false;
  const sentence = value as Record<string, unknown>;
  return (
    typeof sentence.sentenceId === "string" &&
    typeof sentence.text === "string" &&
    Array.isArray(sentence.tokens) &&
    sentence.tokens.length > 0 &&
    sentence.tokens.every(isPromptToken)
  );
}

function extractSentences(text: string): PromptSentence[] {
  const byId = new Map<string, PromptSentence>();
  for (const value of extractJsonValues(text)) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (isPromptSentence(candidate) && !byId.has(candidate.sentenceId)) {
        byId.set(candidate.sentenceId, candidate);
      }
    }
  }
  return [...byId.values()];
}

interface GeneratedComponent {
  startToken: number;
  endToken: number;
  role: string;
  translation: string;
}

/**
 * Produce a deterministic, validator-compliant core analysis: the first
 * non-punctuation token is the subject, the remaining tokens are the predicate.
 */
function autoComponents(sentence: PromptSentence, translationSuffix = ""): GeneratedComponent[] {
  const lexical = sentence.tokens.filter((token) => !token.punctuation);
  const first = lexical[0]!;
  const last = lexical.at(-1)!;
  if (lexical.length === 1) {
    return [
      {
        startToken: first.id,
        endToken: first.id,
        role: "SUBJECT",
        translation: `主语${translationSuffix}`,
      },
    ];
  }
  const second = lexical[1]!;
  return [
    {
      startToken: first.id,
      endToken: first.id,
      role: "SUBJECT",
      translation: `主语${translationSuffix}`,
    },
    {
      startToken: second.id,
      endToken: last.id,
      role: "PREDICATE",
      translation: `谓语与其余成分${translationSuffix}`,
    },
  ];
}

function coverageGapComponents(): GeneratedComponent[] {
  // Covering only token 0 leaves later lexical tokens uncovered, so the
  // extension's validator rejects the sentence and requests one repair.
  return [{ startToken: 0, endToken: 0, role: "SUBJECT", translation: "占位" }];
}

/**
 * A deterministic compound-sentence analysis: the tokens before the first
 * coordinating conjunction form one COORDINATE_CLAUSE, the conjunction is its
 * own CONJUNCTION component, and the remaining lexical tokens form the second
 * COORDINATE_CLAUSE. A sentence without an inner conjunction falls back to
 * the automatic simple analysis so the outcome stays validator-compliant.
 */
function compoundComponents(sentence: PromptSentence): GeneratedComponent[] {
  const conjunction = sentence.tokens.find(
    (token) => !token.punctuation && ["and", "but", "or", "so"].includes(token.text.toLowerCase()),
  );
  const lexical = sentence.tokens.filter((token) => !token.punctuation);
  if (conjunction === undefined || conjunction === lexical[0] || conjunction === lexical.at(-1)) {
    return autoComponents(sentence);
  }
  return [
    {
      startToken: lexical[0]!.id,
      endToken: conjunction.id - 1,
      role: "COORDINATE_CLAUSE",
      translation: "第一分句的完整翻译",
    },
    {
      startToken: conjunction.id,
      endToken: conjunction.id,
      role: "CONJUNCTION",
      translation: "并且",
    },
    {
      startToken: conjunction.id + 1,
      endToken: lexical.at(-1)!.id,
      role: "COORDINATE_CLAUSE",
      translation: "第二分句的完整翻译",
    },
  ];
}

/** Shared by the detail responders: recover the requested focus from the prompt. */
function parseFocus(promptText: string): { startToken: number; endToken: number } {
  const match = /Focus(?: range)?:\s*\n+\s*\{\s*"startToken":\s*(\d+),\s*"endToken":\s*(\d+)/.exec(
    promptText,
  );
  return match
    ? { startToken: Number(match[1]), endToken: Number(match[2]) }
    : { startToken: 0, endToken: 0 };
}

/**
 * Recover the batched sentence-details targets from the prompt: the sentenceId
 * is the first "sentenceId" field and the focus array is the prompt's last
 * section, after the "Requested focus ranges:" marker.
 */
function sentenceDetailsTargets(promptText: string): {
  sentenceId: string;
  focuses: { startToken: number; endToken: number }[];
} {
  const sentenceId = promptText.match(/"sentenceId":\s*"([^"]+)"/)?.[1] ?? "unknown";
  const section = promptText.split("Requested focus ranges:")[1] ?? "[]";
  const focuses = JSON.parse(section.trim()) as { startToken: number; endToken: number }[];
  return { sentenceId, focuses };
}

export class FakeOpenAiServer {
  private readonly server: Server;
  private readonly scriptQueues = new Map<string, ScriptedOutcome[]>();
  /** "chunked" 逐片回流;"reject" 用 400 拒掉流式以覆盖降级路径。 */
  private streamMode: "chunked" | "reject" = "chunked";
  /** 置位后流会停在 [DONE] 之前，供 E2E 断言中间态。 */
  private streamGate?: { promise: Promise<void>; release: () => void };
  private readonly requests: RecordedRequest[] = [];
  private port = 0;

  private constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  static async start(): Promise<FakeOpenAiServer> {
    const instance = new FakeOpenAiServer();
    await new Promise<void>((resolve) => {
      instance.server.listen(0, "127.0.0.1", resolve);
    });
    instance.port = (instance.server.address() as AddressInfo).port;
    return instance;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /**
   * Queue scripted outcomes for a model. Each matching request consumes one
   * outcome; when the queue is empty the automatic behavior answers instead.
   */
  script(model: string, outcomes: ScriptedOutcome[]): void {
    this.scriptQueues.set(model, [...outcomes]);
  }

  recorded(): readonly RecordedRequest[] {
    return this.requests;
  }

  recordedOfKind(...kinds: RequestKind[]): RecordedRequest[] {
    return this.requests.filter((request) => kinds.includes(request.kind));
  }

  clearRecorded(): void {
    this.requests.length = 0;
  }

  setStreamMode(mode: "chunked" | "reject"): void {
    this.streamMode = mode;
  }

  /** 挂住流式响应的收尾;返回放行函数。 */
  holdStreamBeforeEnd(): () => void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    this.streamGate = { promise, release };
    return () => {
      this.streamGate = undefined;
      release();
    };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let payload: {
      model: string;
      usedResponseFormat: boolean;
      stream: boolean;
      promptText: string;
    };
    try {
      const raw = JSON.parse(await readBody(request)) as {
        model?: unknown;
        response_format?: unknown;
        stream?: unknown;
        messages?: Array<{ content?: unknown }>;
      };
      payload = {
        model: typeof raw.model === "string" ? raw.model : "",
        usedResponseFormat: raw.response_format !== undefined,
        stream: raw.stream === true,
        promptText: Array.isArray(raw.messages)
          ? raw.messages
              .map((message) => (typeof message.content === "string" ? message.content : ""))
              .join("\n")
          : "",
      };
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(jsonBody({ error: "invalid request body" }));
      return;
    }

    const kind = detectKind(payload.promptText);
    const sentences = extractSentences(payload.promptText);
    this.requests.push({
      kind,
      model: payload.model,
      url: request.url ?? "",
      authorizationPresent: typeof request.headers.authorization === "string",
      usedResponseFormat: payload.usedResponseFormat,
      streamed: payload.stream,
      sentenceTexts: sentences.map((sentence) => sentence.text),
      promptText: payload.promptText,
    });

    const queue = this.scriptQueues.get(payload.model);
    const outcome: ScriptedOutcome = queue?.length ? queue.shift()! : { kind: "auto" };
    void this.reply(
      response,
      outcome,
      kind,
      sentences,
      payload.usedResponseFormat,
      payload.promptText,
      payload.stream,
    );
  }

  private async reply(
    response: ServerResponse,
    outcome: ScriptedOutcome,
    kind: RequestKind,
    sentences: PromptSentence[],
    usedResponseFormat: boolean,
    promptText: string,
    streaming = false,
  ): Promise<void> {
    // 被要求关掉流式的端点:用 400 拒绝，扩展应记住并改走整段返回。
    if (streaming && this.streamMode === "reject") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(jsonBody({ error: "stream is not supported by this model" }));
      return;
    }
    switch (outcome.kind) {
      case "timeout":
        // Intentionally never respond; the extension aborts on its own timeout.
        return;
      case "http":
        response.writeHead(outcome.status, {
          "content-type": "application/json",
          ...(outcome.retryAfter === undefined ? {} : { "retry-after": outcome.retryAfter }),
        });
        response.end(outcome.body);
        return;
      case "schema-unsupported":
        if (usedResponseFormat) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(jsonBody({ error: "response_format is not supported by this model" }));
          return;
        }
        await this.reply(
          response,
          { kind: "auto" },
          kind,
          sentences,
          usedResponseFormat,
          promptText,
          streaming,
        );
        return;
      case "invalid-json":
        await this.writeContent(response, "this is not json", streaming);
        return;
      case "coverage-gap":
        await this.respondCore(response, sentences, () => coverageGapComponents(), streaming);
        return;
      case "partial":
        // First sentence valid, later sentences invalid: exercises the
        // partial-batch repair and isolation paths.
        await this.respondCore(
          response,
          sentences,
          (sentence, index) => (index === 0 ? autoComponents(sentence) : coverageGapComponents()),
          streaming,
        );
        return;
      case "xss":
        await this.respondCore(
          response,
          sentences,
          (sentence) =>
            autoComponents(sentence).map((component) => ({
              ...component,
              translation: outcome.payload,
            })),
          streaming,
        );
        return;
      case "compound":
        await this.respondCore(
          response,
          sentences,
          (sentence) => compoundComponents(sentence),
          streaming,
        );
        return;
      case "compound-detail":
        await this.respondCompoundDetail(response, sentences, streaming);
        return;
      case "auto":
        await this.respondAuto(response, kind, sentences, promptText, streaming);
        return;
    }
  }

  private async respondAuto(
    response: ServerResponse,
    kind: RequestKind,
    sentences: PromptSentence[],
    promptText: string,
    streaming = false,
  ): Promise<void> {
    switch (kind) {
      case "probe":
        await this.writeContent(response, '{"ok":true}', streaming);
        return;
      case "detail":
      case "detail-repair":
        await this.respondDetail(response, sentences, streaming);
        return;
      case "sentence-details":
      case "sentence-details-repair": {
        const { sentenceId, focuses } = sentenceDetailsTargets(promptText);
        await this.json(
          response,
          { details: focuses.map((focus) => this.validDetailFor(sentenceId, focus)) },
          streaming,
        );
        return;
      }
      case "correction":
      case "correction-repair":
        await this.respondCore(
          response,
          sentences,
          (sentence) => autoComponents(sentence, "（已纠正）"),
          streaming,
        );
        return;
      default:
        await this.respondCore(
          response,
          sentences,
          (sentence) => autoComponents(sentence),
          streaming,
        );
        return;
    }
  }

  /** 任何"模型内容"都必须经这里出去，否则流式请求会拿到 JSON 体而误判不支持流式。 */
  private async writeContent(
    response: ServerResponse,
    content: string,
    streaming: boolean,
  ): Promise<void> {
    if (!streaming) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion(content));
      return;
    }
    await this.streamContent(response, content);
  }

  private async respondCore(
    response: ServerResponse,
    sentences: PromptSentence[],
    components: (sentence: PromptSentence, index: number) => GeneratedComponent[],
    streaming = false,
  ): Promise<void> {
    const body = {
      sentences: sentences.map((sentence, index) => ({
        sentenceId: sentence.sentenceId,
        components: components(sentence, index),
      })),
    };
    await this.writeContent(response, jsonBody(body), streaming);
  }

  /**
   * 把内容切片按 SSE 逐个下发。切片边界刻意落在成分之间，让客户端的增量解析器
   * 真的要跨片配平括号。
   */
  private async streamContent(response: ServerResponse, content: string): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const pieces = Math.min(8, Math.max(2, Math.ceil(content.length / 40)));
    const size = Math.ceil(content.length / pieces);
    for (let index = 0; index < content.length; index += size) {
      response.write(
        `data: ${jsonBody({ choices: [{ delta: { content: content.slice(index, index + size) } }] })}\n\n`,
      );
    }
    await this.streamGate?.promise;
    response.write("data: [DONE]\n\n");
    response.end();
  }

  private async respondDetail(
    response: ServerResponse,
    sentences: PromptSentence[],
    streaming = false,
  ): Promise<void> {
    const sentence = sentences[0];
    const focus = parseFocus(this.requests.at(-1)?.promptText ?? "");
    await this.json(response, this.validDetailFor(sentence?.sentenceId ?? "", focus), streaming);
  }

  /** Answer with a chat completion whose message content is the given JSON value. */
  private async json(response: ServerResponse, value: unknown, streaming = false): Promise<void> {
    await this.writeContent(response, jsonBody(value), streaming);
  }

  /** A deterministic, validator-compliant single-component detail analysis. */
  private validDetailFor(
    sentenceId: string,
    focus: { startToken: number; endToken: number },
  ): Record<string, unknown> {
    const { startToken, endToken } = focus;
    return {
      sentenceId,
      focus: { startToken, endToken },
      structures: [
        {
          startToken,
          endToken,
          role: "核心成分",
          explanation: "该成分承担句子的核心语法功能。",
          translation: "核心成分译文",
        },
      ],
      grammarPoints: ["示例语法点"],
      explanation: "这是针对所选成分的详细语法解析。",
    };
  }

  private async respondCompoundDetail(
    response: ServerResponse,
    sentences: PromptSentence[],
    streaming = false,
  ): Promise<void> {
    const sentence = sentences[0];
    const { startToken, endToken } = parseFocus(this.requests.at(-1)?.promptText ?? "");
    await this.writeContent(
      response,
      jsonBody({
        sentenceId: sentence?.sentenceId ?? "",
        focus: { startToken, endToken },
        // Token indices assume the compound-article.html fixture sentence
        // "The sun rose and the birds sang." (tokens 0-7).
        structures: [
          {
            startToken: 0,
            endToken: 1,
            role: "主语",
            explanation: "The sun 是第一分句的主语。",
            translation: "太阳",
          },
          {
            startToken: 2,
            endToken: 2,
            role: "谓语",
            explanation: "rose 是第一分句的谓语动词。",
            translation: "升起",
          },
          {
            startToken: 3,
            endToken: 3,
            role: "并列连词",
            explanation: "and 连接前后两个并列分句。",
            translation: "和",
          },
        ],
        grammarPoints: ["并列句"],
        explanation: "这是针对所选并列分句的详细语法解析。",
      }),
      streaming,
    );
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}
