import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GrammarRole } from "../shared/grammar";
import { validateCoreBatch } from "./analysis-validator";
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
      GrammarRole.CONJUNCTION,
    ]) {
      expect(presentRoles.has(role), role).toBe(true);
    }
    // COORDINATE_CLAUSE 不再要求：并列句现在按同层成分平铺，CONJUNCTION 单独标记
    expect(fixture.sentences.some(({ id }) => id.startsWith("non-finite-"))).toBe(true);
  });

  // 名词短语后紧跟的介词短语必须自成成分(`Four` + `of the biggest US technology companies`)。
  // 黄金集曾三句拆、三句不拆,模型于是学不到口径,把 `of applications` 标成状语;而
  // `the development of applications` 正是技术文档里最高频的结构。
  it("keeps every of-phrase out of the noun-phrase component it modifies", () => {
    const nominalRoles: ReadonlySet<string> = new Set([
      GrammarRole.SUBJECT,
      GrammarRole.OBJECT,
      GrammarRole.PREDICATIVE,
      GrammarRole.COMPLEMENT,
      GrammarRole.ATTRIBUTE,
    ]);
    for (const sentence of fixture.sentences) {
      const tokens = tokenize(sentence.text);
      for (const component of sentence.components) {
        if (!nominalRoles.has(component.role)) continue;
        const words = tokens
          .filter(
            ({ id, punctuation }) =>
              !punctuation && id >= component.startToken && id <= component.endToken,
          )
          .map(({ text }) => text.toLowerCase());
        expect(
          words.indexOf("of"),
          `${sentence.id}: ${component.role} ${component.startToken}-${component.endToken} hides an of-phrase`,
        ).toBeLessThan(1);
      }
    }
  });

  // 黄金集是「正确划分」的定义,所以它必须整份通过生产校验。缺了这条,新增的本地
  // 语法硬门可能反过来把正确答案判非法,把合法分析送进无意义的修复轮——那比漏判更糟。
  it("passes the production core validator sentence by sentence", () => {
    for (const sentence of fixture.sentences) {
      const request = {
        sentenceId: sentence.id,
        text: sentence.text,
        tokens: tokenize(sentence.text),
      };
      const raw = {
        sentences: [
          {
            sentenceId: sentence.id,
            components: sentence.components.map((component) => ({
              ...component,
              translation: "译文",
            })),
          },
        ],
      };
      const result = validateCoreBatch(raw, [request], "profile-1");
      expect(result.ok ? [] : result.errors, `${sentence.id}: ${sentence.text}`).toEqual([]);
    }
  });
});
