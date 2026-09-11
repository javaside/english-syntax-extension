import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GrammarRole } from "../shared/grammar";
import { validateCoreBatch } from "./analysis-validator";
import { tokenize } from "./segmenter";

interface GoldComponent {
  startToken: number;
  endToken: number;
  role: string;
  // teaching/doc 两批历史句子刻意不存 translation,replay 时注入占位译文。
  translation?: string;
}

interface GoldSentence {
  id: string;
  text: string;
  components: GoldComponent[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../shared-fixtures/core-gold-annotations.json", import.meta.url),
    "utf8",
  ),
) as { conventions: string[]; sentences: GoldSentence[] };
const roles = new Set<string>(Object.values(GrammarRole));

describe("core gold annotations", () => {
  it("has explicit conventions and unique sentence identity", () => {
    expect(fixture.conventions.length).toBeGreaterThanOrEqual(4);
    expect(new Set(fixture.sentences.map(({ id }) => id)).size).toBe(fixture.sentences.length);
    expect(new Set(fixture.sentences.map(({ text }) => text)).size).toBe(fixture.sentences.length);
  });

  it("defines fragments as one FRAGMENT_HEAD without fake clause roles and preserves imperatives", () => {
    const conventions = fixture.conventions.join("\n");
    expect(conventions).toMatch(/不成句.*恰好一个 FRAGMENT_HEAD/);
    expect(conventions).toMatch(/不得.*SUBJECT.*PREDICATE.*OBJECT/);
    expect(conventions).toMatch(/祈使句.*PREDICATE/);
    expect(conventions).toMatch(/总体.*不覆盖标点/);
    expect(conventions).toMatch(/fragment-portable-api.*6\.\.14.*例外.*不得推广/);
  });

  it.each([
    [
      "fragment-portable-api",
      [
        { startToken: 0, endToken: 2, role: GrammarRole.FRAGMENT_HEAD },
        { startToken: 3, endToken: 5, role: GrammarRole.ATTRIBUTE },
        { startToken: 6, endToken: 14, role: GrammarRole.ATTRIBUTE },
      ],
    ],
    [
      "fragment-support-apis",
      [
        { startToken: 0, endToken: 0, role: GrammarRole.FRAGMENT_HEAD },
        { startToken: 1, endToken: 5, role: GrammarRole.ATTRIBUTE },
      ],
    ],
    [
      "fragment-compatible-providers",
      [{ startToken: 0, endToken: 5, role: GrammarRole.FRAGMENT_HEAD }],
    ],
    [
      "fragment-building-apps",
      [
        { startToken: 0, endToken: 3, role: GrammarRole.FRAGMENT_HEAD },
        { startToken: 4, endToken: 5, role: GrammarRole.ATTRIBUTE },
      ],
    ],
    [
      "fragment-imperative-counterexample",
      [
        { startToken: 0, endToken: 0, role: GrammarRole.PREDICATE },
        { startToken: 1, endToken: 2, role: GrammarRole.OBJECT },
      ],
    ],
  ] as const)("keeps the human-reviewed component contract for %s", (id, components) => {
    expect(
      fixture.sentences
        .find((sentence) => sentence.id === id)
        ?.components.map(({ startToken, endToken, role }) => ({ startToken, endToken, role })),
    ).toEqual(components);
  });

  it("keeps the imperative counterexample PREDICATE-led and fragment-free", () => {
    const imperative = fixture.sentences.find(
      ({ id }) => id === "fragment-imperative-counterexample",
    );
    expect(imperative?.components[0]?.role).toBe(GrammarRole.PREDICATE);
    expect(imperative?.components.map(({ role }) => role)).not.toContain(GrammarRole.FRAGMENT_HEAD);
  });

  // fragment-relative 放行与页面语料新句型的钉死口径。每条都按 ID 精确断言 token
  // span/role:全量 replay 只证明「validator 合法」,这里的精确表才证明「标注没漂移」。
  it.each([
    [
      "fragment-relative-api",
      [
        { startToken: 0, endToken: 1, role: GrammarRole.FRAGMENT_HEAD },
        { startToken: 2, endToken: 5, role: GrammarRole.ATTRIBUTIVE_CLAUSE },
      ],
    ],
    [
      "full-relative-counterexample",
      [
        { startToken: 0, endToken: 1, role: GrammarRole.SUBJECT },
        { startToken: 2, endToken: 4, role: GrammarRole.ATTRIBUTIVE_CLAUSE },
        { startToken: 5, endToken: 5, role: GrammarRole.PREDICATE },
        { startToken: 6, endToken: 7, role: GrammarRole.OBJECT },
      ],
    ],
    [
      "arxiv-dark-siren-title",
      [
        { startToken: 0, endToken: 2, role: GrammarRole.FRAGMENT_HEAD },
        { startToken: 3, endToken: 6, role: GrammarRole.ATTRIBUTE },
        { startToken: 8, endToken: 11, role: GrammarRole.APPOSITIVE },
        { startToken: 12, endToken: 15, role: GrammarRole.ATTRIBUTE },
      ],
    ],
    [
      "colon-complete-clause-counterexample",
      [
        { startToken: 0, endToken: 1, role: GrammarRole.SUBJECT },
        { startToken: 2, endToken: 2, role: GrammarRole.PREDICATE },
        { startToken: 3, endToken: 3, role: GrammarRole.PREDICATIVE },
        { startToken: 5, endToken: 7, role: GrammarRole.SUBJECT },
        { startToken: 8, endToken: 8, role: GrammarRole.PREDICATE },
        { startToken: 9, endToken: 9, role: GrammarRole.OBJECT },
      ],
    ],
    [
      "page-finite-when-clause",
      [
        { startToken: 0, endToken: 4, role: GrammarRole.SUBJECT },
        { startToken: 5, endToken: 5, role: GrammarRole.PREDICATE },
        { startToken: 6, endToken: 23, role: GrammarRole.ADVERBIAL_CLAUSE },
      ],
    ],
    [
      "page-nonfinite-when-phrase",
      [
        { startToken: 0, endToken: 6, role: GrammarRole.SUBJECT },
        { startToken: 7, endToken: 8, role: GrammarRole.PREDICATE },
        { startToken: 9, endToken: 20, role: GrammarRole.ADVERBIAL },
      ],
    ],
    [
      "page-vp-coordination",
      [
        { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT },
        { startToken: 1, endToken: 1, role: GrammarRole.PREDICATE },
        { startToken: 2, endToken: 3, role: GrammarRole.OBJECT },
        { startToken: 4, endToken: 7, role: GrammarRole.ATTRIBUTE },
        { startToken: 8, endToken: 8, role: GrammarRole.CONJUNCTION },
        { startToken: 9, endToken: 9, role: GrammarRole.PREDICATE },
        { startToken: 10, endToken: 13, role: GrammarRole.OBJECT },
      ],
    ],
    [
      "page-object-control",
      [
        { startToken: 0, endToken: 1, role: GrammarRole.SUBJECT },
        { startToken: 2, endToken: 2, role: GrammarRole.PREDICATE },
        { startToken: 3, endToken: 3, role: GrammarRole.OBJECT },
        { startToken: 4, endToken: 8, role: GrammarRole.COMPLEMENT },
        { startToken: 9, endToken: 9, role: GrammarRole.ADVERBIAL },
        { startToken: 10, endToken: 17, role: GrammarRole.ADVERBIAL },
      ],
    ],
    [
      "page-zero-relative",
      [
        { startToken: 0, endToken: 1, role: GrammarRole.SUBJECT },
        { startToken: 2, endToken: 2, role: GrammarRole.PREDICATE },
        { startToken: 3, endToken: 4, role: GrammarRole.OBJECT },
        { startToken: 6, endToken: 7, role: GrammarRole.SUBJECT },
        { startToken: 8, endToken: 9, role: GrammarRole.PREDICATE },
        { startToken: 10, endToken: 12, role: GrammarRole.COMPLEMENT },
        { startToken: 13, endToken: 16, role: GrammarRole.ATTRIBUTE },
        { startToken: 18, endToken: 18, role: GrammarRole.CONJUNCTION },
        { startToken: 19, endToken: 20, role: GrammarRole.SUBJECT },
        { startToken: 21, endToken: 21, role: GrammarRole.PREDICATE },
        { startToken: 22, endToken: 22, role: GrammarRole.OBJECT },
        { startToken: 23, endToken: 27, role: GrammarRole.ADVERBIAL },
        { startToken: 28, endToken: 39, role: GrammarRole.ATTRIBUTIVE_CLAUSE },
      ],
    ],
    [
      "improved-001",
      [
        { startToken: 0, endToken: 1, role: GrammarRole.SUBJECT },
        { startToken: 2, endToken: 4, role: GrammarRole.ATTRIBUTIVE_CLAUSE },
        { startToken: 5, endToken: 6, role: GrammarRole.PREDICATE },
      ],
    ],
  ] as const)("keeps the reviewed page-coverage contract for %s", (id, components) => {
    expect(
      fixture.sentences
        .find((sentence) => sentence.id === id)
        ?.components.map(({ startToken, endToken, role }) => ({ startToken, endToken, role })),
    ).toEqual(components);
  });

  // spec §5.2:自然语言成分的译文必须带中文释义,专有名词只原样保留、不得整词回显。
  // 「Maven」曾整词回显,正确的形态是「Maven 构建工具」——专名 + 中文类型名。
  // span/role 表是黄金集的契约核心,teaching/doc 两批历史句子刻意不存 translation
  // (replay 注入占位译文),所以全量扫描只约束「写了 translation 的成分」。
  it("does not let a proper-name component echo itself without a Chinese gloss", () => {
    const control = fixture.sentences.find(({ id }) => id === "page-object-control");
    expect(control?.components.find(({ startToken }) => startToken === 3)?.translation).toBe(
      "Maven 构建工具",
    );
    for (const sentence of fixture.sentences) {
      for (const { translation } of sentence.components) {
        if (typeof translation === "string") {
          // 数字/符号区间（'70–80%'）不含汉字属刻意保留,不算回显。
          expect(translation, `${sentence.id}: ${translation}`).toMatch(/\p{Script=Han}|\p{N}/u);
        }
      }
    }
  });

  it("keeps the fixed arXiv title colon uncovered and its four segments separate", () => {
    const title = fixture.sentences.find(({ id }) => id === "arxiv-dark-siren-title");
    expect(title?.components).toHaveLength(4);
    expect(
      title?.components.every(({ startToken, endToken }) => startToken !== 7 && endToken !== 7),
    ).toBe(true);
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
      GrammarRole.APPOSITIVE,
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
