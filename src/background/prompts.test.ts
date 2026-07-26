import { describe, expect, it } from "vitest";
import { GrammarRole } from "../shared/grammar";
import type { CoreAnalysis } from "../shared/grammar";
import { tokenize } from "../language/segmenter";
import type { SentenceInput } from "../shared/protocol";
import {
  buildCorePrompt,
  buildDetailPrompt,
  buildRepairPrompt,
  buildSentenceDetailsPrompt,
} from "./prompts";

const sentence: SentenceInput = {
  sentenceId: "sentence-1",
  text: "Learners read books daily.",
  tokens: [
    { id: 0, text: "Learners", start: 0, end: 8, leadingWhitespace: "", punctuation: false },
    { id: 1, text: "read", start: 9, end: 13, leadingWhitespace: " ", punctuation: false },
    { id: 2, text: "books", start: 14, end: 19, leadingWhitespace: " ", punctuation: false },
    { id: 3, text: "daily", start: 20, end: 25, leadingWhitespace: " ", punctuation: false },
    { id: 4, text: ".", start: 25, end: 26, leadingWhitespace: "", punctuation: true },
  ],
};

const core: CoreAnalysis = {
  schemaVersion: 1,
  sentenceId: sentence.sentenceId,
  components: [
    { startToken: 0, endToken: 1, role: GrammarRole.SUBJECT, translation: "主语" },
    { startToken: 3, endToken: 4, role: GrammarRole.ADVERBIAL, translation: "状语" },
  ],
  modelProfileId: "profile-1",
};

const paragraph =
  "The committee that had been reviewing the proposal for several months finally announced " +
  "its decision, and the researchers who had submitted the application were notified by email.";

function paragraphSentence(): SentenceInput {
  return { sentenceId: "paragraph-1", text: paragraph, tokens: tokenize(paragraph) };
}

describe("model-facing sentence payload", () => {
  it("drops the character offsets and whitespace the model cannot address", () => {
    const prompt = buildCorePrompt([sentence]);

    expect(prompt).not.toContain("leadingWhitespace");
    expect(prompt).not.toContain('"start":');
    expect(prompt).not.toContain('"end":');
  });

  it("keeps every token id paired with its text", () => {
    const prompt = buildCorePrompt([sentence]);

    for (const token of sentence.tokens) {
      expect(prompt).toContain(`{"id":${token.id},"text":${JSON.stringify(token.text)}`);
    }
  });

  it("still flags punctuation tokens so the coverage rule stays checkable", () => {
    const prompt = buildCorePrompt([sentence]);

    expect(prompt).toContain('{"id":4,"text":".","punctuation":true}');
    expect(prompt).toContain('{"id":0,"text":"Learners"}');
  });

  // Guards the regression this fix exists for: the full pretty-printed Token
  // record put the payload around 30x the source text, which every core,
  // repair, and detail call paid for in prefill latency.
  it("keeps the token payload under eight times the source text", () => {
    const input = paragraphSentence();
    const prompt = buildCorePrompt([input]);
    const payload = prompt.slice(prompt.indexOf("Numbered sentence requests:"));

    expect(payload.length).toBeLessThan(paragraph.length * 8);
  });

  it("reuses the same compact payload in every prompt that carries a sentence", () => {
    const focus = { startToken: 0, endToken: 1 };
    const prompts = [
      buildRepairPrompt([sentence], [{ path: "sentences[0]", message: "bad" }], {}),
      buildDetailPrompt(sentence, core, focus),
      buildSentenceDetailsPrompt(sentence, core, [focus]),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toContain("leadingWhitespace");
      expect(prompt).toContain('{"id":0,"text":"Learners"}');
    }
  });
});

describe("buildSentenceDetailsPrompt", () => {
  it("lists only the requested focus ranges and ends with them", () => {
    const prompt = buildSentenceDetailsPrompt(sentence, core, [
      { startToken: 0, endToken: 1 },
      { startToken: 3, endToken: 4 },
    ]);
    expect(prompt.startsWith("Explain each requested grammatical component")).toBe(true);
    expect(prompt).toContain('"details"');
    const focusSection = prompt.split("Requested focus ranges:")[1]!;
    expect(JSON.parse(focusSection.trim())).toEqual([
      { startToken: 0, endToken: 1 },
      { startToken: 3, endToken: 4 },
    ]);
  });
});
