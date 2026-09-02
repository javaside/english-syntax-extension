import { GrammarRole } from "../shared/grammar";
import type { CoreAnalysis, TokenRange } from "../shared/grammar";
import type { SentenceInput } from "../shared/protocol";

export interface ValidationErrorDescription {
  path: string;
  message: string;
}

export const PROMPT_FIRST_LINES = {
  core: "Analyze the numbered English sentences below into core grammatical components.",
  coreRepair:
    "Repair only the structure of the invalid core-analysis JSON so it satisfies every validation error.",
  detail: "Explain only the selected grammatical component in the single sentence below.",
  detailRepair: "Repair only the structure of the invalid detail-analysis JSON.",
  probeSystem: "Return only the requested JSON object.",
} as const;

/**
 * prompt 里内嵌的 JSON(核心结果、focus、校验错误、待修复 JSON)一律不缩进。
 * 缩进只服务人眼:一个 6 成分句子的核心结果,美化后 827 字符、紧凑后 555,
 * 差的那 270 字符全是空格与换行。模型按结构读,排版一个字都用不上——
 * 与 MINIFIED_OUTPUT 对输出侧的要求同理,只是这一侧付的是 prefill。
 */
export function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The model addresses Tokens by ID alone, so `start`, `end`, and
 * `leadingWhitespace` are dead weight: pretty-printing the full Token record
 * inflated a prompt to roughly 35x its source text (a three-letter word cost
 * 145 characters), which paid for itself in latency on every single call.
 * Keep the ID, the text, and the punctuation flag the coverage rule leans on —
 * emitted without indentation, and only when the flag is actually set.
 */
function modelSentence(sentence: SentenceInput): Record<string, unknown> {
  return {
    sentenceId: sentence.sentenceId,
    text: sentence.text,
    tokens: sentence.tokens.map((token) => ({
      id: token.id,
      text: token.text,
      ...(token.punctuation ? { punctuation: true } : {}),
    })),
  };
}

export function serializeSentences(sentences: readonly SentenceInput[]): string {
  return JSON.stringify(sentences.map(modelSentence));
}

export function serializeSentence(sentence: SentenceInput): string {
  return JSON.stringify(modelSentence(sentence));
}

/**
 * Compatibility mode sends no response_format, so the exact output envelope
 * must be spelled out in the prompt itself. A schema-free model otherwise
 * guesses the shape (e.g. a top-level array) and fails validation.
 */
/**
 * 输出 token 数就是延迟的全部来源:实测 TTFT 恒定 ~0.65s 且与输入大小无关,总时
 * ≈ 0.65s + 输出token/190。默认的缩进 JSON 与 Markdown 围栏里,前导空格、换行和
 * 重复键名全都要逐 token 生成——一句话 466 字符里真正的信息不到三分之一。
 * 加这一条指令实测省 40% 输出 token、快 36%,而流式解析器是字符级帧解析、
 * 不依赖换行,所以紧凑输出对它无影响(core-stream-parser.test.ts 钉住了这点)。
 */
const MINIFIED_OUTPUT =
  "Output minified JSON on a single line: no newlines, no indentation, no spaces after ':' or ','. " +
  "Do not wrap it in a Markdown code fence.";

/**
 * 成分粒度的三条边界,以及它们必须按这个顺序出现的原因。
 *
 * 缺了这三条,同一个模型(deepseek-v4-flash)对指令型文本会给出词级碎片:实测
 * "Help turn ideas into fully formed designs and specs through natural collaborative
 * dialogue." 被切成 8-9 个成分——Help / turn 两个 PREDICATE、介词 into 与其宾语
 * 拆开、拆出来的名词短语再误标 ATTRIBUTE;补上后稳定收敛到 4 个短语级成分。
 *
 * 判定顺序必须写死"先分句、再句内":只把分句规则与 peer 规则并列摆着,
 * 两条会互相打架,实测同一句在两次调用之间会在两种切法之间跳。所以 peer 规则
 * 也收窄成「在单个分句之内」——它原本要挡的"谓语吞掉宾语"照旧被挡住。
 *
 * **`CORE_PROMPT_VERSION` 8 彻底废弃了 `COORDINATE_CLAUSE` 输出。** 版本 7 虽然已经让
 * validator 拒绝这种整块分句，提示词里却还残留「每个并列分句输出一个
 * `COORDINATE_CLAUSE`」的旧指令，模型照做后必然进入修复轮。现在所有并列句都按
 * subject/predicate/object 等同层成分平铺，只把 FANBOYS 并列连词单独标为
 * `CONJUNCTION`；分号可以连接两个分句，但不需要为它生成成分。
 *
 * 当年加"祈使句串整体标 COORDINATE_CLAUSE"是为了挡碎片化(6 个动词逗号串成一句时
 * 实测给出 6 个 `PREDICATE` / 16 个成分)。那条豁免现在去掉了,因为碎片化改由硬门
 * 直接拦:相邻 `PREDICATE` 必须合并、谓语首词不得是限定词/主格代词、谓语内部不得
 * 含限定词、单成分不得包住整句。
 */
const CLAUSE_FIRST_RULE =
  "Clause-structure-first rule: decide the clause layout before anything else. " +
  "A sentence is compound only when two or more clauses each carry their own subject and are joined by a coordinating conjunction (for, and, nor, but, or, yet, so) or a semicolon; " +
  "analyse every compound clause as peer components (subject, predicate, object, adverbial, …), and tag only a coordinating conjunction as its own CONJUNCTION component. Never emit COORDINATE_CLAUSE. " +
  "A comma, a colon, or a dash on its own never makes a sentence compound, and neither does a series of imperatives nor one subject shared by several verbs: " +
  "analyse every one of those as peer components of a single clause. " +
  'Tag a coordinating conjunction as CONJUNCTION only when it joins whole clauses or whole verb phrases; one inside a coordinated noun, adjective, or adverb phrase stays part of that single component ("calmly and confidently" is ONE ADVERBIAL). ' +
  "A clause introduced by a subordinating conjunction (because, although, if, when, while, since, until, as, …) must use one of the five subordinate clause roles, stay whole, and leave the main clause analysed as peer components.";

const PREDICATE_SCOPE_RULE =
  "Predicate-scope rule: inside a single clause a PREDICATE covers only the verb group — auxiliaries (can, could, may, might, must, shall, should, will, would, be, am, is, are, was, were, have, has, had, do, does, did) plus the main verb, " +
  'including any adverbs between them and any bare-infinitive chain ("Help turn" is one PREDICATE, "let go" is one PREDICATE, "must close" is one PREDICATE, "is independently deployable" is one PREDICATE). ' +
  "Two PREDICATE components must never be adjacent: side-by-side verbs belong to a single PREDICATE.";

const PREPOSITIONAL_PHRASE_RULE =
  "Prepositional-phrase rule: a preposition and everything it governs form exactly one component (ADVERBIAL or ATTRIBUTE), " +
  'including a coordinated object — "into fully formed designs and specs" is ONE ADVERBIAL, not a preposition plus separate noun phrases. ' +
  "Never emit a preposition as its own component, and never tag a noun phrase governed by a verb or preposition as ATTRIBUTE; " +
  'ATTRIBUTE is only a modifier sitting inside a noun phrase, like "fully formed" inside "fully formed designs".';

const PEER_COMPONENT_RULE =
  "Peer-component rule: within a single clause, identify the coequal grammatical components rather than labeling every verb-led span as PREDICATE. " +
  "A PREDICATE must not absorb a separable OBJECT, PREDICATIVE, COMPLEMENT, or ADVERBIAL; emit each such span as its own component.";

const SUPPLEMENT_RULE =
  "Supplement rule: text after an em dash or colon is often an explanation, reformulation, or list, not a coordinate clause and not a conjunction. " +
  "Keep the output flat and non-overlapping: use APPOSITIVE or INDEPENDENT_ELEMENT for an indivisible supplement, but when it contains separable predicate, object, or adverbial peers, emit those internal peers instead of an overlapping outer supplement. " +
  "Do not label a whole noun phrase plus its relative clause as ATTRIBUTIVE_CLAUSE: in 'the ones that matter', 'the ones' is the noun phrase and only 'that matter' is ATTRIBUTIVE_CLAUSE.";

export const CORE_OUTPUT_SHAPE = [
  "Output exactly one JSON object of this shape, not a top-level array:",
  '{"sentences": [{"sentenceId": string, "components": [{"startToken": number, "endToken": number, "role": string, "translation": string}]}]}',
  "A component must never contain only punctuation Tokens; attach punctuation to an adjacent component or leave it uncovered.",
  MINIFIED_OUTPUT,
].join("\n");

const DETAIL_OUTPUT_SHAPE = [
  "Output exactly one JSON object of this shape:",
  '{"sentenceId": string, "focus": {"startToken": number, "endToken": number}, "structures": [{"startToken": number, "endToken": number, "role": string, "explanation": string, "translation": string}], "grammarPoints": [string], "explanation": string}',
  "Echo the supplied sentenceId and focus unchanged. Write explanations, grammar points, and every structure's role field in Chinese. Use concise Chinese grammatical terms for roles (主语/谓语/宾语/定语/状语/系动词/引导词/连词 etc.), never English enum values.",
  "The structures array must break down only the internal components of the focus range. Every structure must stay inside focus, be ordered by Token ID, and be disjoint from every other structure; never return a whole span and then repeat its nested words or phrases. When the focus contains multiple lexical Tokens, never return a single structure that covers the entire focus — split it into meaningful non-overlapping sub-components; an indivisible one-Token focus may return one structure (subject, predicate, object, clauses, etc.).",
  "Give every structure a concise Chinese translation of exactly its own English text in the translation field (a few words, like a gloss under the phrase); keep the longer analysis in explanation. The translation field must be written in Chinese characters (中文译文) — copying the English words unchanged is invalid.",
  MINIFIED_OUTPUT,
].join("\n");

const SENTENCE_DETAILS_OUTPUT_SHAPE = [
  "Output exactly one JSON object of this shape:",
  '{"details": [{"sentenceId": string, "focus": {"startToken": number, "endToken": number}, "structures": [{"startToken": number, "endToken": number, "role": string, "explanation": string, "translation": string}], "grammarPoints": [string], "explanation": string}]}',
  "Return exactly one details entry per requested focus range, echoing the supplied sentenceId and that focus unchanged.",
  "Write explanations, grammar points, and every structure's role field in Chinese. Use concise Chinese grammatical terms for roles (主语/谓语/宾语/定语/状语/系动词/引导词/连词 etc.), never English enum values.",
  "Each entry's structures array must break down only the internal components of its focus range. Every structure must stay inside that focus, be ordered by Token ID, and be disjoint from every other structure; never return a whole span and then repeat its nested words or phrases. When the focus contains multiple lexical Tokens, never return a single structure that covers the entire focus — split it into meaningful non-overlapping sub-components; an indivisible one-Token focus may return one structure (subject, predicate, object, clauses, etc.).",
  "Give every structure a concise Chinese translation of exactly its own English text in the translation field (a few words, like a gloss under the phrase); keep the longer analysis in explanation. The translation field must be written in Chinese characters (中文译文) — copying the English words unchanged is invalid.",
  MINIFIED_OUTPUT,
].join("\n");

const GRAMMAR_ROLE_NAMES: readonly string[] = Object.values(GrammarRole);

/**
 * core 与 repair 共用的全套分析规则。修复轮曾只带 peer + supplement 两条,把覆盖率、
 * 角色枚举、并列/复合/简单句和译文要求全丢了——一句一旦进修复轮,剩下的唯一语法
 * 指导就是"把成分拆开",只会越修越碎。两处必须共享同一个来源。
 */
const CORE_ANALYSIS_RULES: readonly string[] = [
  `The role field is a closed ${GRAMMAR_ROLE_NAMES.length}-role enum: ${GRAMMAR_ROLE_NAMES.join(", ")}.`,
  "Every component uses a closed Token interval [startToken, endToken]; both endpoints are inclusive Token IDs from the supplied sentence.",
  'Each supplied Token is {"id","text"}; a Token is punctuation only when it carries "punctuation": true.',
  "Coverage rule: every non-punctuation Token must be covered exactly once. Components must be ordered, non-overlapping, and may include punctuation but may not contain punctuation only.",
  CLAUSE_FIRST_RULE,
  PREDICATE_SCOPE_RULE,
  PREPOSITIONAL_PHRASE_RULE,
  PEER_COMPONENT_RULE,
  SUPPLEMENT_RULE,
  "Compound-sentence rule: when two or more clauses that could each stand alone as a sentence are joined by a coordinating conjunction (for, and, nor, but, or, yet, so) or a semicolon, analyse the inside of every clause as peer components and tag only the coordinating conjunction as its own CONJUNCTION component (in a comma-plus-conjunction pair, tag only the conjunction itself). Never emit COORDINATE_CLAUSE.",
  "Complex-sentence rule: keep tagging a subordinate clause as one whole component with one of the five clause roles (SUBJECT_CLAUSE, OBJECT_CLAUSE, PREDICATIVE_CLAUSE, ATTRIBUTIVE_CLAUSE, ADVERBIAL_CLAUSE); never split its internal structure.",
  "Simple-sentence rule: analyse a sentence with a single subject-predicate structure as peer components.",
  "Give every component a concise, non-empty Chinese translation.",
];

export function buildCorePrompt(sentences: readonly SentenceInput[]): string {
  return [
    PROMPT_FIRST_LINES.core,
    ...CORE_ANALYSIS_RULES,
    "Keep every sentenceId and every supplied Token unchanged. Return JSON only, with no Markdown or explanatory prose.",
    CORE_OUTPUT_SHAPE,
    "Numbered sentence requests:",
    serializeSentences(sentences),
  ].join("\n\n");
}

export function buildRepairPrompt(
  sentences: readonly SentenceInput[],
  errors: readonly ValidationErrorDescription[],
  invalidJson: unknown,
): string {
  return [
    PROMPT_FIRST_LINES.coreRepair,
    "Do not change sentence IDs or Tokens. Do not add sentences and do not reinterpret the source text.",
    "For each PREDICATE error caused by a determiner inside the component, split that component immediately before the determiner and emit the resulting noun phrase as its own OBJECT, PREDICATIVE, or COMPLEMENT component.",
    "Check the repaired JSON against every listed validation error before returning it; do not return until each listed error has been addressed.",
    "Return the repaired JSON only, without a Markdown fence or prose.",
    ...CORE_ANALYSIS_RULES,
    CORE_OUTPUT_SHAPE,
    "Original sentence IDs and Tokens:",
    serializeSentences(sentences),
    "Validation errors:",
    serialize(errors),
    "Invalid JSON:",
    serialize(invalidJson),
  ].join("\n\n");
}

export function buildDetailPrompt(
  sentence: SentenceInput,
  verifiedCore: CoreAnalysis,
  focus: TokenRange,
): string {
  return [
    PROMPT_FIRST_LINES.detail,
    "Treat the verified core result and focus Token range as immutable. Refer only to supplied Token IDs.",
    "Return JSON only, with no Markdown or explanatory prose.",
    DETAIL_OUTPUT_SHAPE,
    "Selected sentence:",
    serializeSentence(sentence),
    "Verified core result:",
    serialize(verifiedCore),
    "Focus range:",
    serialize(focus),
  ].join("\n\n");
}

export function buildSentenceDetailsPrompt(
  sentence: SentenceInput,
  verifiedCore: CoreAnalysis,
  focuses: readonly TokenRange[],
): string {
  return [
    "Explain each requested grammatical component of the single sentence below.",
    "Treat the verified core result and every focus Token range as immutable. Refer only to supplied Token IDs.",
    "Return JSON only, with no Markdown or explanatory prose.",
    SENTENCE_DETAILS_OUTPUT_SHAPE,
    "Selected sentence:",
    serializeSentence(sentence),
    "Verified core result:",
    serialize(verifiedCore),
    "Requested focus ranges:",
    serialize(focuses),
  ].join("\n\n");
}
