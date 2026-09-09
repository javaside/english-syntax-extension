import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import { tokenize } from "../src/language/segmenter.ts";
import {
  formatPipelineTransition,
  scoreCorePredictions,
  scorePipelineTrace,
  createCoreEvaluationReportV1,
  scoreCoreEvaluationArtifactPairs,
  scoreCoreEvaluationArtifacts,
  validateComparableCoreEvaluationArtifactsV1,
  validateCoreEvaluationArtifactV1,
  validateCoreEvaluationCorpusV1,
} from "./core-evaluation.mjs";

const component = (startToken, endToken, role) => ({ startToken, endToken, role });
const sentence = (sentenceId, components) => ({ sentenceId, components });
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const fixtureUrl = new URL("../../shared-fixtures/core-evaluation-traces.json", import.meta.url);
const pageCorpusUrl = new URL(
  "../../shared-fixtures/visible-page-core-evaluation-corpus.json",
  import.meta.url,
);
const loadArtifact = () => JSON.parse(readFileSync(fixtureUrl, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256Json = (value) => sha256(JSON.stringify(value));
const refreshArtifactHashes = (artifact) => {
  const allMessages = artifact.traces.flatMap(({ firstPass, repairs }) => [
    firstPass.messages,
    ...repairs.map(({ messages }) => messages),
  ]);
  artifact.tokenizerSnapshot.hash = sha256Json(artifact.tokenizerSnapshot.sentences);
  artifact.run.hashes.corpus = sha256Json(artifact.corpus);
  artifact.run.hashes.tokenizer = artifact.tokenizerSnapshot.hash;
  artifact.run.hashes.messages = sha256Json(allMessages);
  artifact.run.hashes.prompt = sha256Json(allMessages.flat().map(({ content }) => content));
};
const refreshArtifactReport = (artifact) => {
  artifact.report = createCoreEvaluationReportV1(artifact);
};

describe("visible page core evaluation corpus v1", () => {
  const loadPageCorpus = () => JSON.parse(readFileSync(pageCorpusUrl, "utf8"));

  it("freezes the complete ordered denominator and character-boundary metadata", () => {
    const corpus = loadPageCorpus();

    expect(corpus).toMatchObject({
      schemaVersion: "core-evaluation-corpus/v1",
      id: "visible-english-pages-spring-ai-arxiv",
      version: 1,
    });
    expect(validateCoreEvaluationCorpusV1(corpus)).toBe(corpus);
    expect(corpus.denominatorSentenceIds).toEqual(corpus.sentences.map(({ id }) => id));
    expect(new Set(corpus.denominatorSentenceIds).size).toBe(corpus.sentences.length);
    expect(
      corpus.sentences.every(
        ({ source, annotationRationale }) => source.trim() && annotationRationale.trim(),
      ),
    ).toBe(true);
    for (const item of corpus.sentences) {
      const tokens = tokenize(item.text);
      const tokenStarts = new Set(tokens.map(({ start }) => start));
      const tokenEnds = new Set(tokens.map(({ end }) => end));
      for (const boundary of item.boundaries) {
        expect(item.text.slice(boundary.startChar, boundary.endChar).trim()).not.toBe("");
        expect(tokenStarts.has(boundary.startChar), `${item.id} start ${boundary.startChar}`).toBe(
          true,
        );
        expect(tokenEnds.has(boundary.endChar), `${item.id} end ${boundary.endChar}`).toBe(true);
      }
    }
  });

  it("pins every manually reviewed sentence ID, source class, and role sequence", () => {
    const corpus = loadPageCorpus();
    const expected = {
      "spring-features-lead": ["spring-ai", "SUBJECT", "PREDICATE", "OBJECT"],
      "spring-portable-api-fragment": ["spring-ai", "FRAGMENT_HEAD", "ATTRIBUTE"],
      "spring-fragment-relative": ["spring-ai", "FRAGMENT_HEAD", "ATTRIBUTE", "ATTRIBUTIVE_CLAUSE"],
      "full-relative-counterexample": [
        "controlled-contrast",
        "SUBJECT",
        "ATTRIBUTIVE_CLAUSE",
        "PREDICATE",
        "PREDICATIVE",
      ],
      "arxiv-dark-siren-title": ["arxiv", "FRAGMENT_HEAD", "ATTRIBUTE", "APPOSITIVE", "ATTRIBUTE"],
      "colon-complete-clause-counterexample": [
        "controlled-contrast",
        "SUBJECT",
        "PREDICATE",
        "PREDICATIVE",
        "SUBJECT",
        "PREDICATE",
        "OBJECT",
      ],
      "finite-when-clause": ["spring-ai", "SUBJECT", "PREDICATE", "ADVERBIAL_CLAUSE"],
      "nonfinite-when-phrase": ["spring-ai", "SUBJECT", "PREDICATE", "ADVERBIAL"],
      "finite-before-clause": [
        "controlled-contrast",
        "SUBJECT",
        "PREDICATE",
        "OBJECT",
        "ADVERBIAL_CLAUSE",
      ],
      "nonfinite-before-phrase": [
        "controlled-contrast",
        "SUBJECT",
        "PREDICATE",
        "OBJECT",
        "ADVERBIAL",
      ],
      "spring-vp-coordination": [
        "spring-ai",
        "SUBJECT",
        "PREDICATE",
        "OBJECT",
        "ATTRIBUTE",
        "CONJUNCTION",
        "PREDICATE",
        "OBJECT",
      ],
      "spring-np-coordination": [
        "spring-ai",
        "SUBJECT",
        "ATTRIBUTE",
        "PREDICATE",
        "ADVERBIAL",
        "ADVERBIAL_CLAUSE",
      ],
      "spring-object-control": [
        "spring-ai",
        "SUBJECT",
        "PREDICATE",
        "OBJECT",
        "COMPLEMENT",
        "ADVERBIAL",
        "ADVERBIAL",
      ],
      "spring-zero-relative": [
        "spring-ai",
        "SUBJECT",
        "PREDICATE",
        "OBJECT",
        "SUBJECT",
        "PREDICATE",
        "COMPLEMENT",
        "ADVERBIAL",
        "CONJUNCTION",
        "SUBJECT",
        "PREDICATE",
        "OBJECT",
        "ADVERBIAL",
        "ATTRIBUTIVE_CLAUSE",
      ],
      "spring-noun-pp": ["controlled-contrast", "SUBJECT", "ATTRIBUTE", "PREDICATE", "OBJECT"],
      "spring-verb-nested-pp": ["spring-ai", "SUBJECT", "PREDICATE", "ADVERBIAL", "ADVERBIAL"],
      "arxiv-figure-caption": ["arxiv", "FRAGMENT_HEAD", "ATTRIBUTE", "ATTRIBUTE"],
      "arxiv-table-definition": ["arxiv", "FRAGMENT_HEAD", "ATTRIBUTE"],
      "arxiv-inline-h0": ["arxiv", "ADVERBIAL", "SUBJECT", "ATTRIBUTE", "PREDICATE", "PREDICATIVE"],
      "arxiv-short-heading": ["arxiv", "FRAGMENT_HEAD"],
    };

    expect(Object.keys(expected)).toEqual(corpus.denominatorSentenceIds);
    expect(
      Object.fromEntries(
        corpus.sentences.map(({ id, split, boundaries }) => [
          id,
          [split, ...boundaries.map(({ role }) => role)],
        ]),
      ),
    ).toEqual(expected);
  });

  it("pins the arXiv title as four manually reviewed half-open spans", () => {
    const corpus = loadPageCorpus();
    const title = corpus.sentences.find(({ id }) => id === "arxiv-dark-siren-title");

    expect(title?.text).toBe(
      "Expanding the scope of dark siren cosmology: Inferring the population properties of gravitational wave-hosting galaxies",
    );
    expect(title?.boundaries).toEqual([
      { startChar: 0, endChar: 19, role: "FRAGMENT_HEAD" },
      { startChar: 20, endChar: 43, role: "ATTRIBUTE" },
      { startChar: 45, endChar: 80, role: "APPOSITIVE" },
      { startChar: 81, endChar: 119, role: "ATTRIBUTE" },
    ]);
  });
});

describe("core evaluation corpus validation", () => {
  const pageTargetCorpus = () => ({
    id: "page-target",
    version: 1,
    denominatorSentenceIds: ["page-1", "page-2"],
    sentences: [
      {
        id: "page-1",
        text: "English is visible.",
        split: "page-target",
        category: "prose",
        source: "page fixture",
        annotationRationale: "Simple clause coverage.",
        boundaries: [
          { startChar: 0, endChar: 7, role: "SUBJECT" },
          { startChar: 8, endChar: 10, role: "PREDICATE" },
          { startChar: 11, endChar: 18, role: "PREDICATIVE" },
        ],
      },
      {
        id: "page-2",
        text: "Read the guide.",
        split: "page-target",
        category: "instruction",
        source: "page fixture",
        annotationRationale: "Imperative coverage.",
        boundaries: [
          { startChar: 0, endChar: 4, role: "PREDICATE" },
          { startChar: 5, endChar: 14, role: "OBJECT" },
        ],
      },
    ],
  });

  it("accepts a two-sentence page-target corpus without the legacy matrix", () => {
    const corpus = pageTargetCorpus();

    expect(validateCoreEvaluationCorpusV1(corpus)).toBe(corpus);
  });

  it.each([
    [
      "duplicate sentence IDs",
      (corpus) => {
        corpus.sentences[1].id = corpus.sentences[0].id;
      },
      /corpus sentence IDs.*unique/iu,
    ],
    [
      "denominator order differences",
      (corpus) => {
        corpus.denominatorSentenceIds.reverse();
      },
      /denominator.*sentence order/iu,
    ],
    [
      "an empty source",
      (corpus) => {
        corpus.sentences[0].source = " ";
      },
      /metadata/iu,
    ],
    [
      "an empty rationale",
      (corpus) => {
        corpus.sentences[0].annotationRationale = "";
      },
      /metadata/iu,
    ],
    [
      "overlapping boundaries",
      (corpus) => {
        corpus.sentences[0].boundaries[1].startChar = 6;
      },
      /boundary range/iu,
    ],
  ])("rejects %s", (_label, mutate, expectedError) => {
    const corpus = pageTargetCorpus();
    mutate(corpus);

    expect(() => validateCoreEvaluationCorpusV1(corpus)).toThrow(expectedError);
  });
});

describe("core-evaluation-trace/v1 contract", () => {
  it("validates the shared synthetic artifact and its complete 40-sentence corpus", () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL("../../shared-fixtures/core-evaluation-traces.json", import.meta.url),
        "utf8",
      ),
    );

    expect(() => validateCoreEvaluationArtifactV1(artifact)).not.toThrow();
    expect(artifact.corpus.sentences).toHaveLength(40);
    expect(artifact.corpus.denominatorSentenceIds).toEqual(
      artifact.corpus.sentences.map(({ id }) => id),
    );
    expect(artifact.corpus.sentences.every(({ boundaries }) => boundaries.length > 0)).toBe(true);
    expect(artifact.tokenizerSnapshot.sentences.map(({ id }) => id)).toEqual(
      artifact.corpus.denominatorSentenceIds,
    );
    expect(artifact.traces.flatMap(({ inputSentenceIds }) => inputSentenceIds)).toEqual(
      artifact.corpus.denominatorSentenceIds,
    );
    expect(artifact).not.toHaveProperty("serviceReplay");
    expect(artifact).not.toHaveProperty("artifactTemplate");
    expect(
      Object.fromEntries(
        ["rule-regression", "independent-holdout"].map((split) => [
          split,
          Object.fromEntries(
            [
              "fragment",
              "clause",
              "object-complement",
              "prepositional-attachment",
              "coordination",
            ].map((category) => [
              category,
              artifact.corpus.sentences.filter(
                (sentence) => sentence.split === split && sentence.category === category,
              ).length,
            ]),
          ),
        ]),
      ),
    ).toEqual({
      "rule-regression": {
        fragment: 4,
        clause: 4,
        "object-complement": 4,
        "prepositional-attachment": 4,
        coordination: 4,
      },
      "independent-holdout": {
        fragment: 4,
        clause: 4,
        "object-complement": 4,
        "prepositional-attachment": 4,
        coordination: 4,
      },
    });
  });

  it("rejects duplicate trace coverage and inconsistent final partitions", () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL("../../shared-fixtures/core-evaluation-traces.json", import.meta.url),
        "utf8",
      ),
    );
    const duplicateTraceCoverage = cloneJson(artifact);
    duplicateTraceCoverage.traces[0].inputSentenceIds.push(
      duplicateTraceCoverage.traces[0].inputSentenceIds[0],
    );
    const missingFinalSentence = cloneJson(artifact);
    missingFinalSentence.traces[0].final.successSentenceIds.pop();

    expect(() => validateCoreEvaluationArtifactV1(duplicateTraceCoverage)).toThrow(
      /trace.*(?:unique|exactly once)/iu,
    );
    expect(() => validateCoreEvaluationArtifactV1(missingFinalSentence)).toThrow(
      /final.*partition/iu,
    );
  });

  it("pins the two Task 21 character-span rulings", () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL("../../shared-fixtures/core-evaluation-traces.json", import.meta.url),
        "utf8",
      ),
    );
    const byId = new Map(artifact.corpus.sentences.map((item) => [item.id, item.boundaries]));

    expect(byId.get("rr-complement-1")).toEqual([
      { startChar: 0, endChar: 10, role: "SUBJECT" },
      { startChar: 11, endChar: 16, role: "PREDICATE" },
      { startChar: 17, endChar: 27, role: "OBJECT" },
      { startChar: 28, endChar: 39, role: "COMPLEMENT" },
    ]);
    expect(byId.get("ho-clause-1")).toEqual([
      { startChar: 0, endChar: 2, role: "SUBJECT" },
      { startChar: 3, endChar: 5, role: "PREDICATE" },
      { startChar: 6, endChar: 13, role: "PREDICATIVE" },
      { startChar: 14, endChar: 37, role: "SUBJECT_CLAUSE" },
    ]);
  });

  it("proves the synthetic legal, repaired, damaged, failed, and narrowing semantics", () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL("../../shared-fixtures/core-evaluation-traces.json", import.meta.url),
        "utf8",
      ),
    );
    const report = scoreCoreEvaluationArtifacts(artifact, artifact).candidate;
    const firstTrace = artifact.traces[0];

    expect(firstTrace.repairs.map(({ subsetSentenceIds }) => subsetSentenceIds)).toEqual([
      firstTrace.inputSentenceIds.slice(1),
      [firstTrace.inputSentenceIds[3], firstTrace.inputSentenceIds[5]],
    ]);
    expect(report.transitions.repairedToCorrect.sentenceIds).toEqual([
      firstTrace.inputSentenceIds[1],
      firstTrace.inputSentenceIds[4],
      firstTrace.inputSentenceIds[5],
    ]);
    expect(report.transitions.correctToWrongOrFailure.sentenceIds).toEqual([
      firstTrace.inputSentenceIds[2],
    ]);
    expect(report.transitions.finalFailures.sentenceIds).toEqual([firstTrace.inputSentenceIds[3]]);
    expect(report.correctFirstPassRejection.nonGrammarSentenceIds).toEqual([
      firstTrace.inputSentenceIds[2],
    ]);
  });

  it("requires classified grammar and non-grammar validator errors", () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL("../../shared-fixtures/core-evaluation-traces.json", import.meta.url),
        "utf8",
      ),
    );
    const errors = artifact.traces.flatMap(({ firstPass, repairs }) => [
      ...firstPass.validatorErrors,
      ...repairs.flatMap((round) => round.validatorErrors),
    ]);

    expect(errors.some(({ errors: items }) => items.some(({ kind }) => kind === "grammar"))).toBe(
      true,
    );
    expect(
      errors.some(({ errors: items }) => items.some(({ kind }) => kind === "non-grammar")),
    ).toBe(true);
  });

  it.each([
    [
      "tokenizer text differs from corpus",
      (artifact) => {
        artifact.tokenizerSnapshot.sentences[0].text += " altered";
      },
    ],
    [
      "textHash is not SHA-256 text",
      (artifact) => {
        artifact.tokenizerSnapshot.sentences[0].textHash = "0".repeat(64);
      },
    ],
    [
      "token IDs are duplicated",
      (artifact) => {
        artifact.tokenizerSnapshot.sentences[0].tokens[1].id =
          artifact.tokenizerSnapshot.sentences[0].tokens[0].id;
      },
    ],
    [
      "token ranges overlap",
      (artifact) => {
        artifact.tokenizerSnapshot.sentences[0].tokens[1].start = 7;
      },
    ],
    [
      "token range exceeds sentence",
      (artifact) => {
        artifact.tokenizerSnapshot.sentences[0].tokens.at(-1).end = 999;
      },
    ],
    [
      "token text differs from source slice",
      (artifact) => {
        artifact.tokenizerSnapshot.sentences[0].tokens[0].text = "Wrong";
      },
    ],
    [
      "gold boundary is not a token endpoint",
      (artifact) => {
        artifact.corpus.sentences[0].boundaries[0].endChar = 19;
      },
    ],
  ])("rejects %s even after aggregate hashes are refreshed", (_label, mutate) => {
    const artifact = loadArtifact();
    mutate(artifact);
    refreshArtifactHashes(artifact);

    expect(() => validateCoreEvaluationArtifactV1(artifact)).toThrow();
  });

  it.each([
    [
      "validator error outside subset",
      (artifact) => {
        artifact.traces[0].repairs[1].validatorErrors[0].sentenceId =
          artifact.traces[0].inputSentenceIds[1];
      },
    ],
    [
      "raw IDs differ from subset",
      (artifact) => {
        artifact.traces[1].firstPass.raw.sentences.pop();
      },
    ],
    [
      "repair round number is non-local",
      (artifact) => {
        artifact.traces[0].repairs[0].round = 2;
      },
    ],
    [
      "repair reintroduces a successful sentence",
      (artifact) => {
        artifact.traces[0].repairs[1].subsetSentenceIds.push(
          artifact.traces[0].inputSentenceIds[1],
        );
        artifact.traces[0].repairs[1].raw.sentences.push(
          cloneJson(artifact.traces[0].repairs[0].raw.sentences[0]),
        );
      },
    ],
    [
      "message role is invalid",
      (artifact) => {
        artifact.traces[0].firstPass.messages[0].role = "tool";
      },
    ],
    [
      "message does not encode its subset",
      (artifact) => {
        artifact.traces[0].firstPass.messages[0].content = "unbound payload";
      },
    ],
    [
      "serialized subset contains an extra trace sentence",
      (artifact) => {
        artifact.traces[0].repairs[1].serializedSubset += ` ${artifact.traces[0].inputSentenceIds[0]}`;
        artifact.traces[0].repairs[1].messages[0].content += ` ${artifact.traces[0].inputSentenceIds[0]}`;
      },
    ],
    [
      "raw sentence IDs are reordered",
      (artifact) => {
        artifact.traces[0].firstPass.raw.sentences.reverse();
      },
    ],
    [
      "final failures disagree with failure partition",
      (artifact) => {
        artifact.traces[0].final.failures[0].sentenceId = artifact.traces[0].inputSentenceIds[0];
      },
    ],
    [
      "final status disagrees with partition",
      (artifact) => {
        artifact.traces[0].final.status = "success";
      },
    ],
    [
      "final analysis IDs disagree with success partition",
      (artifact) => {
        artifact.traces[0].final.analyses[0].sentenceId =
          artifact.traces[0].final.successSentenceIds[1];
      },
    ],
    [
      "final failure partition disagrees with the last validator result",
      (artifact) => {
        const trace = artifact.traces[0];
        const failedId = trace.final.failureSentenceIds[0];
        trace.final.failureSentenceIds = [];
        trace.final.failures = [];
        trace.final.successSentenceIds.push(failedId);
        trace.final.analyses.push({ sentenceId: failedId, components: [] });
        trace.final.status = "success";
        refreshArtifactReport(artifact);
      },
    ],
  ])("rejects round semantic bypass: %s", (_label, mutate) => {
    const artifact = loadArtifact();
    mutate(artifact);
    refreshArtifactHashes(artifact);

    expect(() => validateCoreEvaluationArtifactV1(artifact)).toThrow();
  });

  it("rejects a corrupted deterministic report metric", () => {
    const artifact = loadArtifact();
    artifact.report.final.exactSentence[0] += 1;

    expect(() => validateCoreEvaluationArtifactV1(artifact)).toThrow(/report/iu);
  });

  describe("paired run comparability", () => {
    const comparisonConfig = () => ({
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      mode: "pipeline",
      batchSize: 6,
      temperature: 0,
      reasoning: { requested: "none", effective: "none", fallback: false },
      responseFormat: { requested: "json_object", effective: "json_object", fallback: false },
      timeout: { strategy: "per-request", valueMs: 120_000 },
    });
    const comparablePair = (index = 1) => {
      const baseline = loadArtifact();
      const candidate = cloneJson(baseline);
      baseline.run.comparisonConfig = comparisonConfig();
      candidate.run.comparisonConfig = comparisonConfig();
      baseline.run.model = baseline.run.comparisonConfig.model;
      candidate.run.model = candidate.run.comparisonConfig.model;
      baseline.run.batchSize = baseline.run.comparisonConfig.batchSize;
      candidate.run.batchSize = candidate.run.comparisonConfig.batchSize;
      baseline.run.parameters.temperature = baseline.run.comparisonConfig.temperature;
      candidate.run.parameters.temperature = candidate.run.comparisonConfig.temperature;
      baseline.run.createdAt = `2026-09-0${index}T00:00:00.000Z`;
      candidate.run.createdAt = `2026-09-1${index}T00:00:00.000Z`;
      baseline.run.commit = `baseline-${index}`;
      candidate.run.commit = `candidate-${index}`;
      candidate.run.hashes.prompt = baseline.run.hashes.prompt;
      candidate.run.hashes.messages = baseline.run.hashes.messages;
      return { baseline, candidate };
    };
    const mutatePairArtifacts = (pair, mutate) => {
      for (const artifact of [pair.baseline, pair.candidate]) {
        mutate(artifact);
        refreshArtifactHashes(artifact);
      }
    };
    const reorderArtifactByTrace = (artifact) => {
      artifact.traces.reverse();
      const sentenceOrder = artifact.traces.flatMap(({ inputSentenceIds }) => inputSentenceIds);
      const order = new Map(sentenceOrder.map((id, index) => [id, index]));
      artifact.corpus.sentences.sort((left, right) => order.get(left.id) - order.get(right.id));
      artifact.corpus.denominatorSentenceIds = sentenceOrder;
      artifact.tokenizerSnapshot.sentences.sort(
        (left, right) =>
          order.get(left.id ?? left.sentenceId) - order.get(right.id ?? right.sentenceId),
      );
      artifact.run.sentenceOrder = sentenceOrder;
    };

    it.each([
      ["endpoint", (config) => (config.endpoint = "https://other.example.com/v1")],
      ["model", (config) => (config.model = "other-model")],
      ["mode", (config) => (config.mode = "first-pass")],
      ["batchSize", (config) => (config.batchSize = 3)],
      ["temperature", (config) => (config.temperature = 0.2)],
      ["reasoning requested", (config) => (config.reasoning.requested = "low")],
      ["reasoning effective", (config) => (config.reasoning.effective = "omitted")],
      ["reasoning fallback", (config) => (config.reasoning.fallback = true)],
      ["response format requested", (config) => (config.responseFormat.requested = "none")],
      ["response format effective", (config) => (config.responseFormat.effective = "none")],
      ["response format fallback", (config) => (config.responseFormat.fallback = true)],
      ["timeout strategy", (config) => (config.timeout.strategy = "whole-run")],
      ["timeout value", (config) => (config.timeout.valueMs = 60_000)],
    ])("rejects %s drift", (_label, mutate) => {
      const { baseline, candidate } = comparablePair();
      mutate(candidate.run.comparisonConfig);

      expect(() => validateComparableCoreEvaluationArtifactsV1(baseline, candidate)).toThrow(
        /comparisonConfig/iu,
      );
    });

    it("allows timestamps, commits, and prompt/message hashes to differ", () => {
      const { baseline, candidate } = comparablePair();
      candidate.traces[0].firstPass.messages[0].content += "\nCandidate run marker.";
      refreshArtifactHashes(candidate);

      expect(validateComparableCoreEvaluationArtifactsV1(baseline, candidate)).toEqual({
        baseline,
        candidate,
      });
    });

    it("rejects non-pipeline pairs and sentence order drift", () => {
      const nonPipeline = comparablePair();
      nonPipeline.baseline.run.mode = "first-pass";
      nonPipeline.candidate.run.mode = "first-pass";
      nonPipeline.baseline.run.comparisonConfig.mode = "first-pass";
      nonPipeline.candidate.run.comparisonConfig.mode = "first-pass";
      expect(() =>
        validateComparableCoreEvaluationArtifactsV1(nonPipeline.baseline, nonPipeline.candidate),
      ).toThrow(/pipeline/iu);

      const reordered = comparablePair();
      reordered.candidate.run.sentenceOrder.reverse();
      expect(() =>
        validateComparableCoreEvaluationArtifactsV1(reordered.baseline, reordered.candidate),
      ).toThrow(/sentenceOrder/iu);
    });

    it.each([
      [
        "corpus snapshot",
        (pair) =>
          mutatePairArtifacts(pair, (artifact) => {
            artifact.corpus.id = "other-corpus";
          }),
        /corpus snapshots/iu,
      ],
      [
        "sentenceOrder",
        (pair) => mutatePairArtifacts(pair, reorderArtifactByTrace),
        /sentenceOrder/iu,
      ],
      [
        "comparisonConfig",
        (pair) =>
          mutatePairArtifacts(pair, (artifact) => {
            artifact.run.comparisonConfig.endpoint = "https://other.example.com/v1";
          }),
        /comparisonConfig/iu,
      ],
    ])("rejects cross-pair %s drift", (_label, mutate, expectedError) => {
      const pairs = [comparablePair(1), comparablePair(2), comparablePair(3)];
      mutate(pairs[1]);

      expect(() => scoreCoreEvaluationArtifactPairs(pairs)).toThrow(expectedError);
    });

    it("requires exactly three pairs and aggregates final metrics plus transition IDs", () => {
      const pairs = [comparablePair(1), comparablePair(2), comparablePair(3)];

      expect(() => scoreCoreEvaluationArtifactPairs(pairs.slice(0, 2))).toThrow(/exactly three/iu);
      const summary = scoreCoreEvaluationArtifactPairs(pairs);

      const expected = scoreCoreEvaluationArtifacts(pairs[0].baseline, pairs[0].candidate);
      expect(summary.pairs).toHaveLength(3);
      expect(summary.pairs[0]).toMatchObject({
        pair: 1,
        transitions: {
          baseline: expected.baseline.transitions,
          candidate: expected.candidate.transitions,
        },
      });
      expect(summary.aggregate.baseline.finalExact).toEqual({
        mean: expected.baseline.final.exactSentence.rate,
        min: expected.baseline.final.exactSentence.rate,
        max: expected.baseline.final.exactSentence.rate,
      });
      expect(summary.aggregate.candidate.labeledSpanF1).toEqual({
        mean: expected.candidate.final.labeledSpan.f1,
        min: expected.candidate.final.labeledSpan.f1,
        max: expected.candidate.final.labeledSpan.f1,
      });
      expect(summary.aggregate.candidate.finalFailures).toEqual({
        mean: expected.candidate.transitions.finalFailures.count,
        min: expected.candidate.transitions.finalFailures.count,
        max: expected.candidate.transitions.finalFailures.count,
      });
    });
  });

  it("compares saved artifacts in character coordinates across tokenizer snapshots", () => {
    const baseline = JSON.parse(
      readFileSync(
        new URL("../../shared-fixtures/core-evaluation-traces.json", import.meta.url),
        "utf8",
      ),
    );
    const candidate = cloneJson(baseline);
    const shiftedIds = new Map();
    for (const snapshot of candidate.tokenizerSnapshot.sentences) {
      const sentenceMap = new Map();
      for (const token of snapshot.tokens) {
        sentenceMap.set(token.id, token.id + 100);
        token.id += 100;
      }
      shiftedIds.set(snapshot.id, sentenceMap);
    }
    const shiftAnalyses = (analyses) => {
      for (const analysis of analyses) {
        const sentenceMap = shiftedIds.get(analysis.sentenceId);
        for (const item of analysis.components ?? []) {
          item.startToken = sentenceMap.get(item.startToken);
          item.endToken = sentenceMap.get(item.endToken);
        }
      }
    };
    for (const trace of candidate.traces) {
      shiftAnalyses(trace.firstPass.raw.sentences);
      shiftAnalyses(trace.final.analyses);
    }
    const sha256Json = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    candidate.tokenizerSnapshot.hash = sha256Json(candidate.tokenizerSnapshot.sentences);
    candidate.run.hashes.tokenizer = candidate.tokenizerSnapshot.hash;
    refreshArtifactReport(candidate);

    const reports = scoreCoreEvaluationArtifacts(baseline, candidate);

    expect(reports.baseline.final.exactSentence.rate).toBe(
      reports.candidate.final.exactSentence.rate,
    );
    expect(reports.baseline.final.labeledSpan.f1).toBe(reports.candidate.final.labeledSpan.f1);
  });
});

describe("scoreCorePredictions", () => {
  it("scores a perfect prediction", () => {
    const gold = [sentence("s1", [component(0, 0, "SUBJECT"), component(1, 1, "PREDICATE")])];

    const report = scoreCorePredictions(gold, JSON.parse(JSON.stringify(gold)));

    expect(report.sentenceCount).toBe(1);
    expect(report.exactSentence).toEqual({ count: 1, rate: 1 });
    expect(report.spanExact).toEqual({
      truePositive: 2,
      predicted: 2,
      gold: 2,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(report.labeledSpan).toEqual({
      truePositive: 2,
      predicted: 2,
      gold: 2,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(report.roleAccuracyOnExactSpans).toEqual({ correct: 2, matched: 2, accuracy: 1 });
    expect(report.details[0]).toMatchObject({
      sentenceId: "s1",
      exact: true,
      missing: [],
      extra: [],
      roleErrors: [],
    });
  });

  it("scores FRAGMENT_HEAD as a normal labeled span", () => {
    const gold = [
      sentence("fragment", [component(0, 2, "FRAGMENT_HEAD"), component(3, 5, "ATTRIBUTE")]),
    ];

    const report = scoreCorePredictions(gold, JSON.parse(JSON.stringify(gold)));

    expect(report.exactSentence).toEqual({ count: 1, rate: 1 });
    expect(report.spanExact).toMatchObject({ truePositive: 2, predicted: 2, gold: 2, f1: 1 });
    expect(report.labeledSpan).toMatchObject({ truePositive: 2, predicted: 2, gold: 2, f1: 1 });
    expect(report.roleAccuracyOnExactSpans).toEqual({ correct: 2, matched: 2, accuracy: 1 });
  });

  it("does not count reversed components as an exact sentence", () => {
    const gold = [sentence("s1", [component(0, 0, "SUBJECT"), component(1, 1, "PREDICATE")])];
    const predicted = [sentence("s1", [component(1, 1, "PREDICATE"), component(0, 0, "SUBJECT")])];

    const report = scoreCorePredictions(gold, predicted);

    expect(report.exactSentence).toEqual({ count: 0, rate: 0 });
    expect(report.spanExact.f1).toBe(1);
    expect(report.labeledSpan.f1).toBe(1);
    expect(report.details[0]).toMatchObject({
      exact: false,
      missing: [],
      extra: [],
      roleErrors: [],
    });
  });

  it("separates boundary matches from role errors", () => {
    const gold = [sentence("s1", [component(0, 0, "SUBJECT")])];
    const predicted = [sentence("s1", [component(0, 0, "OBJECT")])];

    const report = scoreCorePredictions(gold, predicted);

    expect(report.spanExact.f1).toBe(1);
    expect(report.labeledSpan.f1).toBe(0);
    expect(report.roleAccuracyOnExactSpans).toEqual({ correct: 0, matched: 1, accuracy: 0 });
    expect(report.details[0].roleErrors).toEqual([
      { startToken: 0, endToken: 0, expectedRole: "SUBJECT", predictedRole: "OBJECT" },
    ]);
  });

  it("reports missing, extra, and duplicate spans deterministically", () => {
    const gold = [sentence("s1", [component(0, 0, "SUBJECT"), component(1, 1, "PREDICATE")])];
    const predicted = [
      sentence("s1", [
        component(0, 0, "SUBJECT"),
        component(0, 0, "SUBJECT"),
        component(2, 2, "OBJECT"),
      ]),
    ];

    const report = scoreCorePredictions(gold, predicted);

    expect(report.spanExact).toMatchObject({ truePositive: 1, predicted: 3, gold: 2 });
    expect(report.details[0].missing).toEqual([component(1, 1, "PREDICATE")]);
    expect(report.details[0].extra).toEqual([
      component(0, 0, "SUBJECT"),
      component(2, 2, "OBJECT"),
    ]);
  });

  it("handles missing and extra sentences without changing the gold denominator", () => {
    const gold = [sentence("missing", [component(0, 0, "SUBJECT")])];
    const predicted = [sentence("extra", [component(0, 0, "SUBJECT")])];

    const report = scoreCorePredictions(gold, predicted);

    expect(report.sentenceCount).toBe(1);
    expect(report.missingSentenceCount).toBe(1);
    expect(report.extraSentenceCount).toBe(1);
    expect(report.spanExact).toMatchObject({ truePositive: 0, predicted: 1, gold: 1 });
    expect(report.details).toEqual([
      expect.objectContaining({ sentenceId: "missing", status: "missing-sentence" }),
      expect.objectContaining({ sentenceId: "extra", status: "extra-sentence" }),
    ]);
  });

  it("penalizes each duplicate unknown sentence record exactly once", () => {
    const gold = [sentence("gold", [component(0, 0, "SUBJECT")])];
    const predicted = [
      sentence("unknown", [component(0, 0, "SUBJECT")]),
      sentence("unknown", [component(1, 1, "PREDICATE")]),
    ];

    const report = scoreCorePredictions(gold, predicted);

    expect(report.extraSentenceCount).toBe(2);
    expect(report.spanExact.predicted).toBe(2);
    expect(report.details.filter(({ sentenceId }) => sentenceId === "unknown")).toHaveLength(2);
  });

  it("penalizes a duplicate after a matched gold ID exactly once", () => {
    const gold = [sentence("s1", [component(0, 0, "SUBJECT")])];
    const predicted = [
      sentence("s1", [component(0, 0, "SUBJECT")]),
      sentence("s1", [component(1, 1, "PREDICATE")]),
    ];

    const report = scoreCorePredictions(gold, predicted);

    expect(report.extraSentenceCount).toBe(1);
    expect(report.spanExact).toMatchObject({ truePositive: 1, predicted: 2, gold: 1 });
    expect(report.details).toEqual([
      expect.objectContaining({ sentenceId: "s1", status: "matched-sentence", exact: true }),
      expect.objectContaining({ sentenceId: "s1", status: "duplicate-sentence", exact: false }),
    ]);
  });

  it("returns finite zero metrics for empty collections", () => {
    const report = scoreCorePredictions([], []);

    expect(report.exactSentence).toEqual({ count: 0, rate: 0 });
    expect(report.spanExact).toEqual({
      truePositive: 0,
      predicted: 0,
      gold: 0,
      precision: 0,
      recall: 0,
      f1: 0,
    });
    expect(report.labeledSpan).toEqual({
      truePositive: 0,
      predicted: 0,
      gold: 0,
      precision: 0,
      recall: 0,
      f1: 0,
    });
    expect(report.roleAccuracyOnExactSpans).toEqual({ correct: 0, matched: 0, accuracy: 0 });
  });

  it("compares etc. spans across tokenizer versions that assign different token IDs", () => {
    const text = "Use counters, timers, etc. in practice.";
    const gold = [
      {
        sentenceId: "etc",
        text,
        tokens: [
          { id: 0, start: 0, end: 3 },
          { id: 1, start: 4, end: 12 },
          { id: 2, start: 12, end: 13 },
          { id: 3, start: 14, end: 20 },
          { id: 4, start: 20, end: 21 },
          { id: 5, start: 22, end: 26 },
          { id: 6, start: 27, end: 29 },
          { id: 7, start: 30, end: 38 },
          { id: 8, start: 38, end: 39 },
        ],
        components: [component(0, 8, "FRAGMENT_HEAD")],
      },
    ];
    const prediction = [
      {
        sentenceId: "etc",
        text,
        tokens: [
          { id: 100, start: 0, end: 3 },
          { id: 101, start: 4, end: 12 },
          { id: 102, start: 12, end: 13 },
          { id: 103, start: 14, end: 20 },
          { id: 104, start: 20, end: 21 },
          { id: 105, start: 22, end: 26 },
          { id: 106, start: 27, end: 29 },
          { id: 107, start: 30, end: 38 },
          { id: 108, start: 38, end: 39 },
        ],
        components: [component(100, 108, "FRAGMENT_HEAD")],
      },
    ];

    expect(
      scoreCorePredictions(gold, prediction, { coordinateSystem: "characters" }).exactSentence.rate,
    ).toBe(1);
  });

  it("compares normalized character spans across different token IDs", () => {
    const gold = [
      {
        sentenceId: "retokenized",
        tokens: [
          { id: 0, start: 0, end: 3 },
          { id: 1, start: 4, end: 7 },
        ],
        components: [component(0, 1, "SUBJECT")],
      },
    ];
    const predicted = [
      {
        sentenceId: "retokenized",
        tokens: [{ id: 9, start: 0, end: 7 }],
        components: [component(9, 9, "SUBJECT")],
      },
    ];

    const report = scoreCorePredictions(gold, predicted, { coordinateSystem: "characters" });

    expect(report.exactSentence).toEqual({ count: 1, rate: 1 });
    expect(report.labeledSpan.f1).toBe(1);
    expect(report.details[0]).toMatchObject({ exact: true, missing: [], extra: [] });
  });

  it("rejects a direct character span beyond its sentence text", () => {
    const input = [
      {
        sentenceId: "bad-direct-character-span",
        text: "short",
        components: [{ startChar: 0, endChar: 6, role: "SUBJECT" }],
      },
    ];

    expect(() => scoreCorePredictions(input, input, { coordinateSystem: "characters" })).toThrow(
      /character span/iu,
    );
  });

  it.each([
    ["a missing start token", [{ id: 1, start: 0, end: 3 }], component(0, 1, "SUBJECT")],
    [
      "a duplicate token ID",
      [
        { id: 0, start: 0, end: 3 },
        { id: 0, start: 4, end: 7 },
      ],
      component(0, 0, "SUBJECT"),
    ],
    [
      "an inverted token range",
      [
        { id: 0, start: 0, end: 3 },
        { id: 1, start: 4, end: 7 },
      ],
      component(1, 0, "SUBJECT"),
    ],
    [
      "an inverted character mapping",
      [
        { id: 0, start: 4, end: 3 },
        { id: 1, start: 5, end: 7 },
      ],
      component(0, 1, "SUBJECT"),
    ],
  ])("rejects %s instead of falling back to token coordinates", (_label, tokens, badComponent) => {
    const input = [{ sentenceId: "bad", tokens, components: [badComponent] }];

    expect(() => scoreCorePredictions(input, input, { coordinateSystem: "characters" })).toThrow();
  });
});

describe("scorePipelineTrace", () => {
  const gold = [
    sentence("legal", [component(0, 0, "SUBJECT")]),
    sentence("repaired", [component(0, 0, "SUBJECT")]),
    sentence("damaged", [component(0, 0, "SUBJECT")]),
    sentence("failed", [component(0, 0, "SUBJECT")]),
    sentence("narrow-a", [component(0, 0, "SUBJECT")]),
    sentence("narrow-b", [component(0, 0, "SUBJECT")]),
  ];
  const wrong = (id) => sentence(id, [component(0, 0, "OBJECT")]);
  const exact = (id) => sentence(id, [component(0, 0, "SUBJECT")]);
  const trace = {
    denominatorSentenceIds: gold.map(({ sentenceId }) => sentenceId),
    firstPass: {
      predictions: [
        exact("legal"),
        wrong("repaired"),
        exact("damaged"),
        wrong("failed"),
        wrong("narrow-a"),
        wrong("narrow-b"),
      ],
      acceptedSentenceIds: ["legal"],
      validatorErrors: [
        { sentenceId: "repaired", kinds: ["grammar"], errors: [{ path: "x", message: "grammar" }] },
        {
          sentenceId: "damaged",
          kinds: ["non-grammar"],
          errors: [{ path: "x", message: "unknown field" }],
        },
        { sentenceId: "failed", kinds: ["grammar"], errors: [{ path: "x", message: "grammar" }] },
        { sentenceId: "narrow-a", kinds: ["grammar"], errors: [{ path: "x", message: "grammar" }] },
        { sentenceId: "narrow-b", kinds: ["grammar"], errors: [{ path: "x", message: "grammar" }] },
      ],
    },
    repairs: [
      {
        round: 1,
        subsetSentenceIds: ["repaired", "damaged", "failed", "narrow-a", "narrow-b"],
        predictions: [
          exact("repaired"),
          wrong("damaged"),
          wrong("failed"),
          exact("narrow-a"),
          wrong("narrow-b"),
        ],
      },
      {
        round: 2,
        subsetSentenceIds: ["damaged", "failed", "narrow-b"],
        predictions: [wrong("damaged"), wrong("failed"), exact("narrow-b")],
      },
    ],
    final: {
      predictions: [exact("legal"), exact("repaired"), exact("narrow-a"), exact("narrow-b")],
      failureSentenceIds: ["damaged", "failed"],
    },
  };

  it("keeps failures in the fixed denominator and reports all transition classes", () => {
    const report = scorePipelineTrace(gold, trace);

    expect(report.denominator).toBe(6);
    expect(report.firstPass.exactSentence.count).toBe(2);
    expect(report.final.exactSentence).toEqual({ count: 4, rate: 4 / 6 });
    expect(report.transitions).toEqual({
      repairedToCorrect: { count: 3, sentenceIds: ["repaired", "narrow-a", "narrow-b"] },
      correctToWrongOrFailure: { count: 1, sentenceIds: ["damaged"] },
      finalFailures: { count: 2, sentenceIds: ["damaged", "failed"] },
    });
    expect(report.correctFirstPassRejection).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 1 / 2,
      displayRate: "50.00%",
      grammarSentenceIds: [],
      nonGrammarSentenceIds: ["damaged"],
    });
  });

  it("reports N/A when no first-pass prediction is exact", () => {
    const noExact = {
      ...trace,
      firstPass: {
        predictions: gold.map(({ sentenceId }) => wrong(sentenceId)),
        acceptedSentenceIds: [],
        validatorErrors: [],
      },
    };

    const report = scorePipelineTrace(gold, noExact);

    expect(report.correctFirstPassRejection).toMatchObject({
      denominator: 0,
      rate: null,
      displayRate: "N/A",
    });
    expect(formatPipelineTransition(report)).toContain("Correct first-pass rejection: N/A");
  });

  it.each([
    ["unknown", ["legal", "unknown"]],
    ["duplicate", ["legal", "legal"]],
    ["missing", gold.slice(0, -1).map(({ sentenceId }) => sentenceId)],
  ])("rejects a %s fixed denominator", (_label, denominatorSentenceIds) => {
    expect(() => scorePipelineTrace(gold, { ...trace, denominatorSentenceIds })).toThrow();
  });

  it("reports N/A metrics for declared empty groups", () => {
    const corpusMetadata = gold.map(({ sentenceId }) => ({
      id: sentenceId,
      split: "rule-regression",
      category: "fragment",
    }));

    const report = scorePipelineTrace(gold, trace, {
      corpusMetadata,
      splits: ["rule-regression", "independent-holdout"],
      categories: ["fragment", "clause"],
    });

    expect(report.bySplit["independent-holdout"]).toEqual({ denominator: 0, status: "N/A" });
    expect(report.byCategory.clause).toEqual({ denominator: 0, status: "N/A" });
  });

  it("reports first and final metrics by split and category with fixed denominators", () => {
    const corpusMetadata = gold.map(({ sentenceId }, index) => ({
      id: sentenceId,
      split: index < 3 ? "rule-regression" : "independent-holdout",
      category: index % 2 === 0 ? "fragment" : "clause",
    }));

    const report = scorePipelineTrace(gold, trace, { corpusMetadata });

    expect(report.bySplit["rule-regression"].denominator).toBe(3);
    expect(report.bySplit["independent-holdout"].denominator).toBe(3);
    expect(report.byCategory.fragment.denominator + report.byCategory.clause.denominator).toBe(6);
    expect(report.bySplit["rule-regression"].firstPass.exactSentence.count).toBe(2);
    expect(report.byCategory.fragment).toHaveProperty("transitions.repairedToCorrect");
  });
});
