import { describe, expect, it } from "vitest";

import { scoreCorePredictions } from "./core-evaluation.mjs";

const component = (startToken, endToken, role) => ({ startToken, endToken, role });
const sentence = (sentenceId, components) => ({ sentenceId, components });

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
});
