import contracts from "../../../shared-fixtures/contracts.json";
import { expect, it } from "vitest";
import { CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT } from "../background/analysis-service";
import { CORE_OUTPUT_SHAPE, PROMPT_FIRST_LINES } from "../background/prompts";
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
