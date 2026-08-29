import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GrammarRole } from "../shared/grammar";
import { tokenize } from "./segmenter";

interface GoldComponent {
  startToken: number;
  endToken: number;
  role: string;
}

interface GoldSentence {
  id: string;
  text: string;
  components: GoldComponent[];
}

const fixture = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/core-gold-annotations.json", import.meta.url), "utf8"),
) as { conventions: string[]; sentences: GoldSentence[] };
const roles = new Set<string>(Object.values(GrammarRole));

describe("core gold annotations", () => {
  it("has explicit conventions and unique sentence identity", () => {
    expect(fixture.conventions.length).toBeGreaterThanOrEqual(4);
    expect(new Set(fixture.sentences.map(({ id }) => id)).size).toBe(fixture.sentences.length);
    expect(new Set(fixture.sentences.map(({ text }) => text)).size).toBe(fixture.sentences.length);
  });

  it("uses component token IDs from the production tokenizer", () => {
    for (const sentence of fixture.sentences) {
      const tokens = tokenize(sentence.text);
      expect(
        tokens.map(({ id }) => id),
        sentence.id,
      ).toEqual(Array.from({ length: tokens.length }, (_, id) => id));
      for (const component of sentence.components) {
        expect(tokens[component.startToken], `${sentence.id}: start token`).toBeDefined();
        expect(tokens[component.endToken], `${sentence.id}: end token`).toBeDefined();
      }
    }
  });

  it("uses legal ordered spans that cover every lexical token exactly once", () => {
    for (const sentence of fixture.sentences) {
      const tokens = tokenize(sentence.text);
      let previousEnd = -1;
      for (const component of sentence.components) {
        expect(roles.has(component.role), `${sentence.id}: ${component.role}`).toBe(true);
        expect(component.startToken, sentence.id).toBeGreaterThan(previousEnd);
        expect(component.endToken, sentence.id).toBeGreaterThanOrEqual(component.startToken);
        expect(component.endToken, sentence.id).toBeLessThan(tokens.length);
        expect(
          tokens
            .slice(component.startToken, component.endToken + 1)
            .some(({ punctuation }) => !punctuation),
          `${sentence.id}: punctuation-only component ${component.startToken}-${component.endToken}`,
        ).toBe(true);
        previousEnd = component.endToken;
      }

      for (const token of tokens.filter(({ punctuation }) => !punctuation)) {
        const coverage = sentence.components.filter(
          ({ startToken, endToken }) => startToken <= token.id && token.id <= endToken,
        );
        expect(
          coverage,
          `${sentence.id}: uncovered/duplicate token ${token.id} ${token.text}`,
        ).toHaveLength(1);
      }
    }
  });

  it("covers core simple, clause, coordination, and non-finite categories", () => {
    const presentRoles = new Set(
      fixture.sentences.flatMap(({ components }) => components.map(({ role }) => role)),
    );
    for (const role of [
      GrammarRole.SUBJECT,
      GrammarRole.PREDICATE,
      GrammarRole.OBJECT,
      GrammarRole.PREDICATIVE,
      GrammarRole.COMPLEMENT,
      GrammarRole.ATTRIBUTE,
      GrammarRole.SUBJECT_CLAUSE,
      GrammarRole.OBJECT_CLAUSE,
      GrammarRole.ATTRIBUTIVE_CLAUSE,
      GrammarRole.ADVERBIAL_CLAUSE,
      GrammarRole.COORDINATE_CLAUSE,
      GrammarRole.CONJUNCTION,
    ]) {
      expect(presentRoles.has(role), role).toBe(true);
    }
    expect(fixture.sentences.some(({ id }) => id.startsWith("non-finite-"))).toBe(true);
  });
});
