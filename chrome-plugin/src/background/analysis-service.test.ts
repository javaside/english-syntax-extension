import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateCoreBatch } from "../language/analysis-validator";
import { tokenize } from "../language/segmenter";
import { GrammarRole } from "../shared/grammar";
import { CORE_SCHEMA_VERSION } from "../shared/versions";
import type { CoreAnalysis, TokenRange } from "../shared/grammar";
import { MAX_SENTENCES_PER_REQUEST } from "../shared/protocol";
import type { SentenceInput } from "../shared/protocol";
import { ModelRequestError } from "./openai-compatible-adapter";
import { buildCorePrompt } from "./prompts";
import type { ModelProfile } from "./config-repository";
import {
  CachedAnalysisService,
  type AnalysisCachePort,
  type AnalysisModelWork,
  type AnalysisScheduledRequest,
  type AnalysisScheduler,
} from "./analysis-service";

const profile: ModelProfile = {
  id: "profile-1",
  name: "Compatible",
  baseUrl: "https://model.example/v1",
  apiKey: "secret",
  model: "syntax-model",
  headers: {},
  timeoutMs: 5_000,
  jsonSchemaSupport: "supported",
};

const sentenceOne: SentenceInput = {
  sentenceId: "sentence-1",
  text: "Learners read.",
  tokens: [
    { id: 0, text: "Learners", start: 0, end: 8, leadingWhitespace: "", punctuation: false },
    { id: 1, text: "read", start: 9, end: 13, leadingWhitespace: " ", punctuation: false },
    { id: 2, text: ".", start: 13, end: 14, leadingWhitespace: "", punctuation: true },
  ],
};

const sentenceTwo: SentenceInput = {
  sentenceId: "sentence-2",
  text: "Writers revise.",
  tokens: [
    { id: 0, text: "Writers", start: 0, end: 7, leadingWhitespace: "", punctuation: false },
    { id: 1, text: "revise", start: 8, end: 14, leadingWhitespace: " ", punctuation: false },
    { id: 2, text: ".", start: 14, end: 15, leadingWhitespace: "", punctuation: true },
  ],
};

function rawCore(sentence: SentenceInput) {
  return {
    sentenceId: sentence.sentenceId,
    components: [
      { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主语" },
      { startToken: 1, endToken: 2, role: "PREDICATE", translation: "谓语" },
    ],
  };
}

function coreAnalysis(sentence: SentenceInput, modelProfileId = profile.id): CoreAnalysis {
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    sentenceId: sentence.sentenceId,
    components: [
      { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "主语" },
      { startToken: 1, endToken: 2, role: GrammarRole.PREDICATE, translation: "谓语" },
    ],
    modelProfileId,
  };
}

function rawDetail(focus: TokenRange) {
  return {
    sentenceId: sentenceOne.sentenceId,
    focus,
    structures: [{ ...focus, role: "verb phrase", explanation: "谓语结构" }],
    grammarPoints: ["一般现在时"],
    explanation: "详细说明。",
  };
}

class MemoryCache implements AnalysisCachePort {
  readonly core = new Map<string, unknown>();
  readonly detail = new Map<string, unknown>();
  readonly correction = new Map<string, unknown>();

  getCore<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.core.get(key) as T | undefined);
  }

  putCore<T>(key: string, _profileId: string, value: T): Promise<void> {
    this.core.set(key, value);
    return Promise.resolve();
  }

  getDetail<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.detail.get(key) as T | undefined);
  }

  putDetail<T>(key: string, _profileId: string, value: T): Promise<void> {
    this.detail.set(key, value);
    return Promise.resolve();
  }

  getCorrection<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.correction.get(key) as T | undefined);
  }

  putCorrection<T>(key: string, _profileId: string, value: T): Promise<void> {
    this.correction.set(key, value);
    return Promise.resolve();
  }
}

class DedupeScheduler implements AnalysisScheduler {
  readonly schedule = vi.fn((request: AnalysisScheduledRequest) => {
    const identity = `${request.documentId}\0${request.cacheKey}`;
    const duplicate = this.inFlight.get(identity);
    if (duplicate !== undefined) return duplicate;
    const controller = new AbortController();
    this.controllers.set(request.documentId, controller);
    const result = request.input.run(controller.signal).finally(() => {
      this.inFlight.delete(identity);
      this.controllers.delete(request.documentId);
    });
    this.inFlight.set(identity, result);
    return result;
  });

  readonly cancelDocument = vi.fn((documentId: string) => {
    this.controllers.get(documentId)?.abort();
  });

  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
}

function harness(outputs: readonly unknown[]) {
  const cache = new MemoryCache();
  const completeJson = vi.fn().mockImplementation(() => {
    const next = outputs[completeJson.mock.calls.length - 1];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const adapter = { completeJson };
  const scheduler = new DedupeScheduler();
  const service = new CachedAnalysisService({
    cache,
    adapter,
    scheduler,
    now: () => 42,
  });
  return { adapter, cache, scheduler, service };
}

function coreInput(sentences: SentenceInput[] = [sentenceOne], selectedProfile = profile) {
  return {
    profile: selectedProfile,
    documentId: "document-1",
    sentences,
    priority: "visible-core" as const,
  };
}

describe("CachedAnalysisService core orchestration", () => {
  it("bypassCache skips reads but overwrites the cache with the fresh result", async () => {
    const { adapter, cache, scheduler, service } = harness([
      { sentences: [rawCore(sentenceOne)] },
      { sentences: [rawCore(sentenceOne)] },
    ]);
    await service.analyzeCore(coreInput(), new AbortController().signal);
    expect(cache.core.size).toBe(1);
    adapter.completeJson.mockClear();
    scheduler.schedule.mockClear();

    const outcome = await service.analyzeCore(
      { ...coreInput(), bypassCache: true },
      new AbortController().signal,
    );

    expect(outcome.cacheHit).toBe(false);
    expect(adapter.completeJson).toHaveBeenCalledTimes(1);
    expect(cache.core.size).toBe(1);
  });

  it("returns a cache hit without scheduling or calling the adapter", async () => {
    const { adapter, scheduler, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);
    await service.analyzeCore(coreInput(), new AbortController().signal);
    adapter.completeJson.mockClear();
    scheduler.schedule.mockClear();

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome).toEqual({
      result: [coreAnalysis(sentenceOne)],
      failures: [],
      cacheHit: true,
    });
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(adapter.completeJson).not.toHaveBeenCalled();
  });

  it("rebinds a same-text core cache hit to the current sentence ID and profile", async () => {
    const reboundSentence = { ...sentenceOne, sentenceId: "sentence-rebound" };
    const { adapter, cache, scheduler, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);
    await service.analyzeCore(coreInput(), new AbortController().signal);
    const key = cache.core.keys().next().value;
    if (key === undefined) throw new Error("expected a core cache entry");
    cache.core.set(key, { ...coreAnalysis(sentenceOne), modelProfileId: "stale-profile" });
    adapter.completeJson.mockClear();
    scheduler.schedule.mockClear();

    const outcome = await service.analyzeCore(
      coreInput([reboundSentence]),
      new AbortController().signal,
    );

    expect(outcome).toEqual({
      result: [coreAnalysis(reboundSentence)],
      failures: [],
      cacheHit: true,
    });
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(adapter.completeJson).not.toHaveBeenCalled();
  });

  it("treats a same-text cache entry with incompatible tokenization as a miss", async () => {
    const retokenized: SentenceInput = {
      ...sentenceOne,
      sentenceId: "sentence-retokenized",
      tokens: [
        {
          id: 0,
          text: "Learners read",
          start: 0,
          end: 13,
          leadingWhitespace: "",
          punctuation: false,
        },
        { id: 1, text: ".", start: 13, end: 14, leadingWhitespace: "", punctuation: true },
      ],
    };
    const retokenizedRaw = {
      sentenceId: retokenized.sentenceId,
      components: [{ startToken: 0, endToken: 1, role: "SUBJECT", translation: "学习者阅读" }],
    };
    const { adapter, service } = harness([
      { sentences: [rawCore(sentenceOne)] },
      { sentences: [retokenizedRaw] },
    ]);
    await service.analyzeCore(coreInput(), new AbortController().signal);

    const outcome = await service.analyzeCore(
      coreInput([retokenized]),
      new AbortController().signal,
    );

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.result[0]).toMatchObject({
      sentenceId: retokenized.sentenceId,
      components: [{ startToken: 0, endToken: 1 }],
      modelProfileId: profile.id,
    });
    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
  });

  it("treats malformed cached core fields as a miss", async () => {
    const { adapter, cache, service } = harness([
      { sentences: [rawCore(sentenceOne)] },
      { sentences: [rawCore(sentenceOne)] },
    ]);
    await service.analyzeCore(coreInput(), new AbortController().signal);
    const key = cache.core.keys().next().value;
    if (key === undefined) throw new Error("expected a core cache entry");
    cache.core.set(key, { components: "not-an-array" });

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.result).toEqual([coreAnalysis(sentenceOne)]);
    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent identical misses into one model call", async () => {
    let release!: (value: unknown) => void;
    const raw = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const { adapter, scheduler, service } = harness([raw]);

    const first = service.analyzeCore(coreInput(), new AbortController().signal);
    const second = service.analyzeCore(coreInput(), new AbortController().signal);
    await vi.waitFor(() => expect(scheduler.schedule).toHaveBeenCalledTimes(2));
    release({ sentences: [rawCore(sentenceOne)] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { result: [coreAnalysis(sentenceOne)], failures: [], cacheHit: false },
      { result: [coreAnalysis(sentenceOne)], failures: [], cacheHit: false },
    ]);
    expect(adapter.completeJson).toHaveBeenCalledTimes(1);
  });

  it("caches valid raw output and stamps the scheduled work with the injected clock", async () => {
    const { cache, scheduler, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome.result).toEqual([coreAnalysis(sentenceOne)]);
    expect(cache.core.size).toBe(1);
    expect(scheduler.schedule.mock.calls[0]![0].input.requestedAt).toBe(42);
  });

  it("supplies a strict nested core schema to compatible adapters", async () => {
    const { adapter, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);

    await service.analyzeCore(coreInput(), new AbortController().signal);

    const schemaJson = JSON.stringify(adapter.completeJson.mock.calls[0]![2]);
    expect(schemaJson).toContain('"components"');
    expect(schemaJson).toContain('"startToken"');
    expect(schemaJson).toContain('"endToken"');
    expect(schemaJson).toContain('"role"');
    expect(schemaJson).toContain('"translation"');
  });

  it("sends exactly one repair request after invalid raw output", async () => {
    const { adapter, service } = harness([
      { sentences: [{ ...rawCore(sentenceOne), components: [] }] },
      { sentences: [rawCore(sentenceOne)] },
    ]);

    await expect(
      service.analyzeCore(coreInput(), new AbortController().signal),
    ).resolves.toMatchObject({ result: [coreAnalysis(sentenceOne)], failures: [] });
    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
    const repairWork = adapter.completeJson.mock.calls[1] as [
      ModelProfile,
      AnalysisModelWork["messages"],
    ];
    expect(repairWork[1][0]!.content).toMatch(/repair only/i);
    expect(repairWork[1][0]!.content).toContain("must be a non-empty array");
  });

  it("still enters the repair loop when the first output cannot be parsed at all", async () => {
    // 回归:此前首轮 INVALID_MODEL_OUTPUT 直接把整块判死,修复轮压根不跑(core-repair 0 → 0)。
    const { adapter, cache, service } = harness([
      new ModelRequestError(
        "INVALID_MODEL_OUTPUT",
        "Model stream content is not valid JSON",
        false,
      ),
      { sentences: [rawCore(sentenceOne)] },
    ]);

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome).toMatchObject({ result: [coreAnalysis(sentenceOne)], failures: [] });
    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
    expect(cache.core.size).toBe(1);
    const repairWork = adapter.completeJson.mock.calls[1] as [
      ModelProfile,
      AnalysisModelWork["messages"],
    ];
    expect(repairWork[1][0]!.content).toMatch(/repair only/i);
  });

  it("does not spend a repair round on network, auth, or timeout failures", async () => {
    for (const failure of [
      new ModelRequestError("NETWORK_ERROR", "boom", true),
      new ModelRequestError("AUTH_FAILED", "bad key", false),
      new ModelRequestError("REQUEST_TIMEOUT", "too slow", true),
    ]) {
      const { adapter, service } = harness([failure, { sentences: [rawCore(sentenceOne)] }]);

      // 唯一的块整块失败时错误照旧上抛(SW 靠 AUTH_FAILED 暂停 profile)。
      await expect(
        service.analyzeCore(coreInput(), new AbortController().signal),
      ).rejects.toMatchObject({ code: failure.code });
      expect(adapter.completeJson).toHaveBeenCalledTimes(1);
    }
  });

  it("retries only the sentences that remain invalid after the first repair", async () => {
    const invalid = { sentences: [{ ...rawCore(sentenceOne), components: [] }] };
    const { adapter, cache, service } = harness([
      invalid,
      invalid,
      { sentences: [rawCore(sentenceOne)] },
    ]);

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome).toMatchObject({ result: [coreAnalysis(sentenceOne)], failures: [] });
    expect(adapter.completeJson).toHaveBeenCalledTimes(3);
    const secondRepairWork = adapter.completeJson.mock.calls[2] as [
      ModelProfile,
      AnalysisModelWork["messages"],
    ];
    expect(secondRepairWork[1][0]!.content).toContain("must be a non-empty array");
    expect(cache.core.size).toBe(1);
  });

  it("returns INVALID_MODEL_OUTPUT and does not cache after two unparseable repairs", async () => {
    const invalidOutput = new ModelRequestError(
      "INVALID_MODEL_OUTPUT",
      "Model stream content is not valid JSON",
      false,
    );
    const { adapter, cache, service } = harness([invalidOutput, invalidOutput, invalidOutput]);

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome.result).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]!.sentenceId).toBe(sentenceOne.sentenceId);
    expect(outcome.failures[0]!.error).toMatchObject({
      code: "INVALID_MODEL_OUTPUT",
      retryable: false,
    });
    expect(adapter.completeJson).toHaveBeenCalledTimes(3);
    expect(cache.core.size).toBe(0);
  });

  it("keeps valid siblings when another sentence remains invalid after repair", async () => {
    const invalidTwo = { ...rawCore(sentenceTwo), components: [] };
    const { cache, service } = harness([
      { sentences: [rawCore(sentenceOne), invalidTwo] },
      { sentences: [invalidTwo] },
    ]);

    const outcome = await service.analyzeCore(
      coreInput([sentenceOne, sentenceTwo]),
      new AbortController().signal,
    );

    expect(outcome.result).toEqual([coreAnalysis(sentenceOne)]);
    expect(outcome.failures.map(({ sentenceId, error }) => [sentenceId, error.code])).toEqual([
      [sentenceTwo.sentenceId, "INVALID_MODEL_OUTPUT"],
    ]);
    expect(cache.core.size).toBe(1);
  });

  it("shares cache entries across profiles, providers, and models for the same sentence", async () => {
    const otherProfile = {
      ...profile,
      id: "profile-2",
      name: "Second",
      baseUrl: "https://other-provider.example/v1",
      model: "another-model",
    };
    const { adapter, cache, scheduler, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);

    const first = await service.analyzeCore(coreInput(), new AbortController().signal);
    adapter.completeJson.mockClear();
    scheduler.schedule.mockClear();
    const second = await service.analyzeCore(
      coreInput([sentenceOne], otherProfile),
      new AbortController().signal,
    );

    expect(first.result[0]!.modelProfileId).toBe("profile-1");
    expect(second.cacheHit).toBe(true);
    expect(second.result[0]!.modelProfileId).toBe("profile-2");
    expect(adapter.completeJson).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(cache.core.size).toBe(1);
  });

  it.each([
    ["network", new ModelRequestError("NETWORK_ERROR", "offline", true)],
    ["authorization", new ModelRequestError("AUTH_FAILED", "bad key", false)],
    ["cancellation", new ModelRequestError("REQUEST_CANCELLED", "cancelled", false)],
  ])("does not cache %s errors", async (_kind, error) => {
    const { adapter, cache, service } = harness([error, error]);

    await expect(service.analyzeCore(coreInput(), new AbortController().signal)).rejects.toBe(
      error,
    );
    await expect(service.analyzeCore(coreInput(), new AbortController().signal)).rejects.toBe(
      error,
    );

    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
    expect(cache.core.size).toBe(0);
  });
});

describe("shared core evaluation trace replay", () => {
  it("replays through the production service with cold bypassed cache and shrinking subsets", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../shared-fixtures/core-evaluation-traces.json", import.meta.url),
        "utf8",
      ),
    ) as {
      schemaVersion: string;
      corpus: {
        denominatorSentenceIds: string[];
        sentences: Array<{
          id: string;
          boundaries: Array<{ startChar: number; endChar: number; role: string }>;
        }>;
      };
      tokenizerSnapshot: {
        sentences: Array<{
          id: string;
          text: string;
          tokens: Array<{ id: number; start: number; end: number }>;
        }>;
      };
      traces: Array<{
        inputSentenceIds: string[];
        firstPass: {
          messages: AnalysisModelWork["messages"];
          serializedSubset?: string;
          subsetSentenceIds: string[];
          raw: unknown;
          validatorErrors: Array<{
            sentenceId: string;
            errors: Array<{ path: string; message: string; kind: "grammar" | "non-grammar" }>;
          }>;
        };
        repairs: Array<{
          round: number;
          messages: AnalysisModelWork["messages"];
          serializedSubset?: string;
          subsetSentenceIds: string[];
          raw: unknown;
          validatorErrors: Array<{
            sentenceId: string;
            errors: Array<{ path: string; message: string; kind: "grammar" | "non-grammar" }>;
          }>;
        }>;
        final: {
          successSentenceIds: string[];
          failureSentenceIds: string[];
          analyses: Array<{
            sentenceId: string;
            components: Array<{ startToken: number; endToken: number; role: string }>;
          }>;
        };
      }>;
    };
    expect(fixture.schemaVersion).toBe("core-evaluation-trace/v1");
    const trace = fixture.traces[0]!;
    expect(trace.firstPass.subsetSentenceIds).toEqual(trace.inputSentenceIds);
    expect(trace.repairs.map(({ round }) => round)).toEqual([1, 2]);
    expect(trace.inputSentenceIds).toEqual(fixture.corpus.denominatorSentenceIds.slice(0, 6));
    const byId = new Map(fixture.tokenizerSnapshot.sentences.map((item) => [item.id, item]));
    const sentences = trace.inputSentenceIds.map((sentenceId) => {
      const item = byId.get(sentenceId)!;
      return { sentenceId, text: item.text, tokens: tokenize(item.text) };
    });
    const cache = new MemoryCache();
    const observedMessages: AnalysisModelWork["messages"][] = [];
    const observedSubsets: string[][] = [];
    const rounds = [trace.firstPass, ...trace.repairs];
    const rawByRound = rounds.map(({ raw }) => raw);
    const completeJson = vi.fn((_profile, messages: AnalysisModelWork["messages"]) => {
      const ids = sentences
        .filter(({ sentenceId }) => messages[0]!.content.includes(`"sentenceId":"${sentenceId}"`))
        .map(({ sentenceId }) => sentenceId);
      observedMessages.push(messages);
      observedSubsets.push(ids);
      return Promise.resolve(rawByRound[observedSubsets.length - 1]);
    });
    const service = new CachedAnalysisService({
      cache,
      adapter: { completeJson },
      scheduler: new DedupeScheduler(),
      now: () => 42,
    });

    const outcome = await service.analyzeCore(
      {
        ...coreInput(sentences, { ...profile, baseUrl: "http://localhost:11434/v1" }),
        bypassCache: true,
      },
      new AbortController().signal,
    );

    expect(outcome.cacheHit).toBe(false);
    expect(completeJson).toHaveBeenCalledTimes(3);
    expect(observedMessages).toEqual(rounds.map(({ messages }) => messages));
    expect(observedSubsets).toEqual(rounds.map(({ subsetSentenceIds }) => subsetSentenceIds));
    const observedDiagnostics = rounds.map((round) => {
      const subset = round.subsetSentenceIds.map((sentenceId) =>
        sentences.find((item) => item.sentenceId === sentenceId)!,
      );
      const validation = validateCoreBatch(round.raw, subset, profile.id);
      return validation.ok ? [] : validation.errors;
    });
    expect(observedDiagnostics).toEqual(
      rounds.map((round) =>
        round.validatorErrors.flatMap(({ errors }) =>
          errors.map(({ path, message }) => ({ path, message })),
        ),
      ),
    );
    expect(outcome.result.map(({ sentenceId }) => sentenceId)).toEqual(
      trace.final.successSentenceIds,
    );
    expect(outcome.failures.map(({ sentenceId }) => sentenceId)).toEqual(
      trace.final.failureSentenceIds,
    );
    expect(observedSubsets.slice(1)).toEqual(
      trace.repairs.map(({ subsetSentenceIds }) => subsetSentenceIds),
    );
    expect(
      outcome.result.map(({ sentenceId, components }) => ({
        sentenceId,
        components: components.map(({ startToken, endToken, role }) => ({
          startToken,
          endToken,
          role,
        })),
      })),
    ).toEqual(trace.final.analyses);
    expect(cache.core.size).toBe(trace.final.successSentenceIds.length);
    const legalId = trace.inputSentenceIds[0]!;
    expect(outcome.result.find(({ sentenceId }) => sentenceId === legalId)).toBeDefined();
    expect(observedSubsets.slice(1).flat()).not.toContain(legalId);
    expect(rounds[0]!.validatorErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sentenceId: trace.inputSentenceIds[1] }),
        expect.objectContaining({ sentenceId: trace.inputSentenceIds[2] }),
      ]),
    );
    const componentShape = (analysis: {
      components: Array<{ startToken: number; endToken: number; role: string }>;
    }) =>
      analysis.components.map(({ startToken, endToken, role }) => ({ startToken, endToken, role }));
    const goldTokenShape = (sentenceId: string) => {
      const snapshot = byId.get(sentenceId)!;
      const gold = fixture.corpus.sentences.find(({ id }) => id === sentenceId)!;
      return gold.boundaries.map(({ startChar, endChar, role }) => ({
        startToken: snapshot.tokens.find(({ start }) => start === startChar)!.id,
        endToken: snapshot.tokens.find(({ end }) => end === endChar)!.id,
        role,
      }));
    };
    const damagedId = trace.inputSentenceIds[2]!;
    const damagedFirst = (
      rounds[0]!.raw as {
        sentences: Array<{
          sentenceId: string;
          components: Array<{ startToken: number; endToken: number; role: string }>;
        }>;
      }
    ).sentences.find(({ sentenceId }) => sentenceId === damagedId)!;
    expect(componentShape(damagedFirst)).toEqual(goldTokenShape(damagedId));
    expect(
      rounds[0]!.validatorErrors
        .find(({ sentenceId }) => sentenceId === damagedId)!
        .errors.map(({ kind }) => kind),
    ).toEqual(["non-grammar"]);
    expect(
      componentShape(trace.final.analyses.find(({ sentenceId }) => sentenceId === damagedId)!),
    ).not.toEqual(goldTokenShape(damagedId));
    const failedId = trace.inputSentenceIds[3]!;
    expect(
      rounds.every((round) =>
        round.validatorErrors.some(({ sentenceId }) => sentenceId === failedId),
      ),
    ).toBe(true);
    const narrowA = trace.inputSentenceIds[4]!;
    const narrowB = trace.inputSentenceIds[5]!;
    expect(trace.repairs[0]!.subsetSentenceIds).toEqual(expect.arrayContaining([narrowA, narrowB]));
    expect(trace.repairs[1]!.subsetSentenceIds).toContain(narrowB);
    expect(trace.repairs[1]!.subsetSentenceIds).not.toContain(narrowA);
    expect(trace.final.failureSentenceIds).toEqual([failedId]);
  });

  // Task 8 重算 trace 译文占位时,traces[1..6] 的首轮 prompt 顺带从陈旧旧模板
  // 迁到了当前生产模板。这条用例遍历全部 trace 的 firstPass messages,用生产
  // buildCorePrompt + tokenizer snapshot 重建并逐字比对——任何一轨再陈旧都会红,
  // 杜绝「只有 trace0 被回放、其余轨道的 prompt 悄悄过期」。
  it("rebuilds every trace's first-pass prompt from the current production template", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../shared-fixtures/core-evaluation-traces.json", import.meta.url),
        "utf8",
      ),
    ) as {
      tokenizerSnapshot: {
        sentences: Array<{
          id: string;
          text: string;
          tokens: Array<{ id: number; start: number; end: number }>;
        }>;
      };
      traces: Array<{
        inputSentenceIds: string[];
        firstPass: { messages: AnalysisModelWork["messages"] };
      }>;
    };
    expect(fixture.traces.length).toBeGreaterThan(1);
    const byId = new Map(fixture.tokenizerSnapshot.sentences.map((item) => [item.id, item]));
    for (const trace of fixture.traces) {
      const sentences = trace.inputSentenceIds.map((sentenceId) => {
        const item = byId.get(sentenceId)!;
        return { sentenceId, text: item.text, tokens: tokenize(item.text) };
      });
      const expected = trace.firstPass.messages;
      expect(expected).toHaveLength(1);
      expect(expected[0]!.role).toBe("user");
      expect(expected[0]!.content).toBe(buildCorePrompt(sentences));
    }
  });
});

describe("CachedAnalysisService isolated analysis modes", () => {
  it("supplies a strict nested detail schema to compatible adapters", async () => {
    const focus = { startToken: 1, endToken: 2 };
    const { adapter, service } = harness([rawDetail(focus)]);

    await service.analyzeDetail(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        focus,
      },
      new AbortController().signal,
    );

    const schemaJson = JSON.stringify(adapter.completeJson.mock.calls[0]![2]);
    expect(schemaJson).toContain('"startToken"');
    expect(schemaJson).toContain('"endToken"');
    expect(schemaJson).toContain('"structures"');
    expect(schemaJson).toContain('"grammarPoints"');
    expect(schemaJson).toContain('"explanation"');
  });

  it("includes detail focus in its cache key", async () => {
    const firstFocus = { startToken: 0, endToken: 0 };
    const secondFocus = { startToken: 1, endToken: 2 };
    const { adapter, cache, service } = harness([rawDetail(firstFocus), rawDetail(secondFocus)]);
    const input = {
      profile,
      documentId: "document-1",
      sentence: sentenceOne,
      core: coreAnalysis(sentenceOne),
    };

    await service.analyzeDetail({ ...input, focus: firstFocus }, new AbortController().signal);
    await service.analyzeDetail({ ...input, focus: secondFocus }, new AbortController().signal);

    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
    expect(cache.detail.size).toBe(2);
  });

  it("treats stale detail focus as a miss and stamps the current profile", async () => {
    const focus = { startToken: 1, endToken: 2 };
    const { adapter, cache, service } = harness([rawDetail(focus), rawDetail(focus)]);
    const input = {
      profile,
      documentId: "document-1",
      sentence: sentenceOne,
      core: coreAnalysis(sentenceOne),
      focus,
    };
    await service.analyzeDetail(input, new AbortController().signal);
    const key = cache.detail.keys().next().value;
    if (key === undefined) throw new Error("expected a detail cache entry");
    cache.detail.set(key, {
      ...rawDetail({ startToken: 0, endToken: 0 }),
      modelProfileId: "stale-profile",
    });

    const outcome = await service.analyzeDetail(input, new AbortController().signal);

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.result).toEqual({ ...rawDetail(focus), modelProfileId: profile.id });
    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
  });

  it("rebinds a same-text correction cache hit to the current sentence and profile", async () => {
    const reboundSentence = { ...sentenceOne, sentenceId: "sentence-correction-rebound" };
    const { adapter, cache, scheduler, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);
    const base = {
      profile,
      documentId: "document-1",
      sentence: sentenceOne,
      core: coreAnalysis(sentenceOne),
      pageUrl: "https://reader.example/article",
      sentenceInstanceId: "instance-1",
      feedback: "Treat read as the predicate.",
    };
    await service.reanalyzeWithFeedback(base, new AbortController().signal);
    const key = cache.correction.keys().next().value;
    if (key === undefined) throw new Error("expected a correction cache entry");
    cache.correction.set(key, {
      ...coreAnalysis(sentenceOne),
      modelProfileId: "stale-profile",
    });
    adapter.completeJson.mockClear();
    scheduler.schedule.mockClear();

    const outcome = await service.reanalyzeWithFeedback(
      {
        ...base,
        sentence: reboundSentence,
        core: coreAnalysis(reboundSentence),
      },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ result: coreAnalysis(reboundSentence), cacheHit: true });
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(adapter.completeJson).not.toHaveBeenCalled();
  });

  it("retains feedback and prior verified core in the single correction repair", async () => {
    const invalid = { sentences: [{ ...rawCore(sentenceOne), components: [] }] };
    const { adapter, cache, service } = harness([invalid, { sentences: [rawCore(sentenceOne)] }]);
    const input = {
      profile,
      documentId: "document-1",
      sentence: sentenceOne,
      core: coreAnalysis(sentenceOne),
      pageUrl: "https://reader.example/article",
      sentenceInstanceId: "instance-1",
      feedback: "Treat read as the predicate, not a noun.",
    };

    const repaired = await service.reanalyzeWithFeedback(input, new AbortController().signal);
    const cached = await service.reanalyzeWithFeedback(input, new AbortController().signal);

    expect(repaired).toEqual({ result: coreAnalysis(sentenceOne), cacheHit: false });
    expect(cached).toEqual({ result: coreAnalysis(sentenceOne), cacheHit: true });
    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
    const repairMessages = adapter.completeJson.mock.calls[1]![1] as AnalysisModelWork["messages"];
    expect(repairMessages[0]!.content).toContain(input.feedback);
    expect(repairMessages[0]!.content).toContain("Previously verified core analysis");
    expect(repairMessages[0]!.content).toContain('"modelProfileId":"profile-1"');
    expect(repairMessages[0]!.content).toContain("must be a non-empty array");
    expect(cache.correction.size).toBe(1);
  });

  it("lookupCore returns only cache hits and never touches the scheduler", async () => {
    const { adapter, scheduler, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);
    await service.analyzeCore(coreInput(), new AbortController().signal);
    adapter.completeJson.mockClear();
    scheduler.schedule.mockClear();

    const results = await service.lookupCore([sentenceOne, sentenceTwo]);

    expect(results.map(({ sentenceId }) => sentenceId)).toEqual([sentenceOne.sentenceId]);
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(adapter.completeJson).not.toHaveBeenCalled();
  });

  it("lookupDetail returns undefined on a miss and the analysis on a hit", async () => {
    const focus = { startToken: 1, endToken: 2 };
    const { service } = harness([rawDetail(focus)]);

    await expect(service.lookupDetail({ sentence: sentenceOne, focus })).resolves.toBeUndefined();

    await service.analyzeDetail(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        focus,
      },
      new AbortController().signal,
    );
    const hit = await service.lookupDetail({ sentence: sentenceOne, focus });

    expect(hit?.sentenceId).toBe(sentenceOne.sentenceId);
  });

  it("lookupCore restamps the cached modelProfileId", async () => {
    const { service } = harness([{ sentences: [rawCore(sentenceOne)] }]);
    await service.analyzeCore(coreInput(), new AbortController().signal);

    const results = await service.lookupCore([sentenceOne]);

    expect(results).toEqual([coreAnalysis(sentenceOne, "cached")]);
  });

  it("isolates corrections by page, sentence instance, and feedback in the correction store", async () => {
    const { adapter, cache, service } = harness(
      Array.from({ length: 4 }, () => ({ sentences: [rawCore(sentenceOne)] })),
    );
    const base = {
      profile,
      documentId: "document-1",
      sentence: sentenceOne,
      core: coreAnalysis(sentenceOne),
      pageUrl: "https://reader.example/article",
      sentenceInstanceId: "instance-1",
      feedback: "Treat read as the predicate.",
    };

    const first = await service.reanalyzeWithFeedback(base, new AbortController().signal);
    const hit = await service.reanalyzeWithFeedback(base, new AbortController().signal);
    await service.reanalyzeWithFeedback(
      { ...base, pageUrl: "https://reader.example/other" },
      new AbortController().signal,
    );
    await service.reanalyzeWithFeedback(
      { ...base, sentenceInstanceId: "instance-2" },
      new AbortController().signal,
    );
    await service.reanalyzeWithFeedback(
      { ...base, feedback: "Treat read as a noun." },
      new AbortController().signal,
    );

    expect(first.cacheHit).toBe(false);
    expect(hit.cacheHit).toBe(true);
    expect(adapter.completeJson).toHaveBeenCalledTimes(4);
    expect(cache.correction.size).toBe(4);
    expect(cache.core.size).toBe(0);
    expect(cache.detail.size).toBe(0);
  });
});

describe("analyzeSentenceDetails", () => {
  const core = coreAnalysis(sentenceOne);
  const focuses = core.components.map(({ startToken, endToken }) => ({ startToken, endToken }));

  function detailInput(focus: TokenRange) {
    return {
      profile,
      documentId: "document-1",
      sentence: sentenceOne,
      core,
      focus,
    };
  }

  it("returns all-cached counts without touching the scheduler", async () => {
    const { adapter, scheduler, service } = harness(focuses.map((focus) => rawDetail(focus)));
    for (const focus of focuses) {
      await service.analyzeDetail(detailInput(focus), new AbortController().signal);
    }
    const baseline = scheduler.schedule.mock.calls.length;

    const outcome = await service.analyzeSentenceDetails(
      { profile, documentId: "doc", sentence: sentenceOne, core },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ succeeded: core.components.length, failed: 0 });
    expect(scheduler.schedule.mock.calls.length).toBe(baseline);
    expect(adapter.completeJson).toHaveBeenCalledTimes(focuses.length);
  });

  it("requests only the missing focuses in one call and caches each returned detail", async () => {
    const missingFocuses = focuses.slice(1);
    const { adapter, scheduler, service } = harness([
      rawDetail(focuses[0]!),
      { details: missingFocuses.map((focus) => rawDetail(focus)) },
    ]);
    await service.analyzeDetail(detailInput(focuses[0]!), new AbortController().signal);
    const baseline = scheduler.schedule.mock.calls.length;

    const outcome = await service.analyzeSentenceDetails(
      { profile, documentId: "doc", sentence: sentenceOne, core },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ succeeded: core.components.length, failed: 0 });
    expect(scheduler.schedule.mock.calls.length).toBe(baseline + 1);
    const batchedMessages = adapter.completeJson.mock.calls.at(
      -1,
    )![1] as AnalysisModelWork["messages"];
    const focusSection = batchedMessages[0]!.content.split("Requested focus ranges:").at(-1)!;
    expect(JSON.parse(focusSection)).toEqual(missingFocuses);
    for (const focus of missingFocuses) {
      await expect(service.lookupDetail({ sentence: sentenceOne, focus })).resolves.toMatchObject({
        focus,
      });
    }
  });

  it("repairs the invalid subset once and counts leftovers as failed", async () => {
    const { scheduler, service } = harness([
      { details: [rawDetail(focuses[0]!)] },
      { details: [] },
    ]);
    const baseline = scheduler.schedule.mock.calls.length;

    const outcome = await service.analyzeSentenceDetails(
      { profile, documentId: "doc", sentence: sentenceOne, core },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ succeeded: 1, failed: 1 });
    expect(scheduler.schedule.mock.calls.length).toBe(baseline + 2);
  });
});

describe("multi-sentence repair grouping and narrowing", () => {
  /** 取出 repair prompt 里 `Validation errors:` 与 `Invalid JSON:` 之间的分组。 */
  function errorGroupsOf(prompt: string) {
    const start = prompt.indexOf("Validation errors:");
    const end = prompt.indexOf("Invalid JSON:");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return JSON.parse(prompt.slice(start + "Validation errors:".length, end).trim());
  }

  /** 首部多一个纯标点成分(覆盖句号),其余一个成分回显英文。 */
  function punctuationPlusEcho(sentence: SentenceInput) {
    return [
      {
        startToken: sentence.tokens.at(-1)!.id,
        endToken: sentence.tokens.at(-1)!.id,
        role: "PUNCTUATION",
        translation: "。",
      },
      { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主语" },
      { startToken: 1, endToken: 1, role: "PREDICATE", translation: sentence.text.split(" ")[1] },
    ];
  }

  /** 不带纯标点成分,只有谓语回显。 */
  function echoOnly(sentence: SentenceInput) {
    return [
      { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主语" },
      { startToken: 1, endToken: 1, role: "PREDICATE", translation: sentence.text.split(" ")[1] },
    ];
  }

  it("多失败句 repair:errors 按句分组,已修好的兄弟句不回流", async () => {
    // 第一轮:两句都非法(谓语回显),第一句还带一个纯标点成分。
    const invalidBoth = {
      sentences: [
        { sentenceId: sentenceOne.sentenceId, components: punctuationPlusEcho(sentenceOne) },
        { sentenceId: sentenceTwo.sentenceId, components: echoOnly(sentenceTwo) },
      ],
    };
    // 第二轮:只修好第一句(第二句仍回显)。
    const secondRound = { sentences: [rawCore(sentenceOne)] };
    // 第三轮:两句都合法。
    const thirdRound = { sentences: [rawCore(sentenceOne), rawCore(sentenceTwo)] };
    const { adapter, service } = harness([invalidBoth, secondRound, thirdRound]);

    const outcome = await service.analyzeCore(
      coreInput([sentenceOne, sentenceTwo]),
      new AbortController().signal,
    );

    // completeJson(profile, messages, schema, signal)——messages 是第 2 个参数。
    const repairPrompts = adapter.completeJson.mock.calls
      .map((call) => (call[1] as { content: string }[]).at(-1)!.content)
      .filter((content) => content.includes("Repair only the structure"));
    expect(repairPrompts).toHaveLength(2);

    // 第一轮:两组各自的错误只含本句,路径不带 sentences[i] 前缀。
    const firstGroups = errorGroupsOf(repairPrompts[0]!);
    expect(firstGroups.map((group: { sentenceId: string }) => group.sentenceId)).toEqual([
      sentenceOne.sentenceId,
      sentenceTwo.sentenceId,
    ]);
    for (const group of firstGroups) {
      expect(group.errors.length).toBeGreaterThan(0);
      for (const error of group.errors) {
        expect(error.path.startsWith("sentences[")).toBe(false);
      }
    }

    // 第二轮:只带仍失败的第二句,已修好的第一句不得回流。
    const secondGroups = errorGroupsOf(repairPrompts[1]!);
    expect(secondGroups.map((group: { sentenceId: string }) => group.sentenceId)).toEqual([
      sentenceTwo.sentenceId,
    ]);

    expect(outcome.result).toHaveLength(2);
  });
});

describe("service-built prompts reuse the compact sentence payload", () => {  const focus = { startToken: 1, endToken: 2 };

  it("keeps token offsets out of the correction prompt", async () => {
    const { adapter, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);

    await service.reanalyzeWithFeedback(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        pageUrl: "https://reader.example/article",
        sentenceInstanceId: "instance-1",
        feedback: "Treat read as the predicate.",
      },
      new AbortController().signal,
    );

    const messages = adapter.completeJson.mock.calls[0]![1] as AnalysisModelWork["messages"];
    expect(messages[0]!.content).not.toContain("leadingWhitespace");
    expect(messages[0]!.content).toContain('{"id":0,"text":"Learners"}');
  });

  it("keeps token offsets out of the detail repair prompt", async () => {
    const invalid = { ...rawDetail(focus), explanation: "" };
    const { adapter, service } = harness([invalid, rawDetail(focus)]);

    await service.analyzeDetail(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        focus,
      },
      new AbortController().signal,
    );

    const messages = adapter.completeJson.mock.calls[1]![1] as AnalysisModelWork["messages"];
    expect(messages[0]!.content).not.toContain("leadingWhitespace");
    expect(messages[0]!.content).toContain('{"id":0,"text":"Learners"}');
  });

  it("keeps token offsets out of the sentence-details repair prompt", async () => {
    const { adapter, service } = harness([{ details: [] }, { details: [] }]);

    await service.analyzeSentenceDetails(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
      },
      new AbortController().signal,
    );

    const messages = adapter.completeJson.mock.calls[1]![1] as AnalysisModelWork["messages"];
    expect(messages[0]!.content).not.toContain("leadingWhitespace");
    expect(messages[0]!.content).toContain('{"id":0,"text":"Learners"}');
  });

  // 修复 pass 是最贵的一趟：它把核心结果、校验错误和整份非法 JSON 全带上。
  // 缩进美化在这里翻倍地浪费，而模型只读结构。
  const indented = /\n {2}"/u;

  it("纠错 prompt 回传的核心结果不带缩进", async () => {
    const { adapter, service } = harness([{ sentences: [rawCore(sentenceOne)] }]);

    await service.reanalyzeWithFeedback(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        pageUrl: "https://reader.example/article",
        sentenceInstanceId: "instance-1",
        feedback: "Treat read as the predicate.",
      },
      new AbortController().signal,
    );

    const messages = adapter.completeJson.mock.calls[0]![1] as AnalysisModelWork["messages"];
    expect(messages[0]!.content).not.toMatch(indented);
  });

  it("详解修复 prompt 的核心结果、focus 与非法 JSON 不带缩进", async () => {
    const invalid = { ...rawDetail(focus), explanation: "" };
    const { adapter, service } = harness([invalid, rawDetail(focus)]);

    await service.analyzeDetail(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        focus,
      },
      new AbortController().signal,
    );

    const messages = adapter.completeJson.mock.calls[1]![1] as AnalysisModelWork["messages"];
    expect(messages[0]!.content).not.toMatch(indented);
  });

  it("整句详解修复 prompt 不带缩进", async () => {
    const { adapter, service } = harness([{ details: [] }, { details: [] }]);

    await service.analyzeSentenceDetails(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
      },
      new AbortController().signal,
    );

    const messages = adapter.completeJson.mock.calls[1]![1] as AnalysisModelWork["messages"];
    expect(messages[0]!.content).not.toMatch(indented);
  });

  // DETAIL_PROMPT_VERSION 7:修复轮不再只回传错误,还要带上输出模板与中文角色
  // 词表,否则兼容模式下修复请求等于让模型盲猜 JSON 形状。两个修复 prompt
  // (detail + sentence-details)都要带同一份模板。
  it("carries the output shape and Chinese role glossary into the detail repair prompt", async () => {
    const focus = { startToken: 1, endToken: 2 };
    const invalid = { ...rawDetail(focus), explanation: "" };
    const { adapter, service } = harness([invalid, rawDetail(focus)]);

    await service.analyzeDetail(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        focus,
      },
      new AbortController().signal,
    );

    const messages = adapter.completeJson.mock.calls[1]![1] as AnalysisModelWork["messages"];
    const repair = messages[0]!.content;
    // 输出 shape(与首轮 DETAIL_OUTPUT_SHAPE 同款 JSON 形状行)。
    expect(repair).toContain(
      '{"sentenceId": string, "focus": {"startToken": number, "endToken": number}, "structures"',
    );
    expect(repair).toContain("Output minified JSON on a single line");
    // 中文角色词表:低频角色(表语/同位语/补语/独立成分/片段主体)必须出现在
    // 修复轮词表里,否则修复后 role 词表缩水。
    for (const term of [
      "主语",
      "谓语",
      "宾语",
      "定语",
      "状语",
      "表语",
      "补语",
      "同位语",
      "独立成分",
      "系动词",
      "引导词",
      "连词",
      "片段主体",
    ]) {
      expect(repair, `detail repair 缺少角色词「${term}」`).toContain(term);
    }
  });

  it("carries the output shape and Chinese role glossary into the sentence-details repair prompt", async () => {
    const { adapter, service } = harness([{ details: [] }, { details: [] }]);

    await service.analyzeSentenceDetails(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
      },
      new AbortController().signal,
    );

    const messages = adapter.completeJson.mock.calls[1]![1] as AnalysisModelWork["messages"];
    const repair = messages[0]!.content;
    expect(repair).toContain('{"details": [{"sentenceId": string');
    expect(repair).toContain("Output minified JSON on a single line");
    expect(repair).toContain("片段主体");
    expect(repair).toContain("独立成分");
  });
});

describe("repair requests jump their own priority queue", () => {
  it("marks the core repair as queue-jumping and leaves the first pass unmarked", async () => {
    const { scheduler, service } = harness([
      { sentences: [{ ...rawCore(sentenceOne), components: [] }] },
      { sentences: [rawCore(sentenceOne)] },
    ]);

    await service.analyzeCore(coreInput(), new AbortController().signal);

    const [first, repair] = scheduler.schedule.mock.calls.map(([request]) => request);
    expect(first!.jumpQueue).toBeUndefined();
    expect(repair!.jumpQueue).toBe(true);
    // 优先级不得被抬高，否则 prefetch 的修复会插到可见段落之前。
    expect(repair!.priority).toBe(first!.priority);
  });

  it("marks the sentence-details repair as queue-jumping without changing its priority", async () => {
    const { scheduler, service } = harness([{ details: [] }, { details: [] }]);

    await service.analyzeSentenceDetails(
      {
        profile,
        documentId: "document-1",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
      },
      new AbortController().signal,
    );

    const [first, repair] = scheduler.schedule.mock.calls.map(([request]) => request);
    expect(first!.jumpQueue).toBeUndefined();
    expect(repair!.jumpQueue).toBe(true);
    expect(repair!.priority).toBe("prefetch-detail");
  });
});

describe("blocks larger than one request", () => {
  function numbered(index: number): SentenceInput {
    const text = `Sentence ${index} reads.`;
    return {
      sentenceId: `sentence-${index}`,
      text,
      tokens: [
        { id: 0, text: `Sentence`, start: 0, end: 8, leadingWhitespace: "", punctuation: false },
        {
          id: 1,
          text: String(index),
          start: 9,
          end: 10,
          leadingWhitespace: " ",
          punctuation: false,
        },
        { id: 2, text: "reads", start: 11, end: 16, leadingWhitespace: " ", punctuation: false },
        { id: 3, text: ".", start: 16, end: 17, leadingWhitespace: "", punctuation: true },
      ],
    };
  }

  function rawFor(sentence: SentenceInput) {
    return {
      sentenceId: sentence.sentenceId,
      components: [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "主语" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "谓语" },
      ],
    };
  }

  // 旧行为:整块 7 句作为一个请求，sentenceCount 7 撞上真实调度器的 6 句上限被拒成
  // SENTENCE_TOO_LONG，整段没有译文。这里断言的是分块不变量本身——测试用的假调度器
  // 不带上限，只断言"没失败"是测不出这个 bug 的。
  it("never schedules more sentences per request than the scheduler accepts", async () => {
    const sentences = Array.from({ length: 7 }, (_, index) => numbered(index + 1));
    const { adapter, scheduler, service } = harness([
      { sentences: sentences.slice(0, 6).map(rawFor) },
      { sentences: sentences.slice(6).map(rawFor) },
    ]);

    // 本地端点:串行处理请求，合并成大块才快，用满 6 句上限。
    const local = { ...profile, baseUrl: "http://localhost:11434/v1" };
    const outcome = await service.analyzeCore(
      coreInput(sentences, local),
      new AbortController().signal,
    );

    const counts = scheduler.schedule.mock.calls.map(([request]) => request.sentenceCount);
    expect(counts).toEqual([6, 1]);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_SENTENCES_PER_REQUEST);
    expect(outcome.failures).toEqual([]);
    expect(outcome.result.map(({ sentenceId }) => sentenceId)).toEqual(
      sentences.map(({ sentenceId }) => sentenceId),
    );
    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
  });

  it("repairs only the chunk that failed validation", async () => {
    const sentences = Array.from({ length: 7 }, (_, index) => numbered(index + 1));
    const { adapter, service } = harness([
      // 第一块首句成分为空 → 该块需要修复；第二块一次过。
      {
        sentences: [
          { ...rawFor(sentences[0]!), components: [] },
          ...sentences.slice(1, 6).map(rawFor),
        ],
      },
      { sentences: sentences.slice(6).map(rawFor) },
      { sentences: [rawFor(sentences[0]!)] },
    ]);

    // 本地端点:保持 [6,1] 两块，本用例验证的是分块后的隔离，与批次大小无关。
    const localProfile = { ...profile, baseUrl: "http://localhost:11434/v1" };
    const outcome = await service.analyzeCore(
      coreInput(sentences, localProfile),
      new AbortController().signal,
    );

    expect(outcome.failures).toEqual([]);
    expect(outcome.result).toHaveLength(7);
    // 两块首轮 + 仅第一块的修复 = 3 次，而不是两块都修复的 4 次。
    expect(adapter.completeJson).toHaveBeenCalledTimes(3);
  });

  // 分块引入的新风险:一块失败不能连坐把兄弟块已拿到的译文丢掉。
  it("keeps a successful chunk when a sibling chunk fails", async () => {
    const sentences = Array.from({ length: 7 }, (_, index) => numbered(index + 1));
    const { service } = harness([
      new ModelRequestError("AUTH_FAILED", "bad key", false),
      { sentences: sentences.slice(6).map(rawFor) },
    ]);

    // 本地端点:保持 [6,1] 两块，本用例验证的是分块后的隔离，与批次大小无关。
    const localProfile = { ...profile, baseUrl: "http://localhost:11434/v1" };
    const outcome = await service.analyzeCore(
      coreInput(sentences, localProfile),
      new AbortController().signal,
    );

    expect(outcome.result.map(({ sentenceId }) => sentenceId)).toEqual(["sentence-7"]);
    expect(outcome.failures.map(({ sentenceId }) => sentenceId)).toEqual(
      sentences.slice(0, 6).map(({ sentenceId }) => sentenceId),
    );
    // SW 靠 failures 里的 AUTH_FAILED 暂停 profile，这个码不能在转换中丢掉。
    expect(outcome.failures.every(({ error }) => error.code === "AUTH_FAILED")).toBe(true);
  });

  it("still rejects when every chunk fails so the profile pause path is unchanged", async () => {
    const { service } = harness([new ModelRequestError("AUTH_FAILED", "bad key", false)]);

    await expect(
      service.analyzeCore(coreInput([sentenceOne]), new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
  /**
   * 云端 API 的耗时几乎只由输出 token 决定(实测 TTFT 恒定 ~0.65s、与输入无关),
   * 把多句塞进一条请求等于让输出排成一队串行生成。实测同样 6 句:1 条 6 句 8.0s,
   * 3 条 2 句并发 3.1s。本地模型串行处理请求,取舍相反,仍用大块。
   */
  it("云端端点拆成小块以便并行", async () => {
    const sentences = Array.from({ length: 6 }, (_, index) => numbered(index + 1));
    const { scheduler, service } = harness([
      { sentences: sentences.slice(0, 2).map(rawFor) },
      { sentences: sentences.slice(2, 4).map(rawFor) },
      { sentences: sentences.slice(4).map(rawFor) },
    ]);

    await service.analyzeCore(coreInput(sentences), new AbortController().signal);

    const counts = scheduler.schedule.mock.calls.map(([request]) => request.sentenceCount);
    expect(counts).toEqual([2, 2, 2]);
  });

  it("本地端点保持大块——它串行处理请求，请求数才是杠杆", async () => {
    const sentences = Array.from({ length: 6 }, (_, index) => numbered(index + 1));
    const { scheduler, service } = harness([{ sentences: sentences.map(rawFor) }]);
    const local = { ...profile, baseUrl: "http://127.0.0.1:11434/v1" };

    await service.analyzeCore(coreInput(sentences, local), new AbortController().signal);

    const counts = scheduler.schedule.mock.calls.map(([request]) => request.sentenceCount);
    expect(counts).toEqual([6]);
  });
});

describe("provisional components while a core request streams", () => {
  function streamingHarness(
    emit: (
      onComponent: (streamed: { sentenceId: string; component: Record<string, unknown> }) => void,
    ) => void,
    final: unknown,
  ) {
    const cache = new MemoryCache();
    const completeJson = vi.fn(() => Promise.resolve(final));
    const completeJsonStreaming = vi.fn(
      (
        _profile: ModelProfile,
        _messages: unknown,
        _schema: unknown,
        _signal: AbortSignal,
        onComponent: (streamed: { sentenceId: string; component: Record<string, unknown> }) => void,
      ) => {
        emit(onComponent);
        return Promise.resolve(final);
      },
    );
    const service = new CachedAnalysisService({
      cache,
      adapter: { completeJson, completeJsonStreaming },
      scheduler: new DedupeScheduler(),
      now: () => 42,
    });
    const streamed: Array<[string, number]> = [];
    return {
      service,
      completeJsonStreaming,
      streamed,
      sink: (sentenceId: string, components: readonly { startToken: number }[]) =>
        streamed.push([sentenceId, components.length]),
    };
  }

  const valid = { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主语" };
  const second = { startToken: 1, endToken: 2, role: "PREDICATE", translation: "谓语" };

  it("accumulates accepted components and reports the growing list", async () => {
    const subject = streamingHarness(
      (onComponent) => {
        onComponent({ sentenceId: sentenceOne.sentenceId, component: valid });
        onComponent({ sentenceId: sentenceOne.sentenceId, component: second });
      },
      { sentences: [rawCore(sentenceOne)] },
    );

    await subject.service.analyzeCore(
      { ...coreInput(), onStreamedComponent: subject.sink },
      new AbortController().signal,
    );

    expect(subject.completeJsonStreaming).toHaveBeenCalledTimes(1);
    expect(subject.streamed).toEqual([
      [sentenceOne.sentenceId, 1],
      [sentenceOne.sentenceId, 2],
    ]);
  });

  it("drops components the renderer would reject instead of forwarding raw model output", async () => {
    const subject = streamingHarness(
      (onComponent) => {
        const id = sentenceOne.sentenceId;
        onComponent({ sentenceId: id, component: { ...valid, role: "NOT_A_ROLE" } });
        onComponent({ sentenceId: id, component: { ...valid, endToken: 99 } });
        onComponent({ sentenceId: id, component: valid });
        // 与已接受成分重叠：渲染层要求有序不重叠。
        onComponent({ sentenceId: id, component: { ...second, startToken: 0 } });
        onComponent({ sentenceId: id, component: second });
      },
      { sentences: [rawCore(sentenceOne)] },
    );

    await subject.service.analyzeCore(
      { ...coreInput(), onStreamedComponent: subject.sink },
      new AbortController().signal,
    );

    // 只有第 3、5 个成分合格，且是累积上报。
    expect(subject.streamed).toEqual([
      [sentenceOne.sentenceId, 1],
      [sentenceOne.sentenceId, 2],
    ]);
  });

  it("never forwards punctuation-only components to the renderer", async () => {
    const subject = streamingHarness(
      (onComponent) => {
        onComponent({
          sentenceId: sentenceOne.sentenceId,
          component: { startToken: 2, endToken: 2, role: "CONJUNCTION", translation: "。" },
        });
      },
      { sentences: [rawCore(sentenceOne)] },
    );

    await subject.service.analyzeCore(
      { ...coreInput(), onStreamedComponent: subject.sink },
      new AbortController().signal,
    );

    expect(subject.streamed).toEqual([]);
  });

  it("stays on the buffered path when no sink is supplied", async () => {
    const subject = streamingHarness(() => undefined, { sentences: [rawCore(sentenceOne)] });

    await subject.service.analyzeCore(coreInput(), new AbortController().signal);

    expect(subject.completeJsonStreaming).not.toHaveBeenCalled();
  });
});

describe("详解流式:边生成边上报结构", () => {
  function streamingDetailHarness(
    emit: (onStructure: (s: Record<string, unknown>) => void) => void,
    final: unknown,
  ) {
    const cache = new MemoryCache();
    const completeJson = vi.fn(() => Promise.resolve(final));
    const completeDetailStreaming = vi.fn(
      (
        _p: ModelProfile,
        _m: unknown,
        _s: unknown,
        _sig: AbortSignal,
        onStructure: (s: Record<string, unknown>) => void,
      ) => {
        emit(onStructure);
        return Promise.resolve(final);
      },
    );
    const streamed: number[] = [];
    return {
      completeDetailStreaming,
      streamed,
      service: new CachedAnalysisService({
        cache,
        adapter: { completeJson, completeDetailStreaming },
        scheduler: new DedupeScheduler(),
        now: () => 42,
      }),
      sink: (_id: string, _f: TokenRange, structures: readonly unknown[]) =>
        streamed.push(structures.length),
    };
  }

  const focus = { startToken: 1, endToken: 2 };
  const good = { startToken: 1, endToken: 2, role: "谓语", explanation: "承担谓语" };

  it("累积上报已完成的结构", async () => {
    const h = streamingDetailHarness((on) => {
      on({ ...good, endToken: 1 });
      on({ ...good, startToken: 2, endToken: 2, role: "宾语" });
    }, rawDetail(focus));

    await h.service.analyzeDetail(
      {
        profile,
        documentId: "d",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        focus,
        onStreamedStructure: h.sink,
      },
      new AbortController().signal,
    );

    expect(h.completeDetailStreaming).toHaveBeenCalledTimes(1);
    expect(h.streamed).toEqual([1, 2]);
  });

  it("丢掉渲染层画不出来的结构", async () => {
    const h = streamingDetailHarness((on) => {
      on({ ...good, endToken: 99 }); // 越界
      on({ ...good, explanation: "" }); // 空解释
      on(good); // 合格
    }, rawDetail(focus));

    await h.service.analyzeDetail(
      {
        profile,
        documentId: "d",
        sentence: sentenceOne,
        core: coreAnalysis(sentenceOne),
        focus,
        onStreamedStructure: h.sink,
      },
      new AbortController().signal,
    );

    expect(h.streamed).toEqual([1]);
  });

  it("没有 sink 时保持整段返回路径", async () => {
    const h = streamingDetailHarness(() => undefined, rawDetail(focus));

    await h.service.analyzeDetail(
      { profile, documentId: "d", sentence: sentenceOne, core: coreAnalysis(sentenceOne), focus },
      new AbortController().signal,
    );

    expect(h.completeDetailStreaming).not.toHaveBeenCalled();
  });
});

describe("本地修掉纯标点成分，省掉一次修复往返", () => {
  // 实测触发的真实失败:模型把逗号单独切成一个成分。覆盖率规则允许标点不被覆盖，
  // 所以丢掉它就合法了——为此多跑一次模型（本地实测 6-23 秒）不值当。
  it("丢掉纯标点成分后首轮即通过，不再发修复请求", async () => {
    const punctuationOnly = {
      sentenceId: sentenceOne.sentenceId,
      components: [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主语" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "谓语" },
        { startToken: 2, endToken: 2, role: "ADVERBIAL", translation: "。" },
      ],
    };
    const { adapter, service } = harness([{ sentences: [punctuationOnly] }]);

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome.failures).toEqual([]);
    expect(outcome.result).toHaveLength(1);
    expect(outcome.result[0]!.components).toHaveLength(2);
    // 关键:只发了一次请求，没有触发修复 pass
    expect(adapter.completeJson).toHaveBeenCalledTimes(1);
  });

  it("不动含实词的成分，即使它带着标点", async () => {
    const withTrailingPunctuation = {
      sentenceId: sentenceOne.sentenceId,
      components: [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主语" },
        { startToken: 1, endToken: 2, role: "PREDICATE", translation: "谓语" },
      ],
    };
    const { adapter, service } = harness([{ sentences: [withTrailingPunctuation] }]);

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome.result[0]!.components).toHaveLength(2);
    expect(adapter.completeJson).toHaveBeenCalledTimes(1);
  });

  it("丢掉后仍不合格的照常走修复", async () => {
    const stillBroken = {
      sentenceId: sentenceOne.sentenceId,
      // 丢掉纯标点成分后，实词 token 1 没有被任何成分覆盖
      components: [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主语" },
        { startToken: 2, endToken: 2, role: "ADVERBIAL", translation: "。" },
      ],
    };
    const { adapter, service } = harness([
      { sentences: [stillBroken] },
      { sentences: [rawCore(sentenceOne)] },
    ]);

    await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
  });
});

describe("英文回显译文被拒并走修复", () => {
  function rawEchoCore(sentence: SentenceInput) {
    return {
      sentenceId: sentence.sentenceId,
      components: [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "Learners" },
        { startToken: 1, endToken: 2, role: "PREDICATE", translation: "read." },
      ],
    };
  }

  it("首轮回显触发修复，修复 prompt 带精确错误，只缓存修好的中文", async () => {
    const { adapter, cache, service } = harness([
      { sentences: [rawEchoCore(sentenceOne)] },
      { sentences: [rawCore(sentenceOne)] },
    ]);

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome).toMatchObject({ result: [coreAnalysis(sentenceOne)], failures: [] });
    expect(adapter.completeJson).toHaveBeenCalledTimes(2);
    const repairWork = adapter.completeJson.mock.calls[1] as [
      ModelProfile,
      AnalysisModelWork["messages"],
    ];
    expect(repairWork[1][0]!.content).toContain(
      "translation must include a meaningful Chinese gloss for the complete covered English span instead of echoing or only copying it",
    );
    expect(cache.core.size).toBe(1);
    const cached = cache.core.get(cache.core.keys().next().value!);
    expect(cached).toEqual(coreAnalysis(sentenceOne));
  });

  it("当前 key 下的回显缓存视为 miss 并重新请求", async () => {
    const { adapter, cache, service } = harness([
      { sentences: [rawCore(sentenceOne)] },
      { sentences: [rawCore(sentenceOne)] },
    ]);
    await service.analyzeCore(coreInput(), new AbortController().signal);
    const key = cache.core.keys().next().value;
    if (key === undefined) throw new Error("expected a core cache entry");
    cache.core.set(key, {
      schemaVersion: CORE_SCHEMA_VERSION,
      sentenceId: sentenceOne.sentenceId,
      components: [
        { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "Learners" },
        { startToken: 1, endToken: 2, role: GrammarRole.PREDICATE, translation: "read." },
      ],
      modelProfileId: "stale-profile",
    });
    adapter.completeJson.mockClear();

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.result).toEqual([coreAnalysis(sentenceOne)]);
    expect(adapter.completeJson).toHaveBeenCalledTimes(1);
    expect(cache.core.size).toBe(1);
  });

  it("两轮回显修复后仍失败且不缓存，不加第三轮", async () => {
    const echo = { sentences: [rawEchoCore(sentenceOne)] };
    const { adapter, cache, service } = harness([echo, echo, echo]);

    const outcome = await service.analyzeCore(coreInput(), new AbortController().signal);

    expect(outcome.result).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]!.sentenceId).toBe(sentenceOne.sentenceId);
    expect(outcome.failures[0]!.error).toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(adapter.completeJson).toHaveBeenCalledTimes(3);
    expect(cache.core.size).toBe(0);
  });
});
