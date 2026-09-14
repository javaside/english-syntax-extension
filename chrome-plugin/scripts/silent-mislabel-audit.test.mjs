import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { auditPredictions, validateAuditSetV1 } from "./silent-mislabel-audit.mjs";

// scripts/ → chrome-plugin/ → 仓库根 → shared-fixtures
const fixture = JSON.parse(
  readFileSync(
    new URL("../../shared-fixtures/audit-silent-mislabel.json", import.meta.url),
    "utf8",
  ),
);

describe("validateAuditSetV1", () => {
  it("接受仓库内的审计集", () => {
    expect(() => validateAuditSetV1(fixture)).not.toThrow();
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3);
  });

  it("拒绝空 constraints 与未知角色", () => {
    expect(() =>
      validateAuditSetV1({
        schemaVersion: "silent-mislabel-audit/v1",
        oracleVersion: 1,
        cases: [{ caseId: "a", text: "t", adjudicationStatus: "adjudicated", constraints: [] }],
      }),
    ).toThrow(/non-empty/);
    expect(() =>
      validateAuditSetV1({
        schemaVersion: "silent-mislabel-audit/v1",
        oracleVersion: 1,
        cases: [
          {
            caseId: "a",
            text: "t",
            adjudicationStatus: "adjudicated",
            constraints: [{ type: "at-most-one-role", role: "NOT_A_ROLE" }],
          },
        ],
      }),
    ).toThrow(/unknown role/);
  });
});

describe("auditPredictions", () => {
  const set = validateAuditSetV1(fixture);

  it("把现网的编号独立片段主体判为违反 gold", () => {
    // 2026-09-12 真机实测的 II.2.2 划分:编号独立成 FRAGMENT_HEAD。
    const report = auditPredictions(
      set,
      new Map([
        [
          "heading-number-binding-ii-2-2",
          {
            ran: true,
            passedValidation: true,
            components: [
              { startToken: 0, endToken: 2, role: "FRAGMENT_HEAD" },
              { startToken: 3, endToken: 9, role: "ATTRIBUTE" },
            ],
          },
        ],
      ]),
    );
    const heading = report.cases.find((c) => c.caseId === "heading-number-binding-ii-2-2");
    expect(heading.verdict).toBe("violates-gold");
    expect(report.silentMislabelRate).toBe(1);
  });

  it("编号与标题主体合并后判为符合 gold", () => {
    const report = auditPredictions(
      set,
      new Map([
        [
          "heading-number-binding-ii-2-2",
          {
            ran: true,
            passedValidation: true,
            components: [{ startToken: 0, endToken: 9, role: "FRAGMENT_HEAD" }],
          },
        ],
      ]),
    );
    const heading = report.cases.find((c) => c.caseId === "heading-number-binding-ii-2-2");
    expect(heading.verdict).toBe("meets-gold");
    expect(report.silentMislabelRate).toBe(0);
  });

  it("句末引用独立成分判为违反", () => {
    const report = auditPredictions(
      set,
      new Map([
        [
          "trailing-citation-61",
          {
            ran: true,
            passedValidation: true,
            components: [
              { startToken: 0, endToken: 2, role: "SUBJECT" },
              { startToken: 3, endToken: 5, role: "PREDICATE" },
              { startToken: 6, endToken: 10, role: "PREDICATIVE" },
              { startToken: 11, endToken: 13, role: "ADVERBIAL" },
              { startToken: 14, endToken: 16, role: "APPOSITIVE" }, // 引文数字串独立成成分
            ],
          },
        ],
      ]),
    );
    const citation = report.cases.find((c) => c.caseId === "trailing-citation-61");
    expect(citation.verdict).toBe("violates-gold");
  });

  it("未运行与校验失败不进裁决分母", () => {
    const report = auditPredictions(
      set,
      new Map([
        ["heading-number-binding-ii-2-2", { ran: false }],
        ["trailing-citation-61", { ran: true, passedValidation: false }],
      ]),
    );
    expect(report.silentMislabelRate).toBe(null); // 分母 0 → N/A
    expect(report.cases.map((c) => c.verdict)).toEqual(["not-run", "not-run", "failed-validation"]);
  });

  it("correctnessLowerBound 以全部固定审计项为分母", () => {
    const report = auditPredictions(set, new Map());
    expect(report.correctnessLowerBound).toBe(0);
    expect(report.counts.total).toBe(fixture.cases.length);
  });
});
