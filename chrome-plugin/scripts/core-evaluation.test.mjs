import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import {
  formatPipelineTransition,
  scoreCorePredictions,
  scorePipelineTrace,
  createCoreEvaluationReportV1,
  scoreCoreEvaluationArtifacts,
  validateCoreEvaluationArtifactV1,
  validateCoreEvaluationCorpusV1,
} from "./core-evaluation.mjs";

const component = (startToken, endToken, role) => ({ startToken, endToken, role });
const sentence = (sentenceId, components) => ({ sentenceId, components });
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const fixtureUrl = new URL("../../shared-fixtures/core-evaluation-traces.json", import.meta.url);
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
