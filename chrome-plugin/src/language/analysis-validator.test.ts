import { describe, expect, it } from "vitest";
import { GrammarRole } from "../shared/grammar";
import { CORE_SCHEMA_VERSION } from "../shared/versions";
import type { TokenRange } from "../shared/grammar";
import type { SentenceInput } from "../shared/protocol";
import { validateCoreBatch, validateDetail } from "./analysis-validator";
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

describe("core analysis validation", () => {
  it("accepts complete, ordered core coverage", () => {
    const result = validateCoreBatch(rawCore, [request], "profile-1");
    expect(result).toEqual({ ok: true, value: [expectedAnalysis] });
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
      "a punctuation-only component",
      [
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "学习者" },
        { startToken: 1, endToken: 1, role: "PREDICATE", translation: "阅读" },
        { startToken: 2, endToken: 2, role: "OBJECT", translation: "书籍" },
        { startToken: 3, endToken: 3, role: "INDEPENDENT_ELEMENT", translation: "句号" },
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
        { startToken: 0, endToken: 0, role: "SUBJECT", translation: "Claude" },
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
                { startToken: 0, endToken: 3, role: "SUBJECT", translation: "详细使用说明" },
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

  const CLAUSE_INTRODUCER_ONLY_MESSAGE =
    "a clause component must cover a whole clause: extend it through the clause's own subject, predicate, and any objects or adverbials instead of a single word";
  const CLAUSE_SPLIT_MESSAGE =
    "an ATTRIBUTIVE_CLAUSE keeps its whole internal structure in one component; absorb the object, predicative, or complement that follows it";
  const DANGLING_PREPOSITION_MESSAGE =
    "a component must not end on a preposition; merge the phrase that preposition governs into the same component";

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
