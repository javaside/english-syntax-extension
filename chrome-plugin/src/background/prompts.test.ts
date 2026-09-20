import { describe, expect, it } from "vitest";
import { GrammarRole } from "../shared/grammar";
import { CORE_SCHEMA_VERSION } from "../shared/versions";
import type { CoreAnalysis } from "../shared/grammar";
import { tokenize } from "../language/segmenter";
import type { SentenceInput } from "../shared/protocol";
import {
  buildCorePrompt,
  buildDetailPrompt,
  buildRepairPrompt,
  buildSentenceDetailsPrompt,
} from "./prompts";

/** 与生产 repair-errors.ts 同构的单组错误,供 repair prompt 测试使用。 */
const repairGroup = {
  sentenceId: "s1",
  rawOccurrence: 0,
  kind: "invalid",
  errors: [{ path: "components[0]", message: "bad" }],
} as const;

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
  schemaVersion: CORE_SCHEMA_VERSION,
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

  it("forbids predicates from swallowing peer components", () => {
    const prompt = buildCorePrompt([sentence]);

    expect(prompt).toContain("PREDICATE must not absorb");
    expect(prompt).toContain("OBJECT, PREDICATIVE, COMPLEMENT, or ADVERBIAL");
  });

  it("classifies complete clauses before fragments without adding sentence translations", () => {
    const prompts = [buildCorePrompt([sentence]), buildRepairPrompt([sentence], [repairGroup], {})];
    const completenessRuleParts = [
      "Completeness-first rule:",
      "FRAGMENT_HEAD",
      "Portable API support",
      "across AI providers",
      "for Chat, text-to-image, and Embedding models",
      "An imperative is a clause, not a fragment",
      '"Install the CLI" is PREDICATE "Install" plus OBJECT "the CLI"',
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain("The role field is a closed 17-role enum:");
      let previousIndex = -1;
      for (const part of completenessRuleParts) {
        const index = prompt.indexOf(part, previousIndex + 1);
        expect(index, part).toBeGreaterThan(previousIndex);
        previousIndex = index;
      }
      expect(previousIndex).toBeLessThan(prompt.indexOf("Clause-structure rule:"));
      expect(prompt).toContain("Give every component a concise, non-empty Chinese translation");
      expect(prompt).not.toContain("sentence-level translation");
      expect(prompt).not.toContain('{"sentenceId": string, "translation": string');
    }
  });

  /**
   * 四条粒度边界:少了它们，实测同一句会被切成词级碎片(Help/turn 两个谓语、
   * 介词与宾语分离、宾语短语误标定语)。completeness-first 排最前——先判输入
   * 是否构成分句,再定分句层级。判定顺序也是实测出来的——分句规则必须
   * 排在 peer 规则之前，两条平列时模型会在两种切法之间跳。
   */
  it("bounds component granularity and decides clause layout first", () => {
    const prompt = buildCorePrompt([sentence]);

    expect(prompt).toContain("Clause-structure rule:");
    expect(prompt).toContain("analyse every compound clause as peer components");
    expect(prompt).toContain("Never emit COORDINATE_CLAUSE");
    expect(prompt).not.toContain("emit exactly one COORDINATE_CLAUSE per clause");
    expect(prompt).toContain('"Help turn" is one PREDICATE');
    expect(prompt).toContain("Two PREDICATE components must never be adjacent");
    expect(prompt).toContain("a preposition and everything it governs form exactly one component");
    expect(prompt).toContain(
      "never tag a noun phrase governed by a verb or preposition as ATTRIBUTE",
    );
    expect(prompt.indexOf("Clause-structure rule:")).toBeLessThan(
      prompt.indexOf("Peer-component rule:"),
    );
    // peer 规则收窄到分句内，才不会与分句规则打架。
    expect(prompt).toContain("Peer-component rule: within a single clause");
  });

  /**
   * 线上实测的四类错误各对应提示词里的一处漏洞或自相矛盾:定语从句只标引导词、
   * 名词后的 of 短语误标状语、系表结构两种口径混用、译文只译中心词。
   */
  it("closes the four gaps behind the observed misanalyses", () => {
    const prompt = buildCorePrompt([sentence]);

    // 从句右边界:从引导词一直延伸到从句自己的宾语与状语。
    expect(prompt).toContain("never stop a clause component at its introducing word");
    expect(prompt).toContain('"that handles multiple commands at once" is ONE ATTRIBUTIVE_CLAUSE');

    // 后置定语归 ATTRIBUTE,不是 ADVERBIAL;旧文案把 ATTRIBUTE 限死在前置修饰上。
    expect(prompt).toContain(
      "a prepositional phrase selecting or describing the preceding noun is ATTRIBUTE",
    );
    expect(prompt).toContain('"the development" plus "of applications" is OBJECT plus ATTRIBUTE');
    expect(prompt).not.toContain("ATTRIBUTE is only a modifier sitting inside a noun phrase");
    expect(prompt).toContain("never let a component end on a preposition");

    // 系表拆开:PREDICATE 只含系动词,补足部分单独标 PREDICATIVE。
    expect(prompt).toContain("a linking verb takes only the verb itself");
    expect(prompt).not.toContain('"is independently deployable" is one PREDICATE');

    // 译文必须覆盖整段成分,不能只译中心词。
    expect(prompt).toContain("renders everything the component covers");
  });

  /**
   * 修复轮曾只带 peer + supplement 两条规则，覆盖率/角色枚举/复合句/译文要求全丢，
   * 于是"修一次就更碎"。core 与 repair 现在共享同一份规则清单。
   */
  it("carries the full rule set into the repair prompt", () => {
    const core = buildCorePrompt([sentence]);
    const repair = buildRepairPrompt([sentence], [repairGroup], {});

    for (const rule of [
      "The role field is a closed 17-role enum:",
      "Coverage rule:",
      "Clause-structure rule:",
      "Predicate-scope rule:",
      "Prepositional-phrase rule:",
      "Peer-component rule:",
      "Colon-structure rule:",
      "Component-granularity rule:",
      "Give every component a concise, non-empty Chinese translation",
    ]) {
      expect(core).toContain(rule);
      expect(repair).toContain(rule);
    }
  });

  it("tells repair to split a predicate before an absorbed determiner phrase and self-check errors", () => {
    const repair = buildRepairPrompt(
      [sentence],
      [
        {
          sentenceId: "sentence-1",
          rawOccurrence: 0,
          kind: "invalid",
          errors: [
            {
              path: "components[1]",
              message:
                "a PREDICATE must cover only the verb group; emit the noun phrase that starts at the determiner as its own OBJECT, PREDICATIVE, or COMPLEMENT component",
            },
          ],
        },
      ],
      {},
    );

    expect(repair).toContain("split that component immediately before the determiner");
    expect(repair).toContain("Check the repaired JSON against every listed validation error");
  });

  it("treats dash supplements as explanations instead of coordination", () => {
    const dashSentence: SentenceInput = {
      sentenceId: "dash-1",
      text: "Ask clarifying questions — one at a time, the ones that matter.",
      tokens: tokenize("Ask clarifying questions — one at a time, the ones that matter."),
    };
    const prompts = [
      buildCorePrompt([dashSentence]),
      buildRepairPrompt([dashSentence], [repairGroup], {}),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain("Colon-structure rule:");
      expect(prompt).toContain("INDEPENDENT_ELEMENT");
      expect(prompt).toContain("the ones");
      expect(prompt).toContain("that matter");
    }
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
      buildRepairPrompt([sentence], [repairGroup], {}),
      buildDetailPrompt(sentence, core, focus),
      buildSentenceDetailsPrompt(sentence, core, [focus]),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toContain("leadingWhitespace");
      expect(prompt).toContain('{"id":0,"text":"Learners"}');
    }
    expect(prompts[0]).toContain("PREDICATE must not absorb");
  });
});

describe("detail local translation teaching", () => {
  it("teaches natural glosses for a noun head and its postmodifying of-phrase", () => {
    const prompts = [
      buildDetailPrompt(sentence, core, { startToken: 0, endToken: 1 }),
      buildSentenceDetailsPrompt(sentence, core, [{ startToken: 0, endToken: 1 }]),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('translate "the development" as "开发过程", not "该开发"');
      expect(prompt).toContain('translate "of applications" as "应用程序的"');
      expect(prompt).toContain('explain their combined meaning as "应用程序的开发过程"');
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

describe("prompt 内嵌的 JSON 同样紧凑", () => {
  // 输出侧早就要求 minified（MINIFIED_OUTPUT），输入侧却把核心结果、校验错误、
  // 待修复 JSON 缩进美化后发出去：一个 6 成分的句子光缩进空格就白扔 270+ 字符，
  // 而模型只读结构、不读排版。
  const indented = /\n {2}"/u;

  it("详解 prompt 回传的核心结果不带缩进", () => {
    const prompt = buildDetailPrompt(sentence, core, { startToken: 0, endToken: 1 });

    expect(prompt).not.toMatch(indented);
    expect(prompt).toContain('"role":"SUBJECT"');
  });

  it("整句详解 prompt 的核心结果与 focus 列表不带缩进", () => {
    const prompt = buildSentenceDetailsPrompt(sentence, core, [{ startToken: 0, endToken: 1 }]);

    expect(prompt).not.toMatch(indented);
  });

  it("核心修复 prompt 的校验错误与待修复 JSON 不带缩进", () => {
    const prompt = buildRepairPrompt([sentence], [repairGroup], {
      sentences: [{ sentenceId: sentence.sentenceId, components: [] }],
    });

    expect(prompt).not.toMatch(indented);
  });
});

describe("紧凑输出指令", () => {
  it("core prompt 要求单行紧凑 JSON 且不带 Markdown 围栏", () => {
    const prompt = buildCorePrompt([sentence]);

    expect(prompt).toMatch(/minified JSON on a single line/u);
    expect(prompt).toMatch(/code fence/u);
  });

  it("指令不在首行——假服务器按首行前缀识别请求类型", () => {
    const prompt = buildCorePrompt([sentence]);

    expect(prompt.split("\n")[0]).not.toMatch(/minified/u);
  });
});

/**
 * CORE_PROMPT_VERSION 13 的页面句型重写。这一组测试钉住「页面级英文覆盖」所需的
 * 最小对照教学:每个口径一条正例 + 一条最接近的反例,不再堆叠段落式规则——
 * 旧规则文案里互相重复/冲突的句子已删,新增内容以对偶例句为主。
 */
describe("页面句型教学(版本 13 重写)", () => {
  const rules = () => buildCorePrompt([sentence]);

  it("teaches the fragment-relative attributive clause with its full-clause counterexample", () => {
    const prompt = rules();

    expect(prompt).toContain(
      '"An API that returns JSON responses" is FRAGMENT_HEAD "An API" plus ATTRIBUTIVE_CLAUSE "that returns JSON responses"',
    );
    expect(prompt).toContain(
      "the finite verb inside that embedded clause does not turn the whole input into a main clause",
    );
    // 完整句反例:内嵌定从不使输入成片段,主句照旧拆同层成分。
    expect(prompt).toContain(
      '"The tool that we built passes every test" keeps PREDICATE "passes" at the top level',
    );
  });

  it("teaches the arXiv long-colon title four-segment analysis and its full-clause counterexample", () => {
    const prompt = rules();

    expect(prompt).toContain(
      '"Scope of X: Properties of Y" = FRAGMENT_HEAD "Scope" + ATTRIBUTE "of X" + APPOSITIVE "Properties" + ATTRIBUTE "of Y"',
    );
    expect(prompt).toContain("leave the colon uncovered");
    // 反例:冒号后是完整分句/疑问句时整个输入按 clause 分析,不机械标 APPOSITIVE。
    expect(prompt).toContain("If it is a complete clause or question");
  });

  it("contrasts VP coordination (FANBOYS as CONJUNCTION) with NP coordination (and stays inside)", () => {
    const prompt = rules();

    expect(prompt).toContain(
      'in "They measure the time and propagate the results", "and" is its own CONJUNCTION joining two verb phrases that share one subject',
    );
    expect(prompt).toContain(
      'in "a Claude subscription or Anthropic Console account", "or" stays inside the single OBJECT',
    );
  });

  it("contrasts finite when-clauses with non-finite when-phrases", () => {
    const prompt = rules();

    expect(prompt).toContain(
      'A when/before/after/if clause with its own finite predicate is ONE ADVERBIAL_CLAUSE ("when methods are called")',
    );
    expect(prompt).toContain(
      'when/before/after followed by a non-finite verb phrase stays at phrase level as ONE ADVERBIAL ("when performing tool calling")',
    );
  });

  it("teaches object-control allow/force/let plus NP plus infinitive and the bare-infinitive chain", () => {
    const prompt = rules();

    expect(prompt).toContain(
      'With allow/force/let plus a noun phrase plus an infinitive, the verb is PREDICATE, the noun phrase is OBJECT, and the infinitive phrase is COMPLEMENT ("allows Maven to access repositories" is PREDICATE "allows" plus OBJECT "Maven" plus COMPLEMENT "to access repositories")',
    );
    // let go 类裸不定式链仍是一个 PREDICATE——反例口径留在 PREDICATE_SCOPE_RULE。
    expect(prompt).toContain('"let go" is one PREDICATE');
  });

  it("teaches the zero-relative clause cut from its parent noun phrase", () => {
    const prompt = rules();

    expect(prompt).toContain(
      'A relative clause whose introducing word is omitted is still ONE ATTRIBUTIVE_CLAUSE cut from the noun phrase it modifies: "a typed object the rest of the codebase can treat" is OBJECT "a typed object" plus ATTRIBUTIVE_CLAUSE "the rest of the codebase can treat"',
    );
  });

  it("teaches the non-finite complement covering its own object", () => {
    const prompt = rules();

    expect(prompt).toContain(
      'A non-finite complement phrase keeps its own object inside one COMPLEMENT ("is steered to produce text" is PREDICATE "is steered" plus COMPLEMENT "to produce text")',
    );
  });

  it("teaches all four PP attachment mappings", () => {
    const prompt = rules();

    // 动词管辖 PP → ADVERBIAL（前置程度副词独立成 ADVERBIAL，与黄金集 doc-adverbial-2 同构）
    expect(prompt).toContain(
      'a prepositional phrase expressing where/when/how the action happens is ADVERBIAL, and a degree adverb in front of it stays its own ADVERBIAL component ("Claude Code works directly with git." is SUBJECT "Claude Code", PREDICATE "works", ADVERBIAL "directly", and ADVERBIAL "with git")',
    );
    // 名词后所选 PP → ATTRIBUTE
    expect(prompt).toContain(
      'a prepositional phrase selecting or describing the preceding noun is ATTRIBUTE ("an open standard for connecting AI tools" is PREDICATIVE "an open standard" plus ATTRIBUTE "for connecting AI tools", and "the development" plus "of applications" is OBJECT plus ATTRIBUTE)',
    );
    // 外层 PP 内部不再顶层拆分
    expect(prompt).toContain('"without looking at any of the code" stays ONE ADVERBIAL');
    // pay attention to 保持 OBJECT + ATTRIBUTE
    expect(prompt).toContain(
      '"pay attention to the details" is PREDICATE "pay" plus OBJECT "attention" plus ATTRIBUTE "to the details"',
    );
  });

  it("requires natural local glosses in both core and repair prompts", () => {
    const prompts = [buildCorePrompt([sentence]), buildRepairPrompt([sentence], [repairGroup], {})];

    for (const prompt of prompts) {
      expect(prompt).toContain('"the development" is "开发过程", not "该开发"');
      expect(prompt).toContain('"of applications" is "应用程序的", not "的"');
    }
  });

  it("requires a Chinese gloss per component and Chinese-typed proper names, rejecting English echo", () => {
    const prompt = rules();

    expect(prompt).toContain("Spring AI 框架");
    expect(prompt).toContain("JSON 数据格式");
    expect(prompt).toContain("哈勃常数 H0");
    expect(prompt).toContain(
      "a translation that only copies or echoes the English span is invalid and will be rejected",
    );
  });

  it("teaches the low-frequency roles with one example each", () => {
    const prompt = rules();

    // PREDICATIVE_CLAUSE
    expect(prompt).toContain(
      'PREDICATIVE_CLAUSE completes a linking verb ("The real problem is that the cache entry has expired")',
    );
    // SUBJECT_CLAUSE
    expect(prompt).toContain(
      'SUBJECT_CLAUSE acts as the subject ("Whoever wins the race gets the final ticket")',
    );
    // ADVERBIAL_CLAUSE
    expect(prompt).toContain(
      'ADVERBIAL_CLAUSE modifies the main clause ("Because the road was flooded, the bus took a longer route")',
    );
    // COMPLEMENT(宾补)
    expect(prompt).toContain(
      '"We consider the tool essential" is OBJECT "the tool" plus COMPLEMENT "essential"',
    );
    // APPOSITIVE / INDEPENDENT_ELEMENT
    expect(prompt).toContain(
      'A comma-braced renaming noun phrase is ONE APPOSITIVE ("Claude Code, an AI coding assistant, helps")',
    );
    expect(prompt).toContain(
      'a sentence-initial comment adverb is ONE INDEPENDENT_ELEMENT ("Fortunately, the deployment finished")',
    );
    // 助动词 been/being/having 收进动词组
    expect(prompt).toContain('"have been told"');
    expect(prompt).toMatch(/being/u);
    expect(prompt).toMatch(/having/u);
  });

  it("merges the duplicate compound/simple-sentence rules into the clause-first rule", () => {
    const prompt = rules();

    // 重写去重:旧的 Compound-sentence / Simple-sentence 独立条目不再单列,
    // 其口径并入 CLAUSE_FIRST_RULE。
    expect(prompt).not.toContain("Compound-sentence rule:");
    expect(prompt).not.toContain("Simple-sentence rule:");
    expect(prompt).toContain("A sentence is compound only when");
  });

  // spec §实施前置 5:重写后预算必须有测量依据。旧版规则段(版本 12,单句)实测
  // 8207 字符;重写删掉 SUPPLEMENT_RULE 与内联 Compound/Simple 两条重复条目,
  // 同时为页面语料新增约 10 组「正例 + 反例」教学对照,净增量 +33%(
  // 实测 10903 字符)。2026-09-12 批次(spec D4/D5)新增 Trailing-citation 与
  // Heading-number 两条规则(含最小正反例),系数 1.35 → 1.42;两例都压缩到
  // 最短可教形式后再计入,超出说明又在机械追加。
  it("teaches field-label + complete question as clause, not fragment", () => {
    const prompt = buildCorePrompt([sentence]);

    expect(prompt).toContain("Colon-structure rule:");
    expect(prompt).toContain('INDEPENDENT_ELEMENT "Binary flag"');
    expect(prompt).toContain("never mix FRAGMENT_HEAD with clause roles");
  });

  it("keeps the rewritten rule text within the measured budget envelope", () => {
    const prompt = buildCorePrompt([sentence]);
    const payloadStart = prompt.indexOf("Numbered sentence requests:");
    const ruleTextLength = prompt.slice(0, payloadStart).length;

    expect(ruleTextLength).toBeLessThanOrEqual(Math.ceil(8207 * 1.42));
  });
});
