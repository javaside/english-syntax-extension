import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { GrammarRole } from "../shared/grammar";
import { CORE_SCHEMA_VERSION } from "../shared/versions";
import type { TokenRange } from "../shared/grammar";
import type { SentenceInput } from "../shared/protocol";
import { validateCoreBatch, validateDetail, HAN_PATTERN } from "./analysis-validator";
import { tokenize } from "./segmenter";

const request: SentenceInput = {
  sentenceId: "sentence-1",
  text: "Learners read books.",
  tokens: [
    { id: 0, text: "Learners", start: 0, end: 8, leadingWhitespace: "", punctuation: false },
    { id: 1, text: "read", start: 9, end: 13, leadingWhitespace: " ", punctuation: false },
    { id: 2, text: "books", start: 14, end: 19, leadingWhitespace: " ", punctuation: false },
    { id: 3, text: ".", start: 19, end: 20, leadingWhitespace: "", punctuation: true },
  ],
};

const rawCore = {
  sentences: [
    {
      sentenceId: "sentence-1",
      components: [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "学习者" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
        { startToken: 2, endToken: 3, role: "OBJECT", translation: "书籍" },
      ],
    },
  ],
};

const expectedAnalysis = {
  schemaVersion: CORE_SCHEMA_VERSION,
  sentenceId: "sentence-1",
  components: [
    { startToken: 0, endToken: 0, role: GrammarRole.SUBJECT, translation: "学习者" },
    { startToken: 1, endToken: 1, role: GrammarRole.PREDICATE, translation: "阅读" },
    { startToken: 2, endToken: 3, role: GrammarRole.OBJECT, translation: "书籍" },
  ],
  modelProfileId: "profile-1",
};

function invalidCore(raw: unknown) {
  const result = validateCoreBatch(raw, [request], "profile-1");
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected invalid core output");
  }
  return result.errors;
}

function countStringSetMembers(source: string, constantName: string): number {
  const sourceFile = ts.createSourceFile("word-lists.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === constantName);
  expect(declaration, `missing source set ${constantName}`).toBeDefined();

  const initializer = declaration?.initializer;
  expect(
    initializer !== undefined &&
      ts.isNewExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === "Set" &&
      initializer.arguments?.length === 1 &&
      ts.isArrayLiteralExpression(initializer.arguments[0]!),
    `source set ${constantName} must use new Set([...])`,
  ).toBe(true);

  const elements = (initializer as ts.NewExpression).arguments![0] as ts.ArrayLiteralExpression;
  for (const element of elements.elements) {
    if (!ts.isStringLiteral(element)) {
      throw new Error(
        `unsupported initializer element in source set ${constantName}: ${element.getText(sourceFile)}`,
      );
    }
  }
  return elements.elements.length;
}

describe("validator word list source guards", () => {
  it("rejects unsupported set initializer elements instead of silently undercounting", () => {
    const source = `
      const TEST_WORDS: ReadonlySet<string> = new Set([
        "one",
        ...OTHER_WORDS,
        "two",
      ]);
    `;

    expect(() => countStringSetMembers(source, "TEST_WORDS")).toThrow(/unsupported initializer/i);
  });

  it("keeps the six shared word list sizes pinned to the Kotlin baseline", () => {
    const source = readFileSync(new URL("./analysis-validator.ts", import.meta.url), "utf8");

    expect({
      coordinatingConjunctions: countStringSetMembers(source, "COORDINATING_CONJUNCTIONS"),
      prepositions: countStringSetMembers(source, "PREPOSITIONS"),
      subjectPronouns: countStringSetMembers(source, "SUBJECT_PRONOUNS"),
      determiners: countStringSetMembers(source, "DETERMINERS"),
      subordinatingConjunctions: countStringSetMembers(source, "SUBORDINATING_CONJUNCTIONS"),
      objectRequiringPrepositions: countStringSetMembers(source, "OBJECT_REQUIRING_PREPOSITIONS"),
      clauseOnlyConjunctions: countStringSetMembers(source, "CLAUSE_ONLY_CONJUNCTIONS"),
      subjectClauseIntroducers: countStringSetMembers(source, "SUBJECT_CLAUSE_INTRODUCERS"),
    }).toEqual({
      coordinatingConjunctions: 7,
      prepositions: 15,
      subjectPronouns: 7,
      determiners: 13,
      subordinatingConjunctions: 21,
      objectRequiringPrepositions: 11,
      clauseOnlyConjunctions: 5,
      subjectClauseIntroducers: 15,
    });
  });
});

describe("core analysis validation", () => {
  it("accepts complete, ordered core coverage", () => {
    const result = validateCoreBatch(rawCore, [request], "profile-1");
    expect(result).toEqual({ ok: true, value: [expectedAnalysis] });
  });

  // 坐标系回归:错误路径必须是模型所见 JSON 的原始 components 下标。
  // "The service works well." tokenize 后:0 The / 1 service / 2 works / 3 well / 4 .(p)
  const rawIndexSentence: SentenceInput = {
    sentenceId: "raw-index-1",
    text: "The service works well.",
    tokens: tokenize("The service works well."),
  };

  function rawIndexCore(components: unknown[]): unknown {
    return { sentences: [{ sentenceId: rawIndexSentence.sentenceId, components }] };
  }

  it("错误路径索引是原始数组下标,不受纯标点成分影响", () => {
    // 原始下标 0 是纯标点成分(被跳过);SUBJECT 合法(有中文),只有原始下标 2
    // 的 PREDICATE 回显英文。旧实现报 components[1],新实现必须报 components[2]。
    const result = validateCoreBatch(
      rawIndexCore([
        { startToken: 4, endToken: 4, role: "PUNCTUATION", translation: "。" },
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "works well" },
      ]),
      [rawIndexSentence],
      "profile-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((error) => error.path);
    expect(paths).toContain("sentences[0].components[2].translation");
    expect(paths).not.toContain("sentences[0].components[1].translation");
    expect(paths).not.toContain("sentences[0].components[0].translation");
  });

  it("接受集合与成功成分不受坐标改动影响", () => {
    const valid = validateCoreBatch(
      rawIndexCore([
        { startToken: 4, endToken: 4, role: "PUNCTUATION", translation: "。" },
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "运转良好" },
      ]),
      [rawIndexSentence],
      "profile-1",
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    // 返回的是纯 CoreComponent,不携带 rawIndex 等内部坐标。
    expect(valid.value[0]!.components).toEqual([
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "服务" },
      { startToken: 2, endToken: 3, role: "PREDICATE", translation: "运转良好" },
    ]);
  });

  it("非法元素(非对象)不被当作纯标点跳过,仍报 must be an object", () => {
    const result = validateCoreBatch(
      rawIndexCore([
        "not-an-object",
        { startToken: 0, endToken: 3, role: "SUBJECT", translation: "服务运转良好" },
      ]),
      [rawIndexSentence],
      "profile-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "sentences[0].components[0]",
      message: "must be an object",
    });
  });

  it("全纯标点成分仍被拒绝", () => {
    const result = validateCoreBatch(
      rawIndexCore([{ startToken: 4, endToken: 4, role: "PUNCTUATION", translation: "。" }]),
      [rawIndexSentence],
      "profile-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "sentences[0].components",
      message: "must contain a non-punctuation component",
    });
  });

  it("reports the exact path and message for an uncovered lexical token", () => {
    const raw = structuredClone(rawCore);
    raw.sentences[0]!.components.splice(2, 1);

    expect(invalidCore(raw)).toContainEqual({
      path: "sentences[0].components",
      message: "non-punctuation token 2 is not covered",
    });
  });

  it.each([
    [
      "overlapping components",
      [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "学习者" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
        { startToken: 2, endToken: 3, role: "OBJECT", translation: "书籍" },
      ],
    ],
    [
      "a reversed interval",
      [
        { startToken: 1, endToken: 0, role: "SUBJECT", translation: "学习者" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
        { startToken: 2, endToken: 3, role: "OBJECT", translation: "书籍" },
      ],
    ],
    [
      "an out-of-range interval",
      [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "学习者" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
        { startToken: 2, endToken: 4, role: "OBJECT", translation: "书籍" },
      ],
    ],
    [
      "an unknown role",
      [
        { startToken: 0, endToken: 0, role: "COMMAND", translation: "学习者" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
        { startToken: 2, endToken: 3, role: "OBJECT", translation: "书籍" },
      ],
    ],
    [
      "an empty translation",
      [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "  " },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
        { startToken: 2, endToken: 3, role: "OBJECT", translation: "书籍" },
      ],
    ],
  ])("rejects %s", (_description, components) => {
    invalidCore({ sentences: [{ sentenceId: "sentence-1", components }] });
  });

  it("drops punctuation-only components before core validation", () => {
    const result = validateCoreBatch(
      {
        sentences: [
          {
            sentenceId: request.sentenceId,
            components: [
              { startToken: 0, endToken: 0, role: "SUBJECT", translation: "学习者" },
              { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
              { startToken: 2, endToken: 2, role: "OBJECT", translation: "书籍" },
              { startToken: 3, endToken: 3, role: "INDEPENDENT_ELEMENT", translation: "句号" },
            ],
          },
        ],
      },
      [request],
      "profile-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]!.components).toHaveLength(3);
  });

  it("rejects an all-punctuation component list after pre-filtering", () => {
    const punctuationRequest: SentenceInput = {
      sentenceId: "punctuation-only",
      text: "...",
      tokens: tokenize("..."),
    };
    const result = validateCoreBatch(
      {
        sentences: [
          {
            sentenceId: punctuationRequest.sentenceId,
            components: [
              { startToken: 0, endToken: 0, role: "INDEPENDENT_ELEMENT", translation: "省略号" },
            ],
          },
        ],
      },
      [punctuationRequest],
      "profile-1",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: "sentences[0].components",
        message: "must contain a non-punctuation component",
      });
    }
  });

  it("rejects a translation over the sentence-relative limit", () => {
    const raw = structuredClone(rawCore);
    raw.sentences[0]!.components[0]!.translation = "译".repeat(501);
    invalidCore(raw);
  });

  it("keeps original component indexes in diagnostics after a malformed component", () => {
    const errors = invalidCore({
      sentences: [
        {
          sentenceId: "sentence-1",
          components: [null, { startToken: 4, endToken: 4, role: "SUBJECT", translation: "越界" }],
        },
      ],
    });

    expect(errors).toContainEqual({
      path: "sentences[0].components[1]",
      message: "token interval is outside the original sentence",
    });
  });

  it("rejects an extra sentence ID", () => {
    invalidCore({
      sentences: [
        ...rawCore.sentences,
        { sentenceId: "sentence-not-requested", components: rawCore.sentences[0]!.components },
      ],
    });
  });

  it.each(["<script>alert(1)</script>", "<IFRAME src=x>", "javascript:alert(1)", "safe\0unsafe"])(
    "rejects script-like translation %j",
    (translation) => {
      const raw = structuredClone(rawCore);
      raw.sentences[0]!.components[0]!.translation = translation;
      invalidCore(raw);
    },
  );
});

/**
 * 提示词里的粒度规则,凡本地能判定的都在这里变成硬校验:只写在 prompt 里的约束,
 * 模型违反了没人拦,坏划分直接写进缓存并长期显示。校验失败会走已有的修复轮,
 * 所以错误文案本身就是发给模型的修复指令,必须写成「该怎么做」而不只是「哪里错」。
 */
describe("core analysis grammar constraints", () => {
  function sentenceOf(text: string): SentenceInput {
    return { sentenceId: "grammar-1", text, tokens: tokenize(text) };
  }

  // 文本 tokenize：0 The / 1 API / 2 that / 3 returns / 4 JSON / 5 responses /
  // 6 ,(p) / 7 an / 8 object / 9 .(p)
  const adjacency: SentenceInput = {
    sentenceId: "adjacency-1",
    text: "The API that returns JSON responses, an object.",
    tokens: tokenize("The API that returns JSON responses, an object."),
  };

  it("保行为:定语从句后接宾语仍被拒(纯标点成分在中间不影响)", () => {
    const result = validateCoreBatch(
      {
        sentences: [
          {
            sentenceId: adjacency.sentenceId,
            components: [
              { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该 API" },
              {
                startToken: 2,
                endToken: 5,
                role: "ATTRIBUTIVE_CLAUSE",
                translation: "返回 JSON 响应的",
              },
              { startToken: 6, endToken: 6, role: "PUNCTUATION", translation: "，" },
              { startToken: 7, endToken: 8, role: "OBJECT", translation: "一个对象" },
            ],
          },
        ],
      },
      [adjacency],
      "profile-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const grammar = result.errors.find((e) => e.message.includes("ATTRIBUTIVE_CLAUSE"));
    expect(grammar).toBeDefined();
    // 从句在原始下标 1（下标 0 是 SUBJECT）；标点成分在从句之后，不改变从句路径。
    expect(grammar!.path).toBe("sentences[0].components[1]");
  });

  it("RED:从句之前插入纯标点成分后,grammar 错误路径随 rawIndex 平移", () => {
    const result = validateCoreBatch(
      {
        sentences: [
          {
            sentenceId: adjacency.sentenceId,
            // 原始下标 0 是纯标点成分(被跳过);从句现在位于原始下标 2。
            components: [
              { startToken: 9, endToken: 9, role: "PUNCTUATION", translation: "。" },
              { startToken: 0, endToken: 1, role: "SUBJECT", translation: "该 API" },
              {
                startToken: 2,
                endToken: 5,
                role: "ATTRIBUTIVE_CLAUSE",
                translation: "返回 JSON 响应的",
              },
              { startToken: 7, endToken: 8, role: "OBJECT", translation: "一个对象" },
            ],
          },
        ],
      },
      [adjacency],
      "profile-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const grammar = result.errors.find((e) => e.message.includes("ATTRIBUTIVE_CLAUSE"));
    expect(grammar).toBeDefined();
    // 旧实现报 components[1]（过滤后下标），新实现必须报 components[2]。
    expect(grammar!.path).toBe("sentences[0].components[2]");
  });

  function grammarErrors(sentence: SentenceInput, components: readonly unknown[]) {
    const result = validateCoreBatch(
      { sentences: [{ sentenceId: sentence.sentenceId, components }] },
      [sentence],
      "profile-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid core output");
    return result.errors;
  }

  it("reports unknown fields and adjacent PREDICATE grammar errors together", () => {
    const sentence = sentenceOf("Help turn ideas.");
    const errors = grammarErrors(sentence, [
      { startToken: 0, endToken: 0, role: "PREDICATE", translation: "帮助", unexpected: true },
      { startToken: 1, endToken: 1, role: "PREDICATE", translation: "转化" },
      { startToken: 2, endToken: 3, role: "OBJECT", translation: "想法" },
    ]);

    expect(errors).toContainEqual({
      path: "sentences[0].components[0]",
      message: "contains unknown fields",
    });
    expect(errors).toContainEqual({
      path: "sentences[0].components[1]",
      message:
        "adjacent PREDICATE components must be merged into one PREDICATE covering the whole verb group",
    });
  });

  it("rejects two adjacent PREDICATE components and says to merge the verb group", () => {
    // "Help turn ideas" 实测被切成 Help / turn 两个谓语——PREDICATE_SCOPE_RULE 明令禁止。
    const sentence = sentenceOf("Help turn ideas.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 0, role: "PREDICATE", translation: "帮助" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "转化" },
        { startToken: 2, endToken: 3, role: "OBJECT", translation: "想法" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[1]",
      message:
        "adjacent PREDICATE components must be merged into one PREDICATE covering the whole verb group",
    });
  });

  it("accepts two PREDICATE components separated by another component", () => {
    const sentence = sentenceOf("Readers read books and writers revise drafts.");

    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                { startToken: 0, endToken: 0, role: "SUBJECT", translation: "读者" },
                { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
                { startToken: 2, endToken: 2, role: "OBJECT", translation: "书籍" },
                { startToken: 3, endToken: 3, role: "CONJUNCTION", translation: "并且" },
                { startToken: 4, endToken: 4, role: "SUBJECT", translation: "作者" },
                { startToken: 5, endToken: 5, role: "PREDICATE", translation: "修订" },
                { startToken: 6, endToken: 7, role: "OBJECT", translation: "草稿" },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("rejects a bare preposition component and says to absorb its object", () => {
    // 实测 "into fully formed designs" 被拆成介词 + 名词短语,后者还误标 ATTRIBUTE。
    const sentence = sentenceOf("Turn ideas into designs.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 0, role: "PREDICATE", translation: "转化" },
        { startToken: 1, endToken: 1, role: "OBJECT", translation: "想法" },
        { startToken: 2, endToken: 2, role: "ADVERBIAL", translation: "变成" },
        { startToken: 3, endToken: 4, role: "ATTRIBUTE", translation: "设计稿" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[2]",
      message:
        "a preposition must be merged with the phrase it governs instead of forming its own component",
    });
  });

  it.each([
    [
      "over as PREDICATIVE",
      "The meeting is over.",
      [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "会议" },
        { startToken: 2, endToken: 2, role: "PREDICATE", translation: "结束了" },
        { startToken: 3, endToken: 4, role: "PREDICATIVE", translation: "结束" },
      ],
    ],
    [
      "down as ADVERBIAL",
      "Prices went down.",
      [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "价格" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "下降" },
        { startToken: 2, endToken: 3, role: "ADVERBIAL", translation: "向下" },
      ],
    ],
    [
      "sentence-final since as ADVERBIAL",
      "I have wondered since.",
      [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "我" },
        { startToken: 1, endToken: 2, role: "PREDICATE", translation: "一直想知道" },
        { startToken: 3, endToken: 4, role: "ADVERBIAL", translation: "从那以后" },
      ],
    ],
    [
      "beneath as ADVERBIAL",
      "The layer lies beneath.",
      [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "这一层" },
        { startToken: 2, endToken: 2, role: "PREDICATE", translation: "位于" },
        { startToken: 3, endToken: 4, role: "ADVERBIAL", translation: "下方" },
      ],
    ],
    [
      "throughout as ADVERBIAL",
      "Claude uses tools throughout.",
      [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "Claude 助手" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "使用" },
        { startToken: 2, endToken: 2, role: "OBJECT", translation: "工具" },
        { startToken: 3, endToken: 4, role: "ADVERBIAL", translation: "全程" },
      ],
    ],
  ])("accepts %s", (_description, text, components) => {
    const sentence = sentenceOf(text);
    expect(
      validateCoreBatch(
        { sentences: [{ sentenceId: sentence.sentenceId, components }] },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("rejects a CONJUNCTION that covers no coordinating conjunction", () => {
    const sentence = sentenceOf("Readers read books.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "读者" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
        { startToken: 2, endToken: 3, role: "CONJUNCTION", translation: "书籍" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[2]",
      message:
        "CONJUNCTION must cover a coordinating conjunction (for, and, nor, but, or, yet, so)",
    });
  });

  const PREDICATE_HEAD_MESSAGE =
    "a PREDICATE must begin with the verb group; move the leading subject or noun phrase " +
    "into its own component";
  const PREDICATE_SWALLOW_MESSAGE =
    "a PREDICATE must cover only the verb group; emit the noun phrase that starts at the " +
    "determiner as its own OBJECT, PREDICATIVE, or COMPLEMENT component";
  const WHOLE_SENTENCE_MESSAGE =
    "one component must not cover the whole sentence; split it into peer components " +
    "(subject, predicate, object, adverbial, …)";
  const DUPLICATE_FRAGMENT_HEAD_MESSAGE =
    "a non-clausal fragment must contain at most one FRAGMENT_HEAD";
  const MIXED_FRAGMENT_ROLE_MESSAGE =
    "FRAGMENT_HEAD marks a non-clausal fragment and must not be mixed with clause-level " +
    "SUBJECT, PREDICATE, OBJECT, PREDICATIVE, COMPLEMENT, SUBJECT_CLAUSE, OBJECT_CLAUSE, " +
    "PREDICATIVE_CLAUSE, ADVERBIAL_CLAUSE, or the deprecated COORDINATE_CLAUSE; a whole " +
    "ATTRIBUTIVE_CLAUSE is the only clause role allowed beside a FRAGMENT_HEAD";

  it("accepts a non-clausal fragment with one FRAGMENT_HEAD and modifiers", () => {
    const sentence = sentenceOf(
      "Portable API support across AI providers for Chat, text-to-image, and Embedding models.",
    );
    const components = [
      {
        startToken: 0,
        endToken: 2,
        role: "FRAGMENT_HEAD",
        translation: "可移植 API 支持",
      },
      { startToken: 3, endToken: 5, role: "ATTRIBUTE", translation: "跨 AI 提供商" },
      {
        startToken: 6,
        endToken: 14,
        role: "ATTRIBUTE",
        translation: "面向聊天、文生图和嵌入模型",
      },
    ];

    expect(
      validateCoreBatch(
        { sentences: [{ sentenceId: sentence.sentenceId, components }] },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("accepts one FRAGMENT_HEAD covering a whole multi-word fragment", () => {
    const sentence = sentenceOf("Portable API support across providers.");

    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                {
                  startToken: 0,
                  endToken: 5,
                  role: "FRAGMENT_HEAD",
                  translation: "跨提供商的可移植 API 支持",
                },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("rejects more than one FRAGMENT_HEAD", () => {
    const sentence = sentenceOf("Portable API support across providers.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 1, role: "FRAGMENT_HEAD", translation: "可移植 API" },
        { startToken: 2, endToken: 5, role: "FRAGMENT_HEAD", translation: "跨提供商支持" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components",
      message: DUPLICATE_FRAGMENT_HEAD_MESSAGE,
    });
  });

  it.each([
    "SUBJECT",
    "PREDICATE",
    "OBJECT",
    "PREDICATIVE",
    "COMPLEMENT",
    "SUBJECT_CLAUSE",
    "OBJECT_CLAUSE",
    "PREDICATIVE_CLAUSE",
    "ADVERBIAL_CLAUSE",
    "COORDINATE_CLAUSE",
  ])(`rejects FRAGMENT_HEAD mixed with %s`, (forbiddenRole) => {
    const sentence = sentenceOf("Portable support works well.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 1, role: "FRAGMENT_HEAD", translation: "可移植支持" },
        { startToken: 2, endToken: 4, role: forbiddenRole, translation: "运行良好" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components",
      message: MIXED_FRAGMENT_ROLE_MESSAGE,
    });
  });

  it("accepts a fragment head followed by a whole attributive clause", () => {
    // fragment-relative:不成句的名词片段后跟一个完整定语从句——从句从引导词一直
    // 覆盖到它自己的宾语,不得为了「片段不能混从句」把它拆进主句层。
    const sentence = sentenceOf("An API that returns JSON responses.");

    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                { startToken: 0, endToken: 1, role: "FRAGMENT_HEAD", translation: "一个 API" },
                {
                  startToken: 2,
                  endToken: 5,
                  role: "ATTRIBUTIVE_CLAUSE",
                  translation: "返回 JSON 响应的",
                },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("keeps rejecting a fragment head followed by a truncated attributive clause", () => {
    // 放行只针对「完整从句」:只标引导词依旧被从句最小长度门拦住,从句内部成分
    // 平铺出去依旧被 follower 门拦住——十五条硬门的其余部分不因这条放行而松动。
    const sentence = sentenceOf("An API that returns JSON responses.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 1, role: "FRAGMENT_HEAD", translation: "一个 API" },
        { startToken: 2, endToken: 2, role: "ATTRIBUTIVE_CLAUSE", translation: "引导词" },
        { startToken: 3, endToken: 5, role: "PREDICATE", translation: "返回 JSON 响应" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[1]",
      message: CLAUSE_INTRODUCER_ONLY_MESSAGE,
    });
  });

  it("rejects a PREDICATE that starts with a subject pronoun", () => {
    // deepseek-chat 实测输出:整句只有 PREDICATE + 状语从句,主语 "She" 被吞进谓语。
    const sentence = sentenceOf("She kept practicing until the melody sounded effortless.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 2, role: "PREDICATE", translation: "持续练习" },
        { startToken: 3, endToken: 7, role: "ADVERBIAL_CLAUSE", translation: "直到旋律毫不费力" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[0]",
      message: PREDICATE_HEAD_MESSAGE,
    });
  });

  it("rejects a PREDICATE that starts with a determiner", () => {
    const sentence = sentenceOf("The ancient bridge was rebuilt by local craftsmen.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 4, role: "PREDICATE", translation: "古桥被重建" },
        { startToken: 5, endToken: 7, role: "ADVERBIAL", translation: "由当地工匠" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[0]",
      message: PREDICATE_HEAD_MESSAGE,
    });
  });

  it("accepts an imperative clause whose PREDICATE carries no subject", () => {
    // 祈使句本来就没有主语,所以缺主语不能直接判非法——只判「谓语开头不可能是动词」。
    const sentence = sentenceOf("Help turn ideas into designs.");

    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                { startToken: 0, endToken: 1, role: "PREDICATE", translation: "帮助转化" },
                { startToken: 2, endToken: 2, role: "OBJECT", translation: "想法" },
                { startToken: 3, endToken: 4, role: "ADVERBIAL", translation: "变成设计稿" },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("accepts a multi-word verb group that begins with a modal", () => {
    const sentence = sentenceOf("The documents must be archived immediately.");

    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                { startToken: 0, endToken: 1, role: "SUBJECT", translation: "这些文件" },
                { startToken: 2, endToken: 4, role: "PREDICATE", translation: "必须被归档" },
                { startToken: 5, endToken: 5, role: "ADVERBIAL", translation: "立即" },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("rejects a PREDICATE that swallows the object noun phrase", () => {
    // PEER_COMPONENT_RULE 只写在提示词里时没人拦:"writes the reports" 会整体标成谓语。
    const sentence = sentenceOf("Maria writes the reports every Friday.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "玛丽亚" },
        { startToken: 1, endToken: 3, role: "PREDICATE", translation: "撰写报告" },
        { startToken: 4, endToken: 5, role: "ADVERBIAL", translation: "每周五" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[1]",
      message: PREDICATE_SWALLOW_MESSAGE,
    });
  });

  it("accepts a PREDICATE that ends with the complementizer that", () => {
    // "that" 刻意不算限定词:它更常是宾语从句引导词,误拒的代价高于让粒度差一个词。
    const sentence = sentenceOf("The manager announced that the factory would close.");

    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                { startToken: 0, endToken: 1, role: "SUBJECT", translation: "经理" },
                { startToken: 2, endToken: 3, role: "PREDICATE", translation: "宣布" },
                { startToken: 4, endToken: 7, role: "OBJECT_CLAUSE", translation: "工厂将要关闭" },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("rejects one component covering the whole sentence whatever its role", () => {
    // 现有规则只拦 COORDINATE_CLAUSE;换成 SUBJECT 就一路通过,卡片退化成一整块译文。
    const sentence = sentenceOf("The young engineer fixed the broken printer this morning.");

    expect(
      grammarErrors(sentence, [
        {
          startToken: 0,
          endToken: 8,
          role: "SUBJECT",
          translation: "年轻的工程师今早修好了坏掉的打印机",
        },
      ]),
    ).toContainEqual({
      path: "sentences[0].components",
      message: WHOLE_SENTENCE_MESSAGE,
    });
  });

  it("rejects an overlong whole-sentence fragment component", () => {
    const sentence = sentenceOf("The quick brown fox jumps over the lazy dog near the river bank.");
    expect(
      grammarErrors(sentence, [
        {
          startToken: 0,
          endToken: sentence.tokens.at(-1)!.id,
          role: "FRAGMENT_HEAD",
          translation: "整句片段",
        },
      ]),
    ).toContainEqual({
      path: "sentences[0].components",
      message:
        "a whole-sentence fragment component must not exceed 10 lexical tokens; split it into a fragment head plus its modifiers",
    });
  });

  it.each([
    ["What a wonderful surprise!", "INDEPENDENT_ELEMENT"],
    [
      "A fast reliable secure modern accessible unified developer experience platform",
      "FRAGMENT_HEAD",
    ],
    [
      "A fast reliable secure modern accessible unified developer experience platform",
      "APPOSITIVE",
    ],
  ])("accepts a bounded whole-sentence fragment role: %s as %s", (text, role) => {
    const sentence = sentenceOf(text);
    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                { startToken: 0, endToken: sentence.tokens.at(-1)!.id, role, translation: "片段" },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("keeps the known short complete-sentence FRAGMENT_HEAD gap visible", () => {
    const sentence = sentenceOf("The system works correctly.");
    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                {
                  startToken: 0,
                  endToken: sentence.tokens.at(-1)!.id,
                  role: "FRAGMENT_HEAD",
                  translation: "系统正常工作",
                },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  it("accepts a short fragment covered by one component", () => {
    // 三个实词以下的片段(标题、列表项)本来就没有可拆的同层结构,拆了只是噪音。
    const sentence = sentenceOf("Detailed usage instructions.");

    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                {
                  startToken: 0,
                  endToken: 3,
                  role: "FRAGMENT_HEAD",
                  translation: "详细使用说明",
                },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  const DEPRECATED_COORDINATE_MESSAGE =
    "COORDINATE_CLAUSE is deprecated; analyse compound sentences as peer components " +
    "(subject, predicate, object, …) with the coordinating conjunction tagged separately as CONJUNCTION";

  it("rejects COORDINATE_CLAUSE components that only commas join", () => {
    // 祈使句串曾被整成三个「并列分句」,读者看到的就是三整块译文而不是成分划分。
    const sentence = sentenceOf(
      "Ask clarifying questions, gather the constraints, then propose a design.",
    );

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 2, role: "COORDINATE_CLAUSE", translation: "提出澄清问题" },
        { startToken: 4, endToken: 6, role: "COORDINATE_CLAUSE", translation: "收集约束" },
        { startToken: 8, endToken: 11, role: "COORDINATE_CLAUSE", translation: "然后提出设计" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components",
      message: DEPRECATED_COORDINATE_MESSAGE,
    });
  });

  it("rejects COORDINATE_CLAUSE even when CONJUNCTION is present", () => {
    // 并列句约定已废弃：真正各带主语的并列分句现在也按同层成分平铺,只保留 CONJUNCTION。
    const sentence = sentenceOf("The team shipped the code, and the client reviewed it.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 4, role: "COORDINATE_CLAUSE", translation: "团队发布了代码" },
        { startToken: 6, endToken: 6, role: "CONJUNCTION", translation: "而且" },
        { startToken: 7, endToken: 10, role: "COORDINATE_CLAUSE", translation: "客户审查了它" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components",
      message: DEPRECATED_COORDINATE_MESSAGE,
    });
  });

  it("accepts peer components with CONJUNCTION for compound structure", () => {
    // 正确的并列句标注：各分句的 subject/predicate/object 平铺,CONJUNCTION 单独标记。
    const sentence = sentenceOf("The team shipped the code, and the client reviewed it.");

    expect(
      validateCoreBatch(
        {
          sentences: [
            {
              sentenceId: sentence.sentenceId,
              components: [
                { startToken: 0, endToken: 1, role: "SUBJECT", translation: "团队" },
                { startToken: 2, endToken: 2, role: "PREDICATE", translation: "发布了" },
                { startToken: 3, endToken: 4, role: "OBJECT", translation: "代码" },
                { startToken: 6, endToken: 6, role: "CONJUNCTION", translation: "而且" },
                { startToken: 7, endToken: 8, role: "SUBJECT", translation: "客户" },
                { startToken: 9, endToken: 9, role: "PREDICATE", translation: "审查了" },
                { startToken: 10, endToken: 10, role: "OBJECT", translation: "它" },
              ],
            },
          ],
        },
        [sentence],
        "profile-1",
      ).ok,
    ).toBe(true);
  });

  const SUBJECT_CLAUSE_INTRODUCER_MESSAGE =
    "a SUBJECT_CLAUSE must start with a subject-clause introducer (that/whether/what/who/…); retag or extend the component";
  const SUBORDINATING_CONJUNCTION_ROLE_MESSAGE =
    "a component that starts with a subordinating conjunction (because/although/…) is a clause and must be tagged with a clause role (ADVERBIAL_CLAUSE/…)";
  const CLAUSE_INTRODUCER_ONLY_MESSAGE =
    "a clause component must cover a whole clause: extend it through the clause's own subject, predicate, and any objects or adverbials instead of a single word";
  const CLAUSE_SPLIT_MESSAGE =
    "an ATTRIBUTIVE_CLAUSE keeps its whole internal structure in one component; absorb the object or predicative that follows it";
  const DANGLING_PREPOSITION_MESSAGE =
    "a component must not end on a preposition; merge the phrase that preposition governs into the same component";

  it("rejects a SUBJECT_CLAUSE that does not start with an introducer", () => {
    const sentence = sentenceOf("Today, developers now play a frontline role.");
    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 1, role: "INDEPENDENT_ELEMENT", translation: "今天" },
        {
          startToken: 2,
          endToken: 7,
          role: "SUBJECT_CLAUSE",
          translation: "开发者现在发挥前线作用",
        },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[1]",
      message: SUBJECT_CLAUSE_INTRODUCER_MESSAGE,
    });
  });

  it.each([
    [
      "Whoever wins gets the prize.",
      [
        { startToken: 0, endToken: 1, role: "SUBJECT_CLAUSE", translation: "无论谁获胜" },
        { startToken: 2, endToken: 2, role: "PREDICATE", translation: "获得" },
        { startToken: 3, endToken: 5, role: "OBJECT", translation: "奖品" },
      ],
    ],
    [
      "How he did it remains a mystery.",
      [
        { startToken: 0, endToken: 3, role: "SUBJECT_CLAUSE", translation: "他如何做到" },
        { startToken: 4, endToken: 4, role: "PREDICATE", translation: "仍然是" },
        { startToken: 5, endToken: 7, role: "PREDICATIVE", translation: "一个谜" },
      ],
    ],
    [
      "It is obvious that the cache is stale.",
      [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "这" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "是" },
        { startToken: 2, endToken: 2, role: "PREDICATIVE", translation: "显然的" },
        { startToken: 3, endToken: 8, role: "SUBJECT_CLAUSE", translation: "缓存已过期" },
      ],
    ],
    [
      "The problem is that the cache is stale.",
      [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "问题" },
        { startToken: 2, endToken: 2, role: "PREDICATE", translation: "是" },
        { startToken: 3, endToken: 8, role: "PREDICATIVE_CLAUSE", translation: "缓存已过期" },
      ],
    ],
  ])(
    "accepts a valid subject-clause layout without affecting other clause roles: %s",
    (text, components) => {
      const sentence = sentenceOf(text);
      expect(
        validateCoreBatch(
          { sentences: [{ sentenceId: sentence.sentenceId, components }] },
          [sentence],
          "profile-1",
        ).ok,
      ).toBe(true);
    },
  );

  it.each([
    ["Because the road was flooded, we stayed home.", 0, 4, "ADVERBIAL"],
    ["Although the road was flooded, we stayed home.", 0, 4, "ATTRIBUTE"],
    ["Because, we stayed.", 0, 0, "ADVERBIAL"],
  ])(
    "rejects a non-clause role that starts with a clause-only conjunction: %s",
    (text, start, end, role) => {
      const sentence = sentenceOf(text);
      expect(
        grammarErrors(sentence, [
          { startToken: start, endToken: end, role, translation: "从句" },
          {
            startToken: end + 1,
            endToken: sentence.tokens.at(-1)!.id,
            role: "INDEPENDENT_ELEMENT",
            translation: "主句",
          },
        ]),
      ).toContainEqual({
        path: "sentences[0].components[0]",
        message: SUBORDINATING_CONJUNCTION_ROLE_MESSAGE,
      });
    },
  );

  it.each([
    [
      "Because of this limitation, we stayed home.",
      [
        { startToken: 0, endToken: 4, role: "ADVERBIAL", translation: "由于此限制" },
        { startToken: 5, endToken: 5, role: "SUBJECT", translation: "我们" },
        { startToken: 6, endToken: 7, role: "PREDICATE", translation: "留在家里" },
      ],
    ],
    [
      "The docs don't cover it, though.",
      [
        { startToken: 0, endToken: 1, role: "SUBJECT", translation: "文档" },
        { startToken: 2, endToken: 3, role: "PREDICATE", translation: "没有涵盖" },
        { startToken: 4, endToken: 5, role: "OBJECT", translation: "它" },
        { startToken: 6, endToken: 7, role: "ADVERBIAL", translation: "不过" },
      ],
    ],
  ])("accepts the conservative non-clause conjunction exception: %s", (text, components) => {
    const sentence = sentenceOf(text);
    const result = validateCoreBatch(
      { sentences: [{ sentenceId: sentence.sentenceId, components }] },
      [sentence],
      "profile-1",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a clause component that only covers its introducing word", () => {
    // 线上实测:"that" 被单独标成 ATTRIBUTIVE_CLAUSE,从句的谓语与宾语平铺到主句层,
    // 页面上于是出现两个同级"谓语",引导词底下还挂着整个从句的译文。
    const sentence = sentenceOf("Apple tests Siri feature that handles multiple commands.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "苹果" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "测试" },
        { startToken: 2, endToken: 3, role: "OBJECT", translation: "Siri 功能" },
        { startToken: 4, endToken: 4, role: "ATTRIBUTIVE_CLAUSE", translation: "处理多条指令的" },
        { startToken: 5, endToken: 5, role: "PREDICATE", translation: "处理" },
        { startToken: 6, endToken: 8, role: "OBJECT", translation: "多条指令" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[3]",
      message: CLAUSE_INTRODUCER_ONLY_MESSAGE,
    });
  });

  it("accepts an object complement after an object's ATTRIBUTIVE_CLAUSE", () => {
    const sentence = sentenceOf("We consider the movie that she directed a masterpiece.");
    const result = validateCoreBatch(
      {
        sentences: [
          {
            sentenceId: sentence.sentenceId,
            components: [
              { startToken: 0, endToken: 0, role: "SUBJECT", translation: "我们" },
              { startToken: 1, endToken: 1, role: "PREDICATE", translation: "认为" },
              { startToken: 2, endToken: 3, role: "OBJECT", translation: "这部电影" },
              { startToken: 4, endToken: 6, role: "ATTRIBUTIVE_CLAUSE", translation: "她导演的" },
              { startToken: 7, endToken: 8, role: "COMPLEMENT", translation: "一部杰作" },
            ],
          },
        ],
      },
      [sentence],
      "profile-1",
    );

    expect(result.ok).toBe(true);
  });

  it("rejects an ATTRIBUTIVE_CLAUSE followed immediately by the object it should contain", () => {
    // 从句切到谓语就收尾、宾语平铺出去:主句宾语不可能出现在定语从句之后,
    // 出现了就说明从句自己的宾语被切了出来。
    const sentence = sentenceOf("Apple tests Siri feature that handles multiple commands.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "苹果" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "测试" },
        { startToken: 2, endToken: 3, role: "OBJECT", translation: "Siri 功能" },
        { startToken: 4, endToken: 5, role: "ATTRIBUTIVE_CLAUSE", translation: "处理" },
        { startToken: 6, endToken: 8, role: "OBJECT", translation: "多条指令" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[3]",
      message: CLAUSE_SPLIT_MESSAGE,
    });
  });

  it.each([
    ["That's what dreams are made of.", 2, 6, "PREDICATIVE_CLAUSE"],
    ["This is the range the value stays within.", 2, 7, "PREDICATIVE_CLAUSE"],
    ["That is what the choice lies between.", 2, 7, "PREDICATIVE_CLAUSE"],
    ["These are the peers the service runs among.", 2, 8, "PREDICATIVE_CLAUSE"],
  ])(
    "accepts a clause that legally ends on a dangling preposition: %s",
    (text, start, end, role) => {
      const sentence = sentenceOf(text);
      expect(
        validateCoreBatch(
          {
            sentences: [
              {
                sentenceId: sentence.sentenceId,
                components: [
                  { startToken: 0, endToken: 0, role: "SUBJECT", translation: "主语" },
                  { startToken: 1, endToken: 1, role: "PREDICATE", translation: "系词" },
                  { startToken: start, endToken: end, role, translation: "从句" },
                ],
              },
            ],
          },
          [sentence],
          "profile-1",
        ).ok,
      ).toBe(true);
    },
  );

  it("rejects a component that ends on a preposition whose object was split off", () => {
    // 实测 "near the frontier of what AI can do" 被切成介词悬空的状语 + 宾语从句,
    // 于是 "of" 底下没有任何可译的内容。
    const sentence = sentenceOf("He performed near the frontier of what AI can do.");

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "他" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "表现" },
        { startToken: 2, endToken: 5, role: "ADVERBIAL", translation: "在前沿附近" },
        { startToken: 6, endToken: 10, role: "OBJECT_CLAUSE", translation: "AI 能做到的事" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[2]",
      message: DANGLING_PREPOSITION_MESSAGE,
    });
  });

  it("rejects the reported Spring AI misanalysis that used to pass every gate", () => {
    // 用户报告的原始输出:`of applications` 误标状语、`that` 单独当定语从句、
    // 从句的谓语与宾语平铺到主句层。这个划分曾 100% 通过校验,直接写进缓存。
    const sentence = sentenceOf(
      "The Spring AI project aims to streamline the development of applications that " +
        "incorporate artificial intelligence functionality without unnecessary complexity.",
    );

    expect(
      grammarErrors(sentence, [
        { startToken: 0, endToken: 3, role: "SUBJECT", translation: "Spring AI 项目" },
        { startToken: 4, endToken: 6, role: "PREDICATE", translation: "旨在简化" },
        { startToken: 7, endToken: 8, role: "OBJECT", translation: "开发" },
        { startToken: 9, endToken: 10, role: "ADVERBIAL", translation: "的" },
        {
          startToken: 11,
          endToken: 11,
          role: "ATTRIBUTIVE_CLAUSE",
          translation: "包含人工智能功能",
        },
        { startToken: 12, endToken: 15, role: "PREDICATE", translation: "整合" },
        { startToken: 16, endToken: 19, role: "ADVERBIAL", translation: "没有不必要的复杂性" },
      ]),
    ).toContainEqual({
      path: "sentences[0].components[4]",
      message: CLAUSE_INTRODUCER_ONLY_MESSAGE,
    });
  });

  function accepts(sentence: SentenceInput, components: readonly unknown[]): void {
    const result = validateCoreBatch(
      { sentences: [{ sentenceId: sentence.sentenceId, components }] },
      [sentence],
      "profile-1",
    );
    expect(result.ok ? [] : result.errors).toEqual([]);
  }

  it("accepts a relative clause that keeps its own object and adverbial inside one component", () => {
    const sentence = sentenceOf("Apple tests Siri feature that handles multiple commands at once.");

    accepts(sentence, [
      { startToken: 0, endToken: 0, role: "SUBJECT", translation: "苹果" },
      { startToken: 1, endToken: 1, role: "PREDICATE", translation: "测试" },
      { startToken: 2, endToken: 3, role: "OBJECT", translation: "Siri 功能" },
      {
        startToken: 4,
        endToken: 10,
        role: "ATTRIBUTIVE_CLAUSE",
        translation: "能一次处理多条指令的",
      },
    ]);
  });

  it("accepts a relative clause followed by the main-clause predicate", () => {
    const sentence = sentenceOf("The novel that she recommended won a national award.");

    accepts(sentence, [
      { startToken: 0, endToken: 1, role: "SUBJECT", translation: "那本小说" },
      { startToken: 2, endToken: 4, role: "ATTRIBUTIVE_CLAUSE", translation: "她推荐的" },
      { startToken: 5, endToken: 5, role: "PREDICATE", translation: "获得了" },
      { startToken: 6, endToken: 8, role: "OBJECT", translation: "一项全国性奖项" },
    ]);
  });

  it("accepts a relative clause followed by a main-clause adverbial", () => {
    // 定语从句修饰句中名词时,主句状语紧跟在从句后面是合法的——这条不得误拒。
    const sentence = sentenceOf("I met the man who called yesterday in the park.");

    accepts(sentence, [
      { startToken: 0, endToken: 0, role: "SUBJECT", translation: "我" },
      { startToken: 1, endToken: 1, role: "PREDICATE", translation: "遇见" },
      { startToken: 2, endToken: 3, role: "OBJECT", translation: "那个男人" },
      { startToken: 4, endToken: 6, role: "ATTRIBUTIVE_CLAUSE", translation: "昨天打电话来的" },
      { startToken: 7, endToken: 10, role: "ADVERBIAL", translation: "在公园里" },
    ]);
  });
});

describe("shared translation quality fixture", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../shared-fixtures/translation-quality.json", import.meta.url),
      "utf8",
    ),
  ) as {
    schemaVersion: number;
    hanScriptBoundary: Array<{ id: string; text: string; containsHan: boolean }>;
    cases: Array<{
      id: string;
      sentence: { id: string; text: string };
      raw: unknown;
      accepted: boolean;
      expected: Array<{ path: string; message: string }>;
    }>;
  };

  it("has an unambiguous versioned schema", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(new Set(fixture.cases.map(({ id }) => id)).size).toBe(fixture.cases.length);
    expect(
      fixture.cases.every(
        ({ accepted, expected }) =>
          typeof accepted === "boolean" && (accepted ? expected.length === 0 : expected.length > 0),
      ),
    ).toBe(true);
  });

  // 与 Kotlin 端 `\p{IsHan}` 共享同一组 15 边界 case:假名/谚文/CJK 标点 false,
  // 扩展 A 区(㐀)/CJK 兼容区(丽, U+2F800, 代理对)/〇 true。有人把 Script=Han 简化成
  // [\u4e00-\u9fff] 时,这三个 true case 在双端同时变红。
  it.each(fixture.hanScriptBoundary)(
    "Han script boundary $id matches the shared fixture",
    (boundary) => {
      expect(HAN_PATTERN.test(boundary.text)).toBe(boundary.containsHan);
    },
  );

  it("pins the Han boundary group size so silent truncation fails", () => {
    expect(fixture.hanScriptBoundary).toHaveLength(15);
    expect(new Set(fixture.hanScriptBoundary.map(({ id }) => id)).size).toBe(15);
    expect(fixture.hanScriptBoundary.some(({ containsHan }) => containsHan)).toBe(true);
    expect(fixture.hanScriptBoundary.some(({ containsHan }) => !containsHan)).toBe(true);
  });

  it.each(fixture.cases)("matches the complete ordered errors for $id", (testCase) => {
    const sentence: SentenceInput = {
      sentenceId: testCase.sentence.id,
      text: testCase.sentence.text,
      tokens: tokenize(testCase.sentence.text),
    };
    const result = validateCoreBatch(testCase.raw, [sentence], "translation-quality-fixture");
    expect(result.ok, `fixture case ${testCase.id} acceptance`).toBe(testCase.accepted);
    if (result.ok) {
      expect(testCase.expected).toEqual([]);
    } else {
      expect(result.errors).toEqual(testCase.expected);
    }
  });
});

const focus: TokenRange = { startToken: 1, endToken: 1 };
const rawDetail = {
  sentenceId: "sentence-1",
  focus,
  structures: [{ startToken: 1, endToken: 1, role: "verb", explanation: "谓语动词" }],
  grammarPoints: ["一般现在时"],
  explanation: "说明阅读这一动作。",
};

function invalidDetail(raw: unknown) {
  const result = validateDetail(raw, request, focus, "profile-1");
  expect(result.ok).toBe(false);
  return result;
}

describe("detail analysis validation", () => {
  it("accepts valid detail and stamps the trusted profile", () => {
    expect(validateDetail(rawDetail, request, focus, "profile-1")).toEqual({
      ok: true,
      value: { ...rawDetail, modelProfileId: "profile-1" },
    });
  });

  it("rejects output that changes the requested focus", () => {
    invalidDetail({ ...rawDetail, focus: { startToken: 1, endToken: 2 } });
  });

  it("rejects structures outside focus or overlapping earlier structures", () => {
    invalidDetail({
      ...rawDetail,
      structures: [{ ...rawDetail.structures[0], startToken: 0, endToken: 1 }],
    });
    invalidDetail({
      ...rawDetail,
      structures: [
        { ...rawDetail.structures[0], startToken: 1, endToken: 1 },
        { ...rawDetail.structures[0], startToken: 1, endToken: 1 },
      ],
    });
  });

  it.each([
    ["a reversed structure", { startToken: 2, endToken: 1 }],
    ["an out-of-range structure", { startToken: 1, endToken: 4 }],
  ])("rejects %s", (_description, interval) => {
    invalidDetail({
      ...rawDetail,
      structures: [{ ...rawDetail.structures[0], ...interval }],
    });
  });

  it("rejects more than 12 grammar points", () => {
    invalidDetail({
      ...rawDetail,
      grammarPoints: Array.from({ length: 13 }, (_, i) => `point ${i}`),
    });
  });

  it("rejects a grammar point longer than 300 characters", () => {
    invalidDetail({ ...rawDetail, grammarPoints: ["语".repeat(301)] });
  });

  it.each([
    ["detail explanation", { explanation: "<script>alert(1)</script>" }],
    ["structure explanation", { structures: [{ ...rawDetail.structures[0], explanation: "\0" }] }],
    ["grammar point", { grammarPoints: ["javascript:alert(1)"] }],
  ])("rejects a script-like %s", (_description, change) => {
    invalidDetail({ ...rawDetail, ...change });
  });

  it("keeps a structure translation and stamps it into the result", () => {
    const raw = {
      ...rawDetail,
      structures: [{ ...rawDetail.structures[0], translation: "读书" }],
    };
    expect(validateDetail(raw, request, focus, "profile-1")).toEqual({
      ok: true,
      value: { ...raw, modelProfileId: "profile-1" },
    });
  });

  it("drops a blank translation instead of failing the whole detail", () => {
    const raw = {
      ...rawDetail,
      structures: [{ ...rawDetail.structures[0], translation: "  " }],
    };
    expect(validateDetail(raw, request, focus, "profile-1")).toEqual({
      ok: true,
      value: { ...rawDetail, modelProfileId: "profile-1" },
    });
  });

  it("rejects a script-like structure translation", () => {
    invalidDetail({
      ...rawDetail,
      structures: [{ ...rawDetail.structures[0], translation: "<script>alert(1)</script>" }],
    });
  });
});
