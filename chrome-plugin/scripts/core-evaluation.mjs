import { createHash } from "node:crypto";

import { parseRunnerBaseUrl } from "./core-evaluation-runner.mjs";

const ARTIFACT_SCHEMA_VERSION = "core-evaluation-trace/v1";
const GRAMMAR_ROLES = new Set([
  "SUBJECT",
  "PREDICATE",
  "OBJECT",
  "PREDICATIVE",
  "ATTRIBUTE",
  "ADVERBIAL",
  "COMPLEMENT",
  "APPOSITIVE",
  "INDEPENDENT_ELEMENT",
  "CONJUNCTION",
  "SUBJECT_CLAUSE",
  "OBJECT_CLAUSE",
  "PREDICATIVE_CLAUSE",
  "ATTRIBUTIVE_CLAUSE",
  "ADVERBIAL_CLAUSE",
  "COORDINATE_CLAUSE",
  "FRAGMENT_HEAD",
]);

const sha256Text = (value) => createHash("sha256").update(value).digest("hex");
const sha256Json = (value) => sha256Text(JSON.stringify(value));
const ALLOWED_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid ${ARTIFACT_SCHEMA_VERSION}: ${message}`);
}

function requireUniqueStrings(values, label) {
  requireValue(Array.isArray(values) && values.every((value) => typeof value === "string"), label);
  requireValue(new Set(values).size === values.length, `${label} must be unique`);
}

function classifyProductionValidationError(error) {
  return {
    ...error,
    kind: /unknown fields|translation|sentenceId|must be an object|must be an array/iu.test(
      error.message,
    )
      ? "non-grammar"
      : "grammar",
  };
}

export function productionValidationErrorsFor(raw, inputs, modelProfileId, validateCoreBatch) {
  const rawSentences =
    raw && typeof raw === "object" && Array.isArray(raw.sentences) ? raw.sentences : [];
  const rejections = [];
  for (const input of inputs) {
    const matching = rawSentences.filter(
      (candidate) =>
        candidate && typeof candidate === "object" && candidate.sentenceId === input.sentenceId,
    );
    const result = validateCoreBatch({ sentences: matching }, [input], modelProfileId);
    if (!result.ok) {
      rejections.push({
        sentenceId: input.sentenceId,
        errors: result.errors.map(classifyProductionValidationError),
      });
    }
  }
  return rejections;
}

function validateRawAdaptation(round, expectedRound, subsetSentenceIds) {
  const hasProductionRaw = Object.hasOwn(round, "productionRaw");
  const hasAdaptation = Object.hasOwn(round, "traceRawAdaptation");
  requireValue(
    hasProductionRaw === hasAdaptation,
    `round ${expectedRound} productionRaw and traceRawAdaptation must occur together`,
  );
  if (!hasAdaptation) return;

  const adaptation = round.traceRawAdaptation;
  requireValue(
    adaptation && adaptation.kind === "pad-missing-sentence-ids",
    `round ${expectedRound} traceRawAdaptation kind`,
  );
  requireUniqueStrings(
    adaptation.sentenceIds,
    `round ${expectedRound} traceRawAdaptation sentenceIds`,
  );
  requireValue(
    adaptation.sentenceIds.length > 0,
    `round ${expectedRound} traceRawAdaptation sentenceIds must not be empty`,
  );
  requireValue(
    round.productionRaw &&
      typeof round.productionRaw === "object" &&
      Object.keys(round.productionRaw).length === 1 &&
      Array.isArray(round.productionRaw.sentences),
    `round ${expectedRound} productionRaw shape`,
  );
  const productionIds = round.productionRaw.sentences.map(normalizedSentenceId);
  requireUniqueStrings(productionIds, `round ${expectedRound} productionRaw sentence IDs`);
  requireValue(
    productionIds.every((id) => subsetSentenceIds.includes(id)),
    `round ${expectedRound} productionRaw sentence IDs must belong to subset`,
  );
  const exactMissingIds = subsetSentenceIds.filter((id) => !productionIds.includes(id));
  requireValue(
    JSON.stringify(adaptation.sentenceIds) === JSON.stringify(exactMissingIds),
    `round ${expectedRound} adaptation sentence IDs must exactly match productionRaw omissions`,
  );
  const expectedRaw = {
    sentences: [
      ...round.productionRaw.sentences,
      ...exactMissingIds.map((sentenceId) => ({ sentenceId, components: [] })),
    ],
  };
  requireValue(
    JSON.stringify(round.raw) === JSON.stringify(expectedRaw),
    `round ${expectedRound} raw must be the exact empty-components padding of productionRaw`,
  );
  for (const sentenceId of exactMissingIds) {
    const rejection = round.validatorErrors.find((item) => item.sentenceId === sentenceId);
    requireValue(
      JSON.stringify(rejection?.errors) ===
        JSON.stringify([
          {
            path: "sentences",
            message: `requested sentence ${sentenceId} is missing`,
            kind: "grammar",
          },
        ]),
      `round ${expectedRound} missing-sentence validatorErrors must match production diagnostics`,
    );
  }
}

function rawRoundIds(raw, expectedRound, subsetSentenceIds) {
  requireValue(raw && typeof raw === "object", `round ${expectedRound} raw`);
  if (raw.malformedWholeRound === true) {
    requireValue(
      Object.keys(raw).length === 2 && Object.hasOwn(raw, "value"),
      `round ${expectedRound} malformed whole-round raw shape`,
    );
    return subsetSentenceIds;
  }
  requireValue(Array.isArray(raw.sentences), `round ${expectedRound} raw sentences`);
  const ids = raw.sentences.map(normalizedSentenceId);
  requireUniqueStrings(ids, `round ${expectedRound} raw sentence IDs`);
  return ids;
}

function validateRound(round, inputIds, expectedRound, validationContext) {
  requireValue(round && typeof round === "object", `round ${expectedRound}`);
  if (expectedRound > 0)
    requireValue(round.round === expectedRound, `repair round ${expectedRound}`);
  requireUniqueStrings(round.subsetSentenceIds, `round ${expectedRound} subsetSentenceIds`);
  requireValue(
    round.subsetSentenceIds.length > 0,
    `round ${expectedRound} subset must not be empty`,
  );
  requireValue(
    round.subsetSentenceIds.every((id) => inputIds.has(id)),
    `round ${expectedRound} subset must belong to its trace`,
  );
  requireValue(
    Array.isArray(round.messages) && round.messages.length > 0,
    `round ${expectedRound} messages`,
  );
  for (const message of round.messages) {
    requireValue(
      message &&
        ALLOWED_MESSAGE_ROLES.has(message.role) &&
        typeof message.content === "string" &&
        message.content.length > 0,
      `round ${expectedRound} message role/content`,
    );
  }
  const serializedSubset = round.serializedSubset;
  requireValue(
    typeof serializedSubset === "string" && serializedSubset.length > 0,
    `round ${expectedRound} serializedSubset`,
  );
  requireValue(
    round.messages.some(({ content }) => content.includes(serializedSubset)),
    `round ${expectedRound} messages must encode serialized subset`,
  );
  const serializedIds = round.subsetSentenceIds.map(
    (sentenceId) => '"sentenceId":"' + sentenceId + '"',
  );
  requireValue(
    serializedIds.every((encodedId) => serializedSubset.includes(encodedId)),
    `round ${expectedRound} serialized subset must include every subset sentence`,
  );
  const inputIdsInSerializedSubset = [...inputIds].filter((sentenceId) =>
    serializedSubset.includes('"sentenceId":"' + sentenceId + '"'),
  );
  requireValue(
    JSON.stringify(inputIdsInSerializedSubset) === JSON.stringify(round.subsetSentenceIds),
    `round ${expectedRound} serialized subset sentence IDs must exactly match subset`,
  );
  requireValue(
    JSON.stringify(rawRoundIds(round.raw, expectedRound, round.subsetSentenceIds)) ===
      JSON.stringify(round.subsetSentenceIds),
    `round ${expectedRound} raw sentence IDs must exactly match subset`,
  );
  requireValue(Array.isArray(round.validatorErrors), `round ${expectedRound} validatorErrors`);
  validateRawAdaptation(round, expectedRound, round.subsetSentenceIds);
  requireUniqueStrings(
    round.validatorErrors.map(({ sentenceId }) => sentenceId),
    `round ${expectedRound} validator error sentence IDs`,
  );
  if (validationContext?.validateCoreBatch && round.raw.malformedWholeRound !== true) {
    const subsetInputs = round.subsetSentenceIds.map((sentenceId) => {
      const input = validationContext.inputById.get(sentenceId);
      requireValue(input !== undefined, `round ${expectedRound} validator input ${sentenceId}`);
      return input;
    });
    const expectedErrors = productionValidationErrorsFor(
      round.productionRaw ?? round.raw,
      subsetInputs,
      validationContext.modelProfileId,
      validationContext.validateCoreBatch,
    );
    requireValue(
      JSON.stringify(round.validatorErrors) === JSON.stringify(expectedErrors),
      `round ${expectedRound} validatorErrors must exactly match production diagnostics`,
    );
  }
  for (const rejection of round.validatorErrors) {
    requireValue(
      round.subsetSentenceIds.includes(rejection.sentenceId),
      `round ${expectedRound} validator error sentenceId must belong to subset`,
    );
    requireValue(
      Array.isArray(rejection.errors) && rejection.errors.length > 0,
      "validator errors",
    );
    for (const error of rejection.errors) {
      requireValue(
        typeof error.path === "string" && typeof error.message === "string",
        "validator error",
      );
      requireValue(
        error.kind === "grammar" || error.kind === "non-grammar",
        "validator error kind",
      );
    }
  }
  return new Set(round.validatorErrors.map(({ sentenceId }) => sentenceId));
}

export function validateCoreEvaluationCorpusV1(corpus) {
  requireValue(corpus && typeof corpus.id === "string" && corpus.id.trim().length > 0, "corpus id");
  requireValue(Number.isInteger(corpus.version) && corpus.version > 0, "corpus version");
  requireUniqueStrings(corpus.denominatorSentenceIds, "corpus denominatorSentenceIds");
  requireValue(Array.isArray(corpus.sentences) && corpus.sentences.length > 0, "corpus sentences");
  const corpusIds = corpus.sentences.map(({ id }) => id);
  requireUniqueStrings(corpusIds, "corpus sentence IDs");
  requireValue(
    JSON.stringify(corpus.denominatorSentenceIds) === JSON.stringify(corpusIds),
    "corpus denominator must exactly match sentence order",
  );
  for (const sentence of corpus.sentences) {
    requireValue(
      [
        sentence.id,
        sentence.text,
        sentence.split,
        sentence.category,
        sentence.source,
        sentence.annotationRationale,
      ].every((value) => typeof value === "string" && value.trim().length > 0),
      `corpus sentence metadata ${sentence.id}`,
    );
    if (sentence.sourceEvidence !== undefined) {
      const evidence = sentence.sourceEvidence;
      requireValue(
        evidence &&
          typeof evidence.verifiedAt === "string" &&
          /^\d{4}-\d{2}-\d{2}$/u.test(evidence.verifiedAt) &&
          evidence.exactExcerpt === sentence.text &&
          evidence.contentHash === sha256Text(evidence.exactExcerpt),
        `source evidence ${sentence.id}`,
      );
    }
    requireValue(
      Array.isArray(sentence.boundaries) && sentence.boundaries.length > 0,
      `boundaries ${sentence.id}`,
    );
    let previousEnd = -1;
    for (const boundary of sentence.boundaries) {
      requireValue(
        Number.isInteger(boundary.startChar) &&
          Number.isInteger(boundary.endChar) &&
          boundary.startChar >= 0 &&
          boundary.endChar > boundary.startChar &&
          boundary.endChar <= sentence.text.length &&
          boundary.startChar >= previousEnd,
        `boundary range ${sentence.id}`,
      );
      requireValue(GRAMMAR_ROLES.has(boundary.role), `boundary role ${sentence.id}`);
      previousEnd = boundary.endChar;
    }
  }
  return corpus;
}

export function validateCoreEvaluationArtifactV1(artifact, options = {}) {
  requireValue(artifact?.schemaVersion === ARTIFACT_SCHEMA_VERSION, "schemaVersion");
  requireValue(typeof artifact.synthetic === "boolean", "synthetic");
  const corpus = validateCoreEvaluationCorpusV1(artifact.corpus);
  const snapshot = artifact.tokenizerSnapshot;
  requireValue(
    snapshot && typeof snapshot.id === "string" && typeof snapshot.version === "string",
    "tokenizer snapshot",
  );
  requireValue(/^[a-f0-9]{64}$/u.test(snapshot.hash), "tokenizer SHA-256 hash");
  requireValue(
    Array.isArray(snapshot.sentences) && snapshot.sentences.length > 0,
    "tokenizer sentences",
  );
  const tokenizerIds = snapshot.sentences.map(({ id, sentenceId }) => id ?? sentenceId);
  requireUniqueStrings(tokenizerIds, "tokenizer sentence IDs");
  const corpusById = new Map(corpus.sentences.map((sentence) => [sentence.id, sentence]));
  for (const tokenizerSentence of snapshot.sentences) {
    const sentenceId = tokenizerSentence.id ?? tokenizerSentence.sentenceId;
    const corpusSentence = corpusById.get(sentenceId);
    requireValue(corpusSentence !== undefined, `tokenizer corpus sentence ${sentenceId}`);
    requireValue(
      typeof tokenizerSentence.text === "string" && tokenizerSentence.text === corpusSentence.text,
      `tokenizer text must match corpus ${sentenceId}`,
    );
    requireValue(
      tokenizerSentence.textHash === sha256Text(tokenizerSentence.text),
      `tokenizer textHash ${sentenceId}`,
    );
    requireValue(
      Array.isArray(tokenizerSentence.tokens) && tokenizerSentence.tokens.length > 0,
      `tokenizer tokens ${sentenceId}`,
    );
    const tokenIds = tokenizerSentence.tokens.map(({ id }) => id);
    requireValue(tokenIds.every(Number.isInteger), `token IDs ${sentenceId}`);
    requireValue(
      new Set(tokenIds).size === tokenIds.length,
      `token IDs must be unique ${sentenceId}`,
    );
    let previousTokenEnd = -1;
    const tokenStarts = new Set();
    const tokenEnds = new Set();
    for (const token of tokenizerSentence.tokens) {
      requireValue(
        Number.isInteger(token.start) &&
          Number.isInteger(token.end) &&
          token.start >= 0 &&
          token.end > token.start &&
          token.end <= tokenizerSentence.text.length &&
          token.start >= previousTokenEnd,
        `token range ${sentenceId}`,
      );
      requireValue(
        token.text === tokenizerSentence.text.slice(token.start, token.end),
        `token text slice ${sentenceId}`,
      );
      tokenStarts.add(token.start);
      tokenEnds.add(token.end);
      previousTokenEnd = token.end;
    }
    for (const boundary of corpusSentence.boundaries) {
      requireValue(
        tokenStarts.has(boundary.startChar) && tokenEnds.has(boundary.endChar),
        `gold boundary must map to token endpoints ${sentenceId}`,
      );
    }
  }
  requireValue(artifact.run && ["first-pass", "pipeline"].includes(artifact.run.mode), "run mode");
  requireValue(
    [artifact.run.createdAt, artifact.run.commit, artifact.run.model].every(
      (value) => typeof value === "string" && value.length > 0,
    ) &&
      artifact.run.parameters &&
      typeof artifact.run.parameters === "object" &&
      Number.isInteger(artifact.run.batchSize) &&
      artifact.run.batchSize > 0,
    "run metadata",
  );
  requireUniqueStrings(artifact.run.sentenceOrder, "run sentenceOrder");
  requireValue(
    ["prompt", "corpus", "tokenizer", "messages"].every(
      (key) =>
        typeof artifact.run.hashes?.[key] === "string" &&
        /^[a-f0-9]{64}$/u.test(artifact.run.hashes[key]),
    ),
    "run hashes",
  );
  requireValue(Array.isArray(artifact.traces) && artifact.traces.length > 0, "traces");
  const validationContext = options.validateCoreBatch
    ? {
        validateCoreBatch: options.validateCoreBatch,
        modelProfileId: options.modelProfileId ?? "core-evaluation",
        inputById: new Map(
          snapshot.sentences.map(({ id, sentenceId, text, tokens }) => {
            const normalizedId = id ?? sentenceId;
            return [normalizedId, { sentenceId: normalizedId, text, tokens }];
          }),
        ),
      }
    : undefined;
  const traceIds = new Set();
  const coveredTraceIds = [];
  for (const trace of artifact.traces) {
    requireValue(
      typeof trace.callId === "string" && !traceIds.has(trace.callId),
      "unique trace callId",
    );
    traceIds.add(trace.callId);
    requireUniqueStrings(trace.inputSentenceIds, "trace inputSentenceIds");
    coveredTraceIds.push(...trace.inputSentenceIds);
    const inputIds = new Set(trace.inputSentenceIds);
    let priorFailedIds = validateRound(trace.firstPass, inputIds, 0, validationContext);
    requireValue(
      JSON.stringify(trace.firstPass.subsetSentenceIds) === JSON.stringify(trace.inputSentenceIds),
      "first-pass subset must equal trace input",
    );
    requireValue(Array.isArray(trace.repairs) && trace.repairs.length <= 2, "repairs");
    trace.repairs.forEach((round, index) => {
      requireValue(
        round.subsetSentenceIds.every((id) => priorFailedIds.has(id)) &&
          round.subsetSentenceIds.length === priorFailedIds.size,
        `repair round ${index + 1} subset must exactly equal immediately prior failed set`,
      );
      priorFailedIds = validateRound(round, inputIds, index + 1, validationContext);
    });
    requireValue(
      trace.final && ["success", "partial", "failure"].includes(trace.final.status),
      "final status",
    );
    requireUniqueStrings(trace.final.successSentenceIds, "final successSentenceIds");
    requireUniqueStrings(trace.final.failureSentenceIds, "final failureSentenceIds");
    const finalIds = [...trace.final.successSentenceIds, ...trace.final.failureSentenceIds];
    requireValue(
      finalIds.length === trace.inputSentenceIds.length &&
        new Set(finalIds).size === finalIds.length &&
        trace.inputSentenceIds.every((id) => finalIds.includes(id)),
      "final success/failure IDs must partition trace input",
    );
    const expectedStatus =
      trace.final.failureSentenceIds.length === 0
        ? "success"
        : trace.final.successSentenceIds.length === 0
          ? "failure"
          : "partial";
    requireValue(trace.final.status === expectedStatus, "final status must match partition");
    requireValue(
      Array.isArray(trace.final.analyses) && Array.isArray(trace.final.failures),
      "final outcome",
    );
    requireValue(
      JSON.stringify(trace.final.analyses.map(normalizedSentenceId)) ===
        JSON.stringify(trace.final.successSentenceIds) &&
        JSON.stringify(trace.final.failures.map(normalizedSentenceId)) ===
          JSON.stringify(trace.final.failureSentenceIds),
      "final analyses/failures must match final sentence IDs",
    );
    requireValue(
      JSON.stringify(trace.final.failureSentenceIds) ===
        JSON.stringify(trace.inputSentenceIds.filter((id) => priorFailedIds.has(id))),
      "final failure partition must match the last validator result",
    );
  }
  const allMessages = artifact.traces.flatMap(({ firstPass, repairs }) => [
    firstPass.messages,
    ...repairs.map(({ messages }) => messages),
  ]);
  requireValue(snapshot.hash === sha256Json(snapshot.sentences), "tokenizer hash content");
  requireValue(artifact.run.hashes.corpus === sha256Json(corpus), "corpus hash content");
  requireValue(
    artifact.run.hashes.tokenizer === sha256Json(snapshot.sentences),
    "run tokenizer hash content",
  );
  requireValue(artifact.run.hashes.messages === sha256Json(allMessages), "messages hash content");
  requireValue(
    artifact.run.hashes.prompt === sha256Json(allMessages.flat().map(({ content }) => content)),
    "prompt hash content",
  );
  requireValue(
    JSON.stringify(tokenizerIds) === JSON.stringify(corpus.denominatorSentenceIds),
    "tokenizer IDs must exactly match corpus denominator",
  );
  requireValue(
    JSON.stringify(coveredTraceIds) === JSON.stringify(corpus.denominatorSentenceIds),
    "trace sentence IDs must cover corpus exactly once in denominator order",
  );
  requireValue(
    JSON.stringify(artifact.run.sentenceOrder) === JSON.stringify(corpus.denominatorSentenceIds),
    "run sentenceOrder must exactly match corpus denominator",
  );
  const expectedReport = reportSnapshot(scoreArtifact(artifact));
  requireValue(
    JSON.stringify(artifact.report) === JSON.stringify(expectedReport),
    "report must exactly match deterministic scorer output",
  );
  return artifact;
}

function artifactScoringInput(artifact) {
  const snapshotById = new Map(
    artifact.tokenizerSnapshot.sentences.map(({ id, sentenceId, text, tokens }) => [
      id ?? sentenceId,
      { text, tokens },
    ]),
  );
  const attachTokens = (sentences) =>
    sentences.map((sentence) => ({
      ...sentence,
      sentenceId: normalizedSentenceId(sentence),
      text: sentence.text ?? snapshotById.get(normalizedSentenceId(sentence))?.text,
      tokens: snapshotById.get(normalizedSentenceId(sentence))?.tokens,
      components: sentence.components ?? sentence.boundaries,
    }));
  const first = artifact.traces.flatMap(
    ({ firstPass }) => firstPass.predictions ?? firstPass.raw?.sentences ?? [],
  );
  const final = artifact.traces.flatMap(({ final: outcome }) => outcome.analyses ?? []);
  const failures = artifact.traces.flatMap(
    ({ final: outcome }) => outcome.failureSentenceIds ?? [],
  );
  return {
    gold: attachTokens(artifact.corpus.sentences),
    first: attachTokens(first),
    final: attachTokens(final),
    failures,
  };
}

export function scoreCoreEvaluationArtifact(artifact) {
  return scoreArtifact(artifact);
}

export function createCoreEvaluationReportV1(artifact) {
  return reportSnapshot(scoreArtifact(artifact));
}

function reportSnapshot(report) {
  const scoreSnapshot = (score) => ({
    sentences: [score.sentenceCount, score.missingSentenceCount, score.extraSentenceCount],
    exactSentence: [score.exactSentence.count, score.exactSentence.rate],
    spanExact: [
      score.spanExact.truePositive,
      score.spanExact.predicted,
      score.spanExact.gold,
      score.spanExact.precision,
      score.spanExact.recall,
      score.spanExact.f1,
    ],
    labeledSpan: [
      score.labeledSpan.truePositive,
      score.labeledSpan.predicted,
      score.labeledSpan.gold,
      score.labeledSpan.precision,
      score.labeledSpan.recall,
      score.labeledSpan.f1,
    ],
    roleAccuracyOnExactSpans: [
      score.roleAccuracyOnExactSpans.correct,
      score.roleAccuracyOnExactSpans.matched,
      score.roleAccuracyOnExactSpans.accuracy,
    ],
  });
  const groupSnapshot = (groups) =>
    Object.fromEntries(
      Object.entries(groups).map(([key, group]) => [
        key,
        group.status === "N/A"
          ? group
          : {
              denominator: group.denominator,
              firstPass: scoreSnapshot(group.firstPass),
              final: scoreSnapshot(group.final),
              transitions: group.transitions,
              correctFirstPassRejection: group.correctFirstPassRejection,
            },
      ]),
    );
  return {
    denominator: report.denominator,
    firstPass: scoreSnapshot(report.firstPass),
    final: scoreSnapshot(report.final),
    transitions: report.transitions,
    correctFirstPassRejection: report.correctFirstPassRejection,
    bySplit: groupSnapshot(report.bySplit),
    byCategory: groupSnapshot(report.byCategory),
  };
}

function scoreArtifact(artifact) {
  const { gold, first, final, failures } = artifactScoringInput(artifact);
  const options = {
    coordinateSystem: "characters",
    corpusMetadata: artifact.corpus.sentences,
    splits: [...new Set(artifact.corpus.sentences.map(({ split }) => split))],
    categories: [...new Set(artifact.corpus.sentences.map(({ category }) => category))],
  };
  const trace = {
    denominatorSentenceIds: artifact.corpus.denominatorSentenceIds,
    firstPass: {
      predictions: first,
      validatorErrors: artifact.traces.flatMap(({ firstPass }) => firstPass.validatorErrors ?? []),
    },
    final: { predictions: final, failureSentenceIds: failures },
  };
  return scorePipelineTrace(gold, trace, options);
}

function validateComparisonConfig(config, run) {
  requireValue(config && typeof config === "object", "run comparisonConfig");
  const parsedEndpoint = parseRunnerBaseUrl(config.endpoint);
  requireValue(parsedEndpoint.safeBaseUrl === config.endpoint, "run comparisonConfig endpoint");
  requireValue(
    typeof config.model === "string" && config.model.length > 0,
    "run comparisonConfig model",
  );
  requireValue(config.mode === "pipeline", "run comparisonConfig mode must be pipeline");
  requireValue(
    Number.isInteger(config.batchSize) && config.batchSize > 0,
    "run comparisonConfig batchSize",
  );
  requireValue(
    typeof config.temperature === "number" && Number.isFinite(config.temperature),
    "run comparisonConfig temperature",
  );
  for (const [label, value] of [
    ["reasoning", config.reasoning],
    ["responseFormat", config.responseFormat],
  ]) {
    requireValue(
      value &&
        typeof value.requested === "string" &&
        value.requested.length > 0 &&
        typeof value.effective === "string" &&
        value.effective.length > 0 &&
        typeof value.fallback === "boolean",
      `run comparisonConfig ${label}`,
    );
  }
  requireValue(
    config.timeout &&
      typeof config.timeout.strategy === "string" &&
      config.timeout.strategy.length > 0 &&
      Number.isInteger(config.timeout.valueMs) &&
      config.timeout.valueMs > 0,
    "run comparisonConfig timeout",
  );
  requireValue(config.model === run.model, "run comparisonConfig model consistency");
  requireValue(config.mode === run.mode, "run comparisonConfig mode consistency");
  requireValue(config.batchSize === run.batchSize, "run comparisonConfig batchSize consistency");
  requireValue(
    config.temperature === run.parameters.temperature,
    "run comparisonConfig temperature consistency",
  );
  return config;
}

export function validateComparableCoreEvaluationArtifactsV1(
  baselineArtifact,
  candidateArtifact,
  options = {},
) {
  validateCoreEvaluationArtifactV1(baselineArtifact, options);
  validateCoreEvaluationArtifactV1(candidateArtifact, options);
  requireValue(
    baselineArtifact.run.mode === "pipeline" && candidateArtifact.run.mode === "pipeline",
    "comparable artifacts must use pipeline mode",
  );
  requireValue(
    JSON.stringify(baselineArtifact.corpus) === JSON.stringify(candidateArtifact.corpus),
    "baseline and candidate corpus snapshots must match",
  );
  requireValue(
    JSON.stringify(baselineArtifact.run.sentenceOrder) ===
      JSON.stringify(candidateArtifact.run.sentenceOrder),
    "baseline and candidate sentenceOrder must match",
  );
  const baselineConfig = validateComparisonConfig(
    baselineArtifact.run.comparisonConfig,
    baselineArtifact.run,
  );
  const candidateConfig = validateComparisonConfig(
    candidateArtifact.run.comparisonConfig,
    candidateArtifact.run,
  );
  requireValue(
    JSON.stringify(baselineConfig) === JSON.stringify(candidateConfig),
    "baseline and candidate comparisonConfig must match",
  );
  return { baseline: baselineArtifact, candidate: candidateArtifact };
}

export function scoreCoreEvaluationArtifacts(baselineArtifact, candidateArtifact, options = {}) {
  validateCoreEvaluationArtifactV1(baselineArtifact, options);
  validateCoreEvaluationArtifactV1(candidateArtifact, options);
  requireValue(
    JSON.stringify(baselineArtifact.corpus) === JSON.stringify(candidateArtifact.corpus),
    "baseline and candidate corpus snapshots must match",
  );
  return { baseline: scoreArtifact(baselineArtifact), candidate: scoreArtifact(candidateArtifact) };
}

function metricSummary(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    mean: min === max ? min : values.reduce((sum, value) => sum + value, 0) / values.length,
    min,
    max,
  };
}

export function scoreCoreEvaluationArtifactPairs(pairs, options = {}) {
  if (!Array.isArray(pairs) || pairs.length !== 3) {
    throw new Error("Core evaluation comparison requires exactly three pairs");
  }
  const reference = pairs[0]?.baseline;
  const scoredPairs = pairs.map(({ baseline, candidate }, index) => {
    validateComparableCoreEvaluationArtifactsV1(baseline, candidate, options);
    if (index > 0) {
      requireValue(
        JSON.stringify(baseline.run.sentenceOrder) === JSON.stringify(reference.run.sentenceOrder),
        "artifact pairs sentenceOrder must match",
      );
      requireValue(
        JSON.stringify(baseline.corpus) === JSON.stringify(reference.corpus),
        "artifact pairs corpus snapshots must match",
      );
      requireValue(
        JSON.stringify(baseline.run.comparisonConfig) ===
          JSON.stringify(reference.run.comparisonConfig),
        "artifact pairs comparisonConfig must match",
      );
    }
    const scores = scoreCoreEvaluationArtifacts(baseline, candidate, options);
    return {
      pair: index + 1,
      baseline: scores.baseline,
      candidate: scores.candidate,
      transitions: {
        baseline: scores.baseline.transitions,
        candidate: scores.candidate.transitions,
      },
    };
  });
  const aggregateSide = (side) => ({
    finalExact: metricSummary(scoredPairs.map((pair) => pair[side].final.exactSentence.rate)),
    labeledSpanF1: metricSummary(scoredPairs.map((pair) => pair[side].final.labeledSpan.f1)),
    finalFailures: metricSummary(
      scoredPairs.map((pair) => pair[side].transitions.finalFailures.count),
    ),
  });
  return {
    pairs: scoredPairs,
    aggregate: { baseline: aggregateSide("baseline"), candidate: aggregateSide("candidate") },
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function metric(truePositive, predicted, gold) {
  const precision = ratio(truePositive, predicted);
  const recall = ratio(truePositive, gold);
  return {
    truePositive,
    predicted,
    gold,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function boundaryKey(component) {
  const start = component.startChar ?? component.startToken;
  const end = component.endChar ?? component.endToken;
  return `${start}:${end}`;
}

function characterComponent(component, tokenIndex, sentenceId, sentenceText) {
  if (Number.isInteger(component.startChar) && Number.isInteger(component.endChar)) {
    if (
      component.startChar < 0 ||
      component.endChar <= component.startChar ||
      typeof sentenceText !== "string" ||
      component.endChar > sentenceText.length
    ) {
      throw new Error(`Invalid character span for ${sentenceId}`);
    }
    return component;
  }
  if (!Number.isInteger(component.startToken) || !Number.isInteger(component.endToken)) {
    throw new Error(`Missing token span for ${sentenceId}`);
  }
  if (component.endToken < component.startToken) {
    throw new Error(`Inverted token span for ${sentenceId}`);
  }
  const start = tokenIndex.get(component.startToken);
  const end = tokenIndex.get(component.endToken);
  if (start === undefined || end === undefined) {
    throw new Error(`Unmappable token span for ${sentenceId}`);
  }
  if (
    !Number.isInteger(start.start) ||
    !Number.isInteger(start.end) ||
    !Number.isInteger(end.start) ||
    !Number.isInteger(end.end) ||
    start.start < 0 ||
    start.end <= start.start ||
    end.end <= end.start ||
    end.end <= start.start
  ) {
    throw new Error(`Invalid token character mapping for ${sentenceId}`);
  }
  return { ...component, startChar: start.start, endChar: end.end };
}

function normalizedCoordinates(sentences, coordinateSystem) {
  if (coordinateSystem !== "characters") return sentences ?? [];
  return (sentences ?? []).map((sentence) => {
    const sentenceId = normalizedSentenceId(sentence);
    const tokenIndex = new Map();
    for (const token of sentence.tokens ?? []) {
      if (tokenIndex.has(token.id)) throw new Error(`Duplicate token ID for ${sentenceId}`);
      tokenIndex.set(token.id, token);
    }
    return {
      ...sentence,
      components: (sentence.components ?? []).map((component) =>
        characterComponent(component, tokenIndex, sentenceId, sentence.text),
      ),
    };
  });
}

function labeledKey(component) {
  return `${boundaryKey(component)}:${component.role}`;
}

function normalizedSentenceId(sentence) {
  return sentence?.sentenceId ?? sentence?.id;
}

function consumeMatches(gold, predicted, keyOf) {
  const available = new Map();
  for (const component of gold) {
    const key = keyOf(component);
    const queue = available.get(key) ?? [];
    queue.push(component);
    available.set(key, queue);
  }

  let count = 0;
  for (const component of predicted) {
    const queue = available.get(keyOf(component));
    if (queue?.length) {
      queue.shift();
      count += 1;
    }
  }
  return count;
}

function componentsEqualInOrder(gold, predicted) {
  return (
    gold.length === predicted.length &&
    gold.every(
      (component, index) =>
        boundaryKey(component) === boundaryKey(predicted[index] ?? {}) &&
        component.role === predicted[index]?.role,
    )
  );
}

function sentenceDetails(sentenceId, gold, predicted, status = "matched-sentence") {
  const remainingGold = [...gold];
  const missing = [];
  const extra = [];
  const roleErrors = [];

  for (const prediction of predicted) {
    const labeledIndex = remainingGold.findIndex(
      (expected) => labeledKey(expected) === labeledKey(prediction),
    );
    if (labeledIndex >= 0) {
      remainingGold.splice(labeledIndex, 1);
      continue;
    }

    const boundaryIndex = remainingGold.findIndex(
      (expected) => boundaryKey(expected) === boundaryKey(prediction),
    );
    if (boundaryIndex >= 0) {
      const expected = remainingGold.splice(boundaryIndex, 1)[0];
      roleErrors.push({
        startToken: prediction.startToken,
        endToken: prediction.endToken,
        expectedRole: expected.role,
        predictedRole: prediction.role,
      });
      continue;
    }

    extra.push(prediction);
  }
  missing.push(...remainingGold);

  return {
    sentenceId,
    status,
    exact: status === "matched-sentence" && componentsEqualInOrder(gold, predicted),
    missing,
    extra,
    roleErrors,
  };
}

function indexSentences(sentences) {
  const indexed = new Map();
  const duplicates = [];
  for (const sentence of sentences ?? []) {
    const sentenceId = normalizedSentenceId(sentence);
    if (indexed.has(sentenceId)) {
      duplicates.push(sentence);
    } else {
      indexed.set(sentenceId, sentence);
    }
  }
  return { indexed, duplicates };
}

export function scoreCorePredictions(goldSentences, predictedSentences, options = {}) {
  const gold = normalizedCoordinates(goldSentences, options.coordinateSystem);
  const predicted = normalizedCoordinates(predictedSentences, options.coordinateSystem);
  const goldIndex = indexSentences(gold).indexed;
  const predictionIndex = indexSentences(predicted);
  const details = [];
  let exactCount = 0;
  let spanMatches = 0;
  let labeledMatches = 0;
  let roleCorrect = 0;
  let roleMatched = 0;
  let goldSpanCount = 0;
  let predictedSpanCount = 0;
  let missingSentenceCount = 0;
  let extraSentenceCount = 0;

  for (const goldSentence of gold) {
    const sentenceId = normalizedSentenceId(goldSentence);
    const goldComponents = goldSentence.components ?? [];
    const prediction = predictionIndex.indexed.get(sentenceId);
    const predictedComponents = prediction?.components ?? [];
    goldSpanCount += goldComponents.length;

    if (!prediction) {
      missingSentenceCount += 1;
      details.push(sentenceDetails(sentenceId, goldComponents, [], "missing-sentence"));
      continue;
    }

    predictedSpanCount += predictedComponents.length;
    spanMatches += consumeMatches(goldComponents, predictedComponents, boundaryKey);
    labeledMatches += consumeMatches(goldComponents, predictedComponents, labeledKey);
    const detail = sentenceDetails(sentenceId, goldComponents, predictedComponents);
    roleMatched += spanMatchesForSentence(goldComponents, predictedComponents);
    roleCorrect += consumeMatches(goldComponents, predictedComponents, labeledKey);
    if (detail.exact) exactCount += 1;
    details.push(detail);
  }

  const firstPredictionById = new Set();
  for (const prediction of predicted) {
    const sentenceId = normalizedSentenceId(prediction);
    const duplicate = firstPredictionById.has(sentenceId);
    firstPredictionById.add(sentenceId);
    if (!goldIndex.has(sentenceId) || duplicate) {
      const components = prediction.components ?? [];
      predictedSpanCount += components.length;
      extraSentenceCount += 1;
      details.push(
        sentenceDetails(
          sentenceId,
          [],
          components,
          duplicate ? "duplicate-sentence" : "extra-sentence",
        ),
      );
    }
  }

  return {
    sentenceCount: gold.length,
    missingSentenceCount,
    extraSentenceCount,
    exactSentence: { count: exactCount, rate: ratio(exactCount, gold.length) },
    spanExact: metric(spanMatches, predictedSpanCount, goldSpanCount),
    labeledSpan: metric(labeledMatches, predictedSpanCount, goldSpanCount),
    roleAccuracyOnExactSpans: {
      correct: roleCorrect,
      matched: roleMatched,
      accuracy: ratio(roleCorrect, roleMatched),
    },
    details,
  };
}

function spanMatchesForSentence(gold, predicted) {
  return consumeMatches(gold, predicted, boundaryKey);
}

function exactIds(report) {
  return new Set(report.details.filter(({ exact }) => exact).map(({ sentenceId }) => sentenceId));
}

function transition(sentenceIds) {
  return { count: sentenceIds.length, sentenceIds };
}

function requireFixedDenominator(goldSentences, denominatorIds) {
  const goldIds = goldSentences.map(normalizedSentenceId);
  if (new Set(goldIds).size !== goldIds.length) throw new Error("Gold sentence IDs must be unique");
  if (new Set(denominatorIds).size !== denominatorIds.length) {
    throw new Error("Denominator sentence IDs must be unique");
  }
  const goldSet = new Set(goldIds);
  const denominatorSet = new Set(denominatorIds);
  if (denominatorIds.some((id) => !goldSet.has(id))) {
    throw new Error("Denominator contains an unknown sentence ID");
  }
  if (goldIds.some((id) => !denominatorSet.has(id))) {
    throw new Error("Denominator is missing a gold sentence ID");
  }
  return denominatorIds.map((id) => goldSentences[goldIds.indexOf(id)]);
}

function scorePipelineSubset(goldSentences, trace, options) {
  const ids = new Set(goldSentences.map(normalizedSentenceId));
  const subset = (sentences) =>
    (sentences ?? []).filter((item) => ids.has(normalizedSentenceId(item)));
  return scorePipelineTrace(
    goldSentences,
    {
      ...trace,
      denominatorSentenceIds: goldSentences.map(normalizedSentenceId),
      firstPass: { ...trace.firstPass, predictions: subset(trace.firstPass.predictions) },
      final: {
        ...trace.final,
        predictions: subset(trace.final.predictions),
        failureSentenceIds: (trace.final.failureSentenceIds ?? []).filter((id) => ids.has(id)),
      },
    },
    { ...options, corpusMetadata: undefined },
  );
}

export function scorePipelineTrace(goldSentences, trace, options = {}) {
  const denominatorIds = trace.denominatorSentenceIds ?? goldSentences.map(normalizedSentenceId);
  const fixedGold = requireFixedDenominator(goldSentences, denominatorIds);
  const firstPass = scoreCorePredictions(fixedGold, trace.firstPass.predictions, options);
  const final = scoreCorePredictions(fixedGold, trace.final.predictions, options);
  const firstExact = exactIds(firstPass);
  const finalExact = exactIds(final);
  const rejected = new Set(
    (trace.firstPass.validatorErrors ?? []).map(({ sentenceId }) => sentenceId),
  );
  const rejectedExact = denominatorIds.filter((id) => firstExact.has(id) && rejected.has(id));
  const errorKinds = new Map(
    (trace.firstPass.validatorErrors ?? []).map(({ sentenceId, kinds, errors = [] }) => [
      sentenceId,
      kinds ?? [...new Set(errors.map(({ kind }) => kind).filter(Boolean))],
    ]),
  );
  const denominator = firstExact.size;

  const groups = (field, declaredValues) =>
    Object.fromEntries(
      (
        declaredValues ?? [...new Set((options.corpusMetadata ?? []).map((item) => item[field]))]
      ).map((value) => {
        const groupIds = new Set(
          (options.corpusMetadata ?? [])
            .filter((item) => item[field] === value)
            .map(({ id, sentenceId }) => id ?? sentenceId),
        );
        const groupGold = fixedGold.filter((sentence) =>
          groupIds.has(normalizedSentenceId(sentence)),
        );
        return [
          value,
          groupGold.length === 0
            ? { denominator: 0, status: "N/A" }
            : scorePipelineSubset(groupGold, trace, options),
        ];
      }),
    );

  return {
    denominator: fixedGold.length,
    firstPass,
    final,
    transitions: {
      repairedToCorrect: transition(
        denominatorIds.filter((id) => !firstExact.has(id) && finalExact.has(id)),
      ),
      correctToWrongOrFailure: transition(
        denominatorIds.filter((id) => firstExact.has(id) && !finalExact.has(id)),
      ),
      finalFailures: transition(
        denominatorIds.filter((id) => trace.final.failureSentenceIds?.includes(id)),
      ),
    },
    correctFirstPassRejection: {
      numerator: rejectedExact.length,
      denominator,
      rate: denominator === 0 ? null : rejectedExact.length / denominator,
      displayRate:
        denominator === 0 ? "N/A" : `${((rejectedExact.length / denominator) * 100).toFixed(2)}%`,
      grammarSentenceIds: rejectedExact.filter((id) => errorKinds.get(id)?.includes("grammar")),
      nonGrammarSentenceIds: rejectedExact.filter((id) =>
        errorKinds.get(id)?.includes("non-grammar"),
      ),
    },
    bySplit: groups("split", options.splits),
    byCategory: groups("category", options.categories),
  };
}

export function formatPipelineTransition(report) {
  const rejection = report.correctFirstPassRejection;
  return [
    `Correct first-pass rejection: ${rejection.displayRate}`,
    `Wrong to correct: ${report.transitions.repairedToCorrect.count}`,
    `Correct to wrong/failure: ${report.transitions.correctToWrongOrFailure.count}`,
    `Final failures: ${report.transitions.finalFailures.count}`,
  ].join("\n");
}

export function formatCoreEvaluation(report) {
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  return [
    `Sentences: ${report.sentenceCount} (missing ${report.missingSentenceCount}, extra ${report.extraSentenceCount})`,
    `Exact sentence: ${report.exactSentence.count}/${report.sentenceCount} (${percent(report.exactSentence.rate)})`,
    `Span exact P/R/F1: ${percent(report.spanExact.precision)} / ${percent(report.spanExact.recall)} / ${percent(report.spanExact.f1)}`,
    `Labeled span P/R/F1: ${percent(report.labeledSpan.precision)} / ${percent(report.labeledSpan.recall)} / ${percent(report.labeledSpan.f1)}`,
    `Role accuracy on exact spans: ${report.roleAccuracyOnExactSpans.correct}/${report.roleAccuracyOnExactSpans.matched} (${percent(report.roleAccuracyOnExactSpans.accuracy)})`,
  ].join("\n");
}
