// 静默错标审计器:对「通过校验但标错」建立可执行 oracle。
// 输入是固定审计集与逐 case 终态预测。局部 constraints 只证明局部关系，绝不
// 冒充整句 gold；完整 acceptedAnalyses 必须逐组整体匹配，不能跨答案拼接。
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

const CONSTRAINT_TYPES = new Set([
  "must-not-be-standalone-role",
  "must-cover-together",
  "at-most-one-role",
  "must-not-be-standalone-span",
  "component-exact",
]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSpan(caseId, span, tokenCount) {
  if (
    !Array.isArray(span) ||
    span.length !== 2 ||
    !Number.isInteger(span[0]) ||
    !Number.isInteger(span[1]) ||
    span[0] < 0 ||
    span[1] < span[0]
  ) {
    throw new Error(`${caseId}: invalid token span ${JSON.stringify(span)}`);
  }
  if (span[1] >= tokenCount) {
    throw new Error(
      `${caseId}: token span ${JSON.stringify(span)} is outside token range 0..${tokenCount - 1}`,
    );
  }
}

function validateComponent(caseId, component, tokenCount) {
  if (!isObject(component)) throw new Error(`${caseId}: component must be an object`);
  validateSpan(caseId, [component.startToken, component.endToken], tokenCount);
  if (!ROLES.has(component.role)) throw new Error(`${caseId}: unknown role ${component.role}`);
}

/**
 * 校验审计集自身。tokenize 可选，但生产测试必须传入生产 tokenizer，从实际 text
 * 重算 tokenCount；fixture 的 tokenCount 只能作为防漂移快照，不能自证坐标正确。
 */
export function validateAuditSetV1(value, tokenize) {
  if (!isObject(value)) throw new Error("audit set must be an object");
  if (value.schemaVersion !== "silent-mislabel-audit/v1") throw new Error("schemaVersion mismatch");
  if (!Number.isInteger(value.oracleVersion) || value.oracleVersion < 1) {
    throw new Error("oracleVersion must be a positive integer");
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("cases must be non-empty");
  }

  const seen = new Set();
  for (const auditCase of value.cases) {
    if (!isObject(auditCase) || typeof auditCase.caseId !== "string" || auditCase.caseId === "") {
      throw new Error("caseId required");
    }
    if (seen.has(auditCase.caseId)) throw new Error(`duplicate caseId: ${auditCase.caseId}`);
    seen.add(auditCase.caseId);
    if (typeof auditCase.text !== "string" || auditCase.text === "")
      throw new Error("text required");
    if (
      auditCase.adjudicationStatus !== "adjudicated" &&
      auditCase.adjudicationStatus !== "pending"
    ) {
      throw new Error("adjudicationStatus must be adjudicated|pending");
    }
    const tokens = typeof tokenize === "function" ? tokenize(auditCase.text) : undefined;
    const tokenCount = tokens?.length ?? auditCase.tokenCount;
    if (!Number.isInteger(tokenCount) || tokenCount < 1) {
      throw new Error(`${auditCase.caseId}: tokenCount or tokenizer required`);
    }
    if (
      auditCase.tokenCount !== undefined &&
      tokens !== undefined &&
      auditCase.tokenCount !== tokens.length
    ) {
      throw new Error(
        `${auditCase.caseId}: tokenCount snapshot ${auditCase.tokenCount} != production ${tokens.length}`,
      );
    }
    if (!Array.isArray(auditCase.constraints) || auditCase.constraints.length === 0) {
      throw new Error(`${auditCase.caseId}: constraints must be non-empty`);
    }
    for (const constraint of auditCase.constraints) {
      if (!isObject(constraint) || !CONSTRAINT_TYPES.has(constraint.type)) {
        throw new Error(`${auditCase.caseId}: unknown constraint type ${constraint?.type}`);
      }
      const spans = constraint.tokenSpans ?? (constraint.tokenSpan ? [constraint.tokenSpan] : []);
      if (spans.length === 0 && constraint.type !== "at-most-one-role") {
        throw new Error(`${auditCase.caseId}: constraint lacks tokenSpan(s)`);
      }
      for (const span of spans) validateSpan(auditCase.caseId, span, tokenCount);
      if (constraint.role !== undefined && !ROLES.has(constraint.role)) {
        throw new Error(`${auditCase.caseId}: unknown role ${constraint.role}`);
      }
    }
    if (auditCase.acceptedAnalyses !== undefined) {
      if (!Array.isArray(auditCase.acceptedAnalyses) || auditCase.acceptedAnalyses.length === 0) {
        throw new Error(`${auditCase.caseId}: acceptedAnalyses must be non-empty when present`);
      }
      for (const analysis of auditCase.acceptedAnalyses) {
        if (!Array.isArray(analysis) || analysis.length === 0) {
          throw new Error(`${auditCase.caseId}: accepted analysis must be non-empty`);
        }
        for (const component of analysis)
          validateComponent(auditCase.caseId, component, tokenCount);
      }
    }
  }
  return value;
}

function coveringComponent(components, [start, end]) {
  return components.find((component) => component.startToken <= start && component.endToken >= end);
}

/** 返回首个局部约束违反；null 表示所有局部约束都满足。 */
function constraintViolation(auditCase, components) {
  for (const constraint of auditCase.constraints) {
    if (constraint.type === "must-not-be-standalone-role") {
      const [start, end] = constraint.tokenSpan;
      const component = components.find(
        (candidate) => candidate.startToken === start && candidate.endToken === end,
      );
      if (component?.role === constraint.role) {
        return `tokens [${start}, ${end}] must not stand alone as ${constraint.role}`;
      }
      continue;
    }
    if (constraint.type === "must-cover-together") {
      const holders = constraint.tokenSpans.map((span) => coveringComponent(components, span));
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
        (candidate) => candidate.startToken <= start && candidate.endToken >= end,
      );
      // 只要该 holder 没覆盖语义前驱，就仍是独立引用；不能靠多吞一个句号绕过。
      if (component !== undefined && component.startToken >= start) {
        return `tokens [${start}, ${end}] must not form a standalone component`;
      }
      continue;
    }
    if (constraint.type === "component-exact") {
      const [start, end] = constraint.tokenSpan;
      const component = components.find(
        (candidate) => candidate.startToken === start && candidate.endToken === end,
      );
      if (
        component === undefined ||
        (constraint.role !== undefined && component.role !== constraint.role)
      ) {
        return `tokens [${start}, ${end}] must be exactly one ${constraint.role}`;
      }
    }
  }
  return null;
}

function componentShape(component) {
  return {
    startToken: component.startToken,
    endToken: component.endToken,
    role: component.role,
  };
}

function matchesCompleteAnalysis(components, acceptedAnalyses) {
  if (!Array.isArray(acceptedAnalyses)) return null;
  const prediction = JSON.stringify(components.map(componentShape));
  return acceptedAnalyses.some(
    (analysis) => JSON.stringify(analysis.map(componentShape)) === prediction,
  );
}

/**
 * predictionsByCase value:
 * {runStatus:"not-run"|"not-terminal"|"failed-validation"|"passed",
 *  passedValidation?:boolean, components?:Array<{startToken,endToken,role}>}。
 */
export function auditPredictions(auditSet, predictionsByCase) {
  const cases = [];
  let adjudicatedConstraintPassed = 0;
  let adjudicatedViolating = 0;
  let adjudicatedGoldPassed = 0;

  for (const auditCase of auditSet.cases) {
    const prediction = predictionsByCase.get(auditCase.caseId);
    const base = {
      caseId: auditCase.caseId,
      category: auditCase.category,
      adjudication: auditCase.adjudicationStatus,
    };
    const runStatus = prediction?.runStatus ?? (prediction?.ran === true ? "passed" : "not-run");
    if (runStatus === "not-run") {
      cases.push({ ...base, runStatus, verdict: "not-run" });
      continue;
    }
    if (runStatus === "not-terminal") {
      cases.push({ ...base, runStatus, verdict: "not-terminal" });
      continue;
    }
    if (runStatus === "failed-validation" || prediction?.passedValidation === false) {
      cases.push({ ...base, runStatus: "failed-validation", verdict: "failed-validation" });
      continue;
    }
    if (auditCase.adjudicationStatus === "pending") {
      cases.push({ ...base, runStatus: "passed", verdict: "pending-adjudication" });
      continue;
    }

    const components = prediction?.components ?? [];
    const violation = constraintViolation(auditCase, components);
    if (violation !== null) {
      adjudicatedViolating += 1;
      cases.push({ ...base, runStatus: "passed", verdict: "violates-constraints", violation });
      continue;
    }
    adjudicatedConstraintPassed += 1;

    const completeMatch = matchesCompleteAnalysis(components, auditCase.acceptedAnalyses);
    if (completeMatch === false) {
      adjudicatedViolating += 1;
      cases.push({
        ...base,
        runStatus: "passed",
        verdict: "violates-gold",
        violation: "prediction matches no complete accepted analysis",
      });
      continue;
    }
    if (completeMatch === true) {
      adjudicatedGoldPassed += 1;
      cases.push({ ...base, runStatus: "passed", verdict: "meets-gold", violation: null });
      continue;
    }
    cases.push({ ...base, runStatus: "passed", verdict: "meets-constraints", violation: null });
  }

  const adjudicatedPassed = adjudicatedConstraintPassed + adjudicatedGoldPassed;
  const denominator = adjudicatedPassed + adjudicatedViolating;
  return {
    schemaVersion: "silent-mislabel-audit-report/v1",
    oracleVersion: auditSet.oracleVersion,
    cases,
    silentMislabelRate: denominator === 0 ? null : adjudicatedViolating / denominator,
    // 只有完整 gold 命中才进入“已证明正确”分子；局部约束通过与 pending 都不计。
    correctnessLowerBound: adjudicatedGoldPassed / auditSet.cases.length,
    counts: {
      total: auditSet.cases.length,
      adjudicatedConstraintPassed,
      adjudicatedGoldPassed,
      adjudicatedViolating,
    },
  };
}

export function loadAuditSet(path, tokenize) {
  return validateAuditSetV1(JSON.parse(readFileSync(path, "utf8")), tokenize);
}

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

function normalized(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** 从真机报告建立预测；没有逐句终态证据时宁可 not-terminal，也不推定通过。 */
export function predictionsFromProbeReport(auditSet, report) {
  const predictions = new Map();
  const terminalById = new Map(
    (report.sentenceTerminals ?? []).map((entry) => [entry.sentenceId, entry]),
  );

  for (const auditCase of auditSet.cases) {
    const expectedText = normalized(auditCase.text);
    const matches = [];
    const failures = [];
    for (const card of report.cards ?? []) {
      for (const sentence of card.sentences ?? []) {
        if (normalized(sentence.original) === expectedText) {
          matches.push({ sentence, blockTextFingerprint: card.blockTextFingerprint });
        }
      }
      for (const failure of card.failures ?? []) {
        if (normalized(failure.original) === expectedText) failures.push(failure);
      }
    }
    if (failures.length > 0 && matches.length === 0) {
      predictions.set(auditCase.caseId, {
        runStatus: "failed-validation",
        passedValidation: false,
      });
      continue;
    }
    if (matches.length !== 1) {
      predictions.set(auditCase.caseId, {
        runStatus: matches.length === 0 ? "not-run" : "not-terminal",
      });
      continue;
    }
    const { sentence, blockTextFingerprint } = matches[0];
    const terminal = terminalById.get(sentence.sentenceId);
    if (
      terminal?.phase !== "ready" ||
      (terminal.blockTextFingerprint !== undefined &&
        terminal.blockTextFingerprint !== blockTextFingerprint)
    ) {
      predictions.set(auditCase.caseId, { runStatus: "not-terminal" });
      continue;
    }
    predictions.set(auditCase.caseId, {
      runStatus: "passed",
      passedValidation: true,
      components: sentence.components.map((component) => ({
        startToken: component.startToken,
        endToken: component.endToken,
        role: LABEL_TO_ROLE[component.role] ?? component.role,
      })),
    });
  }
  return predictions;
}

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
  const predictions = predictionsFromProbeReport(auditSet, report);
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
