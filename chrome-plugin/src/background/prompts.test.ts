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

  /**
   * 三条粒度边界:少了它们，实测同一句会被切成词级碎片(Help/turn 两个谓语、
   * 介词与宾语分离、宾语短语误标定语)。判定顺序也是实测出来的——分句规则必须
   * 排在 peer 规则之前，两条平列时模型会在两种切法之间跳。
   */
  it("bounds component granularity and decides clause layout first", () => {
    const prompt = buildCorePrompt([sentence]);

    expect(prompt).toContain("Clause-structure-first rule:");
    expect(prompt).toContain("analyse every compound clause as peer components");
    expect(prompt).toContain("Never emit COORDINATE_CLAUSE");
    expect(prompt).not.toContain("emit exactly one COORDINATE_CLAUSE per clause");
    expect(prompt).toContain('"Help turn" is one PREDICATE');
    expect(prompt).toContain("Two PREDICATE components must never be adjacent");
    expect(prompt).toContain("a preposition and everything it governs form exactly one component");
    expect(prompt).toContain(
      "never tag a noun phrase governed by a verb or preposition as ATTRIBUTE",
    );
    expect(prompt.indexOf("Clause-structure-first rule:")).toBeLessThan(
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
      "a prepositional phrase that directly follows the noun phrase it modifies is ATTRIBUTE",
    );
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
    const repair = buildRepairPrompt([sentence], [{ path: "sentences[0]", message: "bad" }], {});

    for (const rule of [
      "The role field is a closed 16-role enum:",
      "Coverage rule:",
      "Clause-structure-first rule:",
      "Predicate-scope rule:",
      "Prepositional-phrase rule:",
      "Peer-component rule:",
      "Supplement rule:",
      "Compound-sentence rule:",
      "Complex-sentence rule:",
      "Simple-sentence rule:",
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
          path: "sentences[0].components[1]",
          message:
            "a PREDICATE must cover only the verb group; emit the noun phrase that starts at the determiner as its own OBJECT, PREDICATIVE, or COMPLEMENT component",
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
      buildRepairPrompt([dashSentence], [{ path: "sentences[0]", message: "bad" }], {}),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain("dash or colon");
      expect(prompt).toContain("APPOSITIVE or INDEPENDENT_ELEMENT");
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
      buildRepairPrompt([sentence], [{ path: "sentences[0]", message: "bad" }], {}),
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
    const prompt = buildRepairPrompt([sentence], [{ path: "sentences[0]", message: "bad" }], {
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
