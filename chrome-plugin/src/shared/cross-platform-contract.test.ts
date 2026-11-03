import contracts from "../../../shared-fixtures/contracts.json";
import promptParity from "../../../shared-fixtures/core-prompt-parity.json";
import { expect, it } from "vitest";
import { CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT } from "../background/analysis-service";
import { buildCorePrompt, CORE_OUTPUT_SHAPE, PROMPT_FIRST_LINES } from "../background/prompts";
import { tokenize } from "../language/segmenter";
import { ERROR_CODES } from "./errors";
import { GRAMMAR_LABELS, GrammarRole } from "./grammar";
import { MAX_SENTENCES_PER_REQUEST } from "./protocol";
import {
  CORE_PROMPT_VERSION,
  CORE_SCHEMA_VERSION,
  DETAIL_PROMPT_VERSION,
  MESSAGE_VERSION,
} from "./versions";

it("pins the shared analysis versions after the mixed-coordination fix", () => {
  // core 20 在 19 的非 FANBOYS 并列口径上把判定改为逐项——混合列表(`A; B; and C`)
  // 里分号隔开的中间项一律 APPOSITIVE,即使末项前有 and;修复轮指令同步改逐项
  // 判定(额外 head 只看紧邻前一个语义成分是不是 FANBOYS 连词)。旧的 core 缓存按
  // 新版本键作废;detail 提示词未动,保持 10。
  expect(CORE_PROMPT_VERSION).toBe(20);
  expect(DETAIL_PROMPT_VERSION).toBe(10);
  expect(CORE_SCHEMA_VERSION).toBe(3);
});

it("keeps the shared IntelliJ contract synchronized", () => {
  expect(contracts).toMatchObject({
    messageVersion: MESSAGE_VERSION,
    coreSchemaVersion: CORE_SCHEMA_VERSION,
    corePromptVersion: CORE_PROMPT_VERSION,
    detailPromptVersion: DETAIL_PROMPT_VERSION,
    maxSentencesPerRequest: MAX_SENTENCES_PER_REQUEST,
    cloudSentencesPerRequest: CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT,
    roles: Object.values(GrammarRole).map((role) => ({ role, label: GRAMMAR_LABELS[role] })),
    errorCodes: ERROR_CODES,
    promptFirstLines: PROMPT_FIRST_LINES,
  });
  expect(CORE_OUTPUT_SHAPE).toContain("Output minified JSON on a single line");
});

/**
 * 两端的核心提示词必须逐字一致:此前只靠人肉同步,一边改了规则、另一边没改，
 * 两个平台就会给出不同粒度的成分，而且没有任何测试会红。fixture 里存的是整段
 * 提示词，所以规则文本、章节顺序、分词结果任何一处分叉都会在这里失败。
 * 改提示词的正确姿势:两端一起改 + 更新 fixture + 升 CORE_PROMPT_VERSION。
 */
it("keeps the core prompt byte-identical to the IntelliJ fixture", () => {
  const { sentenceId, text } = promptParity.sentence;
  const prompt = buildCorePrompt([{ sentenceId, text, tokens: tokenize(text) }]);

  expect(prompt).toBe(promptParity.prompt);
  expect(promptParity.corePromptVersion).toBe(CORE_PROMPT_VERSION);
});
