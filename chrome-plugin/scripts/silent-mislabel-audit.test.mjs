import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import {
  auditPredictions,
  predictionsFromProbeReport,
  validateAuditSetV1,
} from "./silent-mislabel-audit.mjs";
import { tokenize } from "../src/language/segmenter";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../shared-fixtures/audit-silent-mislabel.json", import.meta.url),
    "utf8",
  ),
);

function oneCase(overrides = {}) {
  return {
    schemaVersion: "silent-mislabel-audit/v1",
    oracleVersion: 1,
    cases: [
      {
        caseId: "case-1",
        category: "test",
        text: "IV.2 Implications for the future",
        tokenization: "core-15",
        tokenCount: 5,
        adjudicationStatus: "adjudicated",
        constraints: [{ type: "at-most-one-role", role: "FRAGMENT_HEAD" }],
        ...overrides,
      },
    ],
  };
}

/** 生产预测形状：终态由 runStatus 表达，不再用 ran 布尔。 */
function passed(components) {
  return { runStatus: "passed", passedValidation: true, components };
}

describe("validateAuditSetV1", () => {
  it("接受仓库内的审计集并用生产 tokenizer 校验所有范围", () => {
    expect(() => validateAuditSetV1(fixture, tokenize)).not.toThrow();
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3);
  });

  it("拒绝空 constraints、未知角色与超出真实 token 的范围", () => {
    expect(() => validateAuditSetV1(oneCase({ constraints: [] }), tokenize)).toThrow(/non-empty/);
    expect(() =>
      validateAuditSetV1(
        oneCase({ constraints: [{ type: "at-most-one-role", role: "NOT_A_ROLE" }] }),
        tokenize,
      ),
    ).toThrow(/unknown role/);
    expect(() =>
      validateAuditSetV1(
        oneCase({ constraints: [{ type: "must-not-be-standalone-span", tokenSpan: [0, 999] }] }),
        tokenize,
      ),
    ).toThrow(/outside token range/);
  });

  it("拒绝与生产分词不一致的 tokenCount 快照", () => {
    expect(() => validateAuditSetV1(oneCase({ tokenCount: 999 }), tokenize)).toThrow(
      /tokenCount snapshot/,
    );
  });

  it("拒绝把不同完整答案中的成分任意拼接成新答案", () => {
    const set = validateAuditSetV1(
      oneCase({
        acceptedAnalyses: [
          [{ startToken: 0, endToken: 4, role: "FRAGMENT_HEAD" }],
          [
            { startToken: 0, endToken: 2, role: "FRAGMENT_HEAD" },
            { startToken: 3, endToken: 4, role: "ATTRIBUTE" },
          ],
        ],
      }),
      tokenize,
    );
    const report = auditPredictions(
      set,
      new Map([
        [
          "case-1",
          // 第一组的头(0..2) + 第二组的尾(4..4):两组的成分被拼在一起,
          // 既不等于任何一组完整 gold,也留下了 token 3 的缺口。
          passed([
            { startToken: 0, endToken: 2, role: "FRAGMENT_HEAD" },
            { startToken: 4, endToken: 4, role: "ATTRIBUTE" },
          ]),
        ],
      ]),
    );
    expect(report.cases[0].verdict).toBe("violates-gold");
  });
});

describe("auditPredictions", () => {
  const set = validateAuditSetV1(fixture, tokenize);

  it("把现网的编号独立片段主体判为违反 constraints", () => {
    const report = auditPredictions(
      set,
      new Map([
        [
          "heading-number-binding-ii-2-2",
          passed([
            { startToken: 0, endToken: 2, role: "FRAGMENT_HEAD" },
            { startToken: 3, endToken: 9, role: "ATTRIBUTE" },
          ]),
        ],
      ]),
    );
    const heading = report.cases.find((item) => item.caseId === "heading-number-binding-ii-2-2");
    expect(heading.verdict).toBe("violates-constraints");
    expect(report.silentMislabelRate).toBe(1);
  });

  it("编号与标题主体合并后满足 constraints", () => {
    const report = auditPredictions(
      set,
      new Map([
        [
          "heading-number-binding-ii-2-2",
          passed([{ startToken: 0, endToken: 9, role: "FRAGMENT_HEAD" }]),
        ],
      ]),
    );
    const heading = report.cases.find((item) => item.caseId === "heading-number-binding-ii-2-2");
    expect(heading.verdict).toBe("meets-constraints");
    expect(report.silentMislabelRate).toBe(0);
  });

  it("只有局部 oracle 时报告 meets-constraints,不得冒充 meets-gold", () => {
    const localOnly = validateAuditSetV1(oneCase(), tokenize);
    const report = auditPredictions(
      localOnly,
      new Map([["case-1", passed([{ startToken: 0, endToken: 4, role: "FRAGMENT_HEAD" }])]]),
    );
    expect(report.cases[0].verdict).toBe("meets-constraints");
    expect(report.counts.adjudicatedGoldPassed).toBe(0);
    expect(report.correctnessLowerBound).toBe(0);
  });

  it("完整 acceptedAnalyses 命中才记 meets-gold 并进入正确分子", () => {
    const withGold = validateAuditSetV1(
      oneCase({
        acceptedAnalyses: [
          [
            { startToken: 0, endToken: 2, role: "FRAGMENT_HEAD" },
            { startToken: 3, endToken: 4, role: "ATTRIBUTE" },
          ],
        ],
      }),
      tokenize,
    );
    const report = auditPredictions(
      withGold,
      new Map([
        [
          "case-1",
          passed([
            { startToken: 0, endToken: 2, role: "FRAGMENT_HEAD" },
            { startToken: 3, endToken: 4, role: "ATTRIBUTE" },
          ]),
        ],
      ]),
    );
    expect(report.cases[0].verdict).toBe("meets-gold");
    expect(report.counts.adjudicatedGoldPassed).toBe(1);
    expect(report.correctnessLowerBound).toBe(1);
  });

  it("pending 即使满足约束也不计入已正确分子", () => {
    const pending = validateAuditSetV1(oneCase({ adjudicationStatus: "pending" }), tokenize);
    const report = auditPredictions(
      pending,
      new Map([["case-1", passed([{ startToken: 0, endToken: 4, role: "FRAGMENT_HEAD" }])]]),
    );
    expect(report.cases[0].verdict).toBe("pending-adjudication");
    expect(report.correctnessLowerBound).toBe(0);
    expect(report.silentMislabelRate).toBe(null);
  });

  it("Figure 2 正确拆分满足,吞入 of 短语的错误拆分失败", () => {
    // 真实 caption:0 Figure / 1 2 / 2 :(p) / 3 Comparison / 4 of / 5 six /
    // 6 nside / 7 64 / 8 GOOD / 9 pixels / 10 generated ...
    const correct = [
      { startToken: 0, endToken: 3, role: "FRAGMENT_HEAD" },
      { startToken: 4, endToken: 9, role: "ATTRIBUTE" },
      { startToken: 10, endToken: 30, role: "ATTRIBUTE" },
    ];
    const swallowed = [
      { startToken: 0, endToken: 9, role: "FRAGMENT_HEAD" },
      { startToken: 10, endToken: 30, role: "ATTRIBUTE" },
    ];
    const ok = auditPredictions(set, new Map([["figure-label-noun-fragment", passed(correct)]]));
    const bad = auditPredictions(set, new Map([["figure-label-noun-fragment", passed(swallowed)]]));
    expect(ok.cases.find((item) => item.caseId === "figure-label-noun-fragment")?.verdict).toBe(
      "meets-constraints",
    );
    expect(bad.cases.find((item) => item.caseId === "figure-label-noun-fragment")?.verdict).toBe(
      "violates-constraints",
    );
  });

  it.each([
    [14, 16],
    [14, 17],
    [15, 15],
  ])("句末引用独立覆盖 %i..%i 都判违反", (startToken, endToken) => {
    const report = auditPredictions(
      set,
      new Map([
        [
          "trailing-citation-61",
          passed([
            { startToken: 0, endToken: 2, role: "SUBJECT" },
            { startToken: 3, endToken: 5, role: "PREDICATE" },
            { startToken: 6, endToken: 10, role: "PREDICATIVE" },
            { startToken: 11, endToken: 13, role: "ADVERBIAL" },
            { startToken, endToken, role: "APPOSITIVE" },
          ]),
        ],
      ]),
    );
    const citation = report.cases.find((item) => item.caseId === "trailing-citation-61");
    expect(citation.verdict).toBe("violates-constraints");
  });

  it("句末引用与时间状语共同覆盖时满足", () => {
    const report = auditPredictions(
      set,
      new Map([
        [
          "trailing-citation-61",
          passed([
            { startToken: 0, endToken: 2, role: "SUBJECT" },
            { startToken: 3, endToken: 5, role: "PREDICATE" },
            { startToken: 6, endToken: 10, role: "PREDICATIVE" },
            { startToken: 11, endToken: 16, role: "ADVERBIAL" },
          ]),
        ],
      ]),
    );
    const citation = report.cases.find((item) => item.caseId === "trailing-citation-61");
    expect(citation.verdict).toBe("meets-constraints");
  });

  it("未运行、未终态与校验失败分别报告", () => {
    const report = auditPredictions(
      set,
      new Map([
        ["heading-number-binding-ii-2-2", { runStatus: "not-terminal" }],
        ["trailing-citation-61", { runStatus: "failed-validation", passedValidation: false }],
      ]),
    );
    expect(report.cases.map((item) => item.verdict)).toEqual([
      "not-terminal",
      "not-run",
      "failed-validation",
    ]);
    expect(report.silentMislabelRate).toBe(null);
  });
});

describe("predictionsFromProbeReport", () => {
  it("没有逐句终态证据时不把 DOM sentence 推定为校验通过", () => {
    const set = validateAuditSetV1(oneCase(), tokenize);
    const predictions = predictionsFromProbeReport(set, {
      cards: [
        {
          blockTextFingerprint: "IV.2 Implications for the future",
          sentences: [
            {
              sentenceId: "transient",
              original: "IV.2 Implications for the future",
              components: [{ startToken: 0, endToken: 6, role: "片段主体" }],
            },
          ],
          failures: [],
        },
      ],
      sentenceTerminals: [],
    });
    expect(predictions.get("case-1")).toEqual({ runStatus: "not-terminal" });
  });

  it("用稳定 sentenceId + 完整文本 + ready 终态关联", () => {
    const set = validateAuditSetV1(oneCase(), tokenize);
    const predictions = predictionsFromProbeReport(set, {
      cards: [
        {
          blockTextFingerprint: "IV.2 Implications for the future",
          sentences: [
            {
              sentenceId: "ready-1",
              original: "IV.2 Implications for the future",
              components: [{ startToken: 0, endToken: 6, role: "片段主体" }],
            },
          ],
          failures: [],
        },
      ],
      sentenceTerminals: [
        {
          sentenceId: "ready-1",
          phase: "ready",
          blockTextFingerprint: "IV.2 Implications for the future",
        },
      ],
    });
    expect(predictions.get("case-1")?.runStatus).toBe("passed");
    expect(predictions.get("case-1")?.passedValidation).toBe(true);
  });

  it("同前缀不同句与重复块不会被合并", () => {
    const set = validateAuditSetV1(oneCase(), tokenize);
    const predictions = predictionsFromProbeReport(set, {
      cards: [
        {
          blockTextFingerprint: "block-a",
          sentences: [
            {
              sentenceId: "s-a",
              original: "IV.2 Implications for the future",
              components: [{ startToken: 0, endToken: 6, role: "片段主体" }],
            },
          ],
          failures: [],
        },
        {
          blockTextFingerprint: "block-b",
          sentences: [
            {
              sentenceId: "s-b",
              original: "IV.2 Implications for the future",
              components: [{ startToken: 0, endToken: 6, role: "片段主体" }],
            },
          ],
          failures: [],
        },
      ],
      sentenceTerminals: [
        { sentenceId: "s-a", phase: "ready", blockTextFingerprint: "block-a" },
        { sentenceId: "s-b", phase: "ready", blockTextFingerprint: "block-b" },
      ],
    });
    // 两个块文本完全相同不再假定是同一句；歧义记 not-terminal。
    expect(predictions.get("case-1")).toEqual({ runStatus: "not-terminal" });
  });
});
