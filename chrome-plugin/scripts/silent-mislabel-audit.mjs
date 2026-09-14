// 静默错标审计器:对「通过校验但标错」建立可执行 oracle。
// 输入是固定审计集(shared-fixtures/audit-silent-mislabel.json)与逐 case 的预测
// (token 区间 + role)。输出两轴(运行轴 × 裁决轴)与两个比率。
// 「正确」限定为 span/role 审计正确,不含译文语义正确性。
import { readFileSync } from "node:fs";
import { URL } from "node:url";
const ROLES = new Set([
  "SUBJECT",
  "PREDICATE",
  "OBJECT",
  "PREDICATIVE",
  "COMPLEMENT",
  "ATTRIBUTE",
  "ADVERBIAL",
  "APPOSITIVE",
  "INDEPENDENT_ELEMENT",
  "CONJUNCTION",
  "FRAGMENT_HEAD",
  "ATTRIBUTIVE_CLAUSE",
  "SUBJECT_CLAUSE",
  "OBJECT_CLAUSE",
  "PREDICATIVE_CLAUSE",
  "ADVERBIAL_CLAUSE",
  "COORDINATE_CLAUSE",
]);

/**
 * 校验审计集自身:唯一 caseId、非空 constraints、tokenSpan 区间合法,
 * 约束引用的角色在枚举内。oracle 自洽是审计可信的前提。
 */
export function validateAuditSetV1(value) {
  if (typeof value !== "object" || value === null) throw new Error("audit set must be an object");
  if (value.schemaVersion !== "silent-mislabel-audit/v1") throw new Error("schemaVersion mismatch");
  if (!Number.isInteger(value.oracleVersion)) throw new Error("oracleVersion must be an integer");
  if (!Array.isArray(value.cases) || value.cases.length === 0)
    throw new Error("cases must be non-empty");
  const seen = new Set();
  for (const auditCase of value.cases) {
    if (typeof auditCase.caseId !== "string" || auditCase.caseId.length === 0)
      throw new Error("caseId required");
    if (seen.has(auditCase.caseId)) throw new Error(`duplicate caseId: ${auditCase.caseId}`);
    seen.add(auditCase.caseId);
    if (typeof auditCase.text !== "string" || auditCase.text.length === 0)
      throw new Error("text required");
    if (
      auditCase.adjudicationStatus !== "adjudicated" &&
      auditCase.adjudicationStatus !== "pending"
    ) {
      throw new Error("adjudicationStatus must be adjudicated|pending");
    }
    if (!Array.isArray(auditCase.constraints) || auditCase.constraints.length === 0) {
      throw new Error(`${auditCase.caseId}: constraints must be non-empty`);
    }
    for (const constraint of auditCase.constraints) {
      // at-most-one-role 是句级约束,不指向具体 span;其余类型必须有 tokenSpan(s)。
      const spans = constraint.tokenSpans ?? (constraint.tokenSpan ? [constraint.tokenSpan] : []);
      if (spans.length === 0 && constraint.type !== "at-most-one-role") {
        throw new Error(`${auditCase.caseId}: constraint lacks tokenSpan(s)`);
      }
      for (const [start, end] of spans) {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
          throw new Error(`${auditCase.caseId}: invalid token span [${start}, ${end}]`);
        }
      }
      if (constraint.role !== undefined && !ROLES.has(constraint.role)) {
        throw new Error(`${auditCase.caseId}: unknown role ${constraint.role}`);
      }
    }
  }
  return value;
}

function spanOf(components, span) {
  const [start, end] = span;
  return components.find((component) => component.startToken <= start && component.endToken >= end);
}

/** 判定单个 case 的预测是否满足其全部 constraints;返回首个违反的约束描述。 */
function violates(auditCase, components) {
  for (const constraint of auditCase.constraints) {
    if (constraint.type === "must-not-be-standalone-role") {
      const [start, end] = constraint.tokenSpan;
      const component = components.find(
        (candidate) => candidate.startToken === start && candidate.endToken === end,
      );
      if (component !== undefined && component.role === constraint.role) {
        return `tokens [${start}, ${end}] must not stand alone as ${constraint.role}`;
      }
      continue;
    }
    if (constraint.type === "must-cover-together") {
      const holders = constraint.tokenSpans.map((span) => spanOf(components, span));
      const first = holders[0];
      if (first === undefined) return `span ${JSON.stringify(constraint.tokenSpans[0])} uncovered`;
      if (holders.some((holder) => holder !== first)) {
        return `spans ${JSON.stringify(constraint.tokenSpans)} must be covered by one ${constraint.role}`;
      }
      if (constraint.role !== undefined && first.role !== constraint.role) {
        return `covering component must be ${constraint.role}, got ${first.role}`;
      }
      continue;
    }
    if (constraint.type === "at-most-one-role") {
      const count = components.filter((component) => component.role === constraint.role).length;
      if (count > 1) return `${count} components tagged ${constraint.role}; at most one allowed`;
      continue;
    }
    if (constraint.type === "must-not-be-standalone-span") {
      const [start, end] = constraint.tokenSpan;
      const component = components.find(
        (candidate) => candidate.startToken === start && candidate.endToken === end,
      );
      if (component !== undefined) {
        return `tokens [${start}, ${end}] must not form a standalone component`;
      }
      continue;
    }
    return `unknown constraint type: ${constraint.type}`;
  }
  return null;
}

/**
 * 审计预测。predictionsByCase: Map<caseId, { ran: boolean; passedValidation: boolean;
 * components?: Array<{ startToken, endToken, role }> }>。
 * ran=false 表示未请求或未终态;passedValidation=false 表示最终校验失败。
 */
export function auditPredictions(auditSet, predictionsByCase) {
  const cases = [];
  let adjudicatedPassed = 0;
  let adjudicatedViolating = 0;
  let allCorrect = 0;
  for (const auditCase of auditSet.cases) {
    const prediction = predictionsByCase.get(auditCase.caseId);
    const base = { caseId: auditCase.caseId, category: auditCase.category };
    if (prediction === undefined || prediction.ran !== true) {
      cases.push({
        ...base,
        runStatus: "not-run",
        adjudication: auditCase.adjudicationStatus,
        verdict: "not-run",
      });
      continue;
    }
    if (prediction.passedValidation !== true) {
      cases.push({
        ...base,
        runStatus: "failed-validation",
        adjudication: auditCase.adjudicationStatus,
        verdict: "failed-validation",
      });
      continue;
    }
    const violation = violates(auditCase, prediction.components ?? []);
    const verdict = violation === null ? "meets-gold" : "violates-gold";
    if (auditCase.adjudicationStatus === "adjudicated") {
      if (violation === null) adjudicatedPassed += 1;
      else adjudicatedViolating += 1;
    }
    if (violation === null) allCorrect += 1;
    cases.push({
      ...base,
      runStatus: "passed",
      adjudication: auditCase.adjudicationStatus,
      verdict,
      violation,
    });
  }
  // 静默错标率分母 = 已通过且已裁决;分母为 0 时为 null(N/A),不是 0。
  const denominator = adjudicatedPassed + adjudicatedViolating;
  return {
    schemaVersion: "silent-mislabel-audit-report/v1",
    oracleVersion: auditSet.oracleVersion,
    cases,
    silentMislabelRate: denominator === 0 ? null : adjudicatedViolating / denominator,
    correctnessLowerBound: allCorrect / auditSet.cases.length,
    counts: {
      total: auditSet.cases.length,
      adjudicatedPassed,
      adjudicatedViolating,
    },
  };
}

export function loadAuditSet(path) {
  return validateAuditSetV1(JSON.parse(readFileSync(path, "utf8")));
}

// —— CLI:审计真机报告预测 ——
// 用法:node scripts/silent-mislabel-audit.mjs --report <probe-report.json>
// 报告里的卡片按句子原文与审计集 text 前缀配对;role 是页面中文标签,映射回枚举。
const LABEL_TO_ROLE = {
  主语: "SUBJECT",
  谓语: "PREDICATE",
  宾语: "OBJECT",
  表语: "PREDICATIVE",
  补语: "COMPLEMENT",
  定语: "ATTRIBUTE",
  状语: "ADVERBIAL",
  同位语: "APPOSITIVE",
  独立成分: "INDEPENDENT_ELEMENT",
  并列连词: "CONJUNCTION",
  片段主体: "FRAGMENT_HEAD",
  定语从句: "ATTRIBUTIVE_CLAUSE",
  主语从句: "SUBJECT_CLAUSE",
  宾语从句: "OBJECT_CLAUSE",
  表语从句: "PREDICATIVE_CLAUSE",
  状语从句: "ADVERBIAL_CLAUSE",
};

function isCli() {
  return process.argv[1] !== undefined && process.argv[1].endsWith("silent-mislabel-audit.mjs");
}

if (isCli()) {
  const args = new Map(
    process.argv
      .slice(2)
      .map((value, index, all) =>
        value.startsWith("--") ? [value.slice(2), all[index + 1]] : null,
      )
      .filter(Boolean),
  );
  const auditSet = loadAuditSet(
    new URL("../../shared-fixtures/audit-silent-mislabel.json", import.meta.url).pathname,
  );
  const report = JSON.parse(readFileSync(args.get("report"), "utf8"));
  const predictions = new Map();
  for (const auditCase of auditSet.cases) {
    const prefix = auditCase.text.replace(/\s+/gu, " ").trim().slice(0, 40);
    let matched = null;
    let failed = false;
    for (const card of report.cards ?? []) {
      for (const sentence of card.sentences ?? []) {
        if (sentence.original.replace(/\s+/gu, " ").trim().startsWith(prefix.slice(0, 30))) {
          matched = sentence;
        }
      }
      for (const failure of card.failures ?? []) {
        if (failure.original.replace(/\s+/gu, " ").trim().startsWith(prefix.slice(0, 30))) {
          failed = true;
        }
      }
    }
    if (failed) {
      predictions.set(auditCase.caseId, { ran: true, passedValidation: false });
    } else if (matched !== null) {
      predictions.set(auditCase.caseId, {
        ran: true,
        passedValidation: true,
        components: matched.components.map((component) => ({
          startToken: component.startToken,
          endToken: component.endToken,
          role: LABEL_TO_ROLE[component.role] ?? component.role,
        })),
      });
    }
  }
  const result = auditPredictions(auditSet, predictions);
  console.log(
    JSON.stringify(
      {
        silentMislabelRate: result.silentMislabelRate,
        correctnessLowerBound: result.correctnessLowerBound,
        counts: result.counts,
        cases: result.cases,
      },
      null,
      2,
    ),
  );
}
