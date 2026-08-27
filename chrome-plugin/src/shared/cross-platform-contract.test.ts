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
