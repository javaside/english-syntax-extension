import { GrammarRole } from "../shared/grammar";
import type { CoreAnalysis, TokenRange } from "../shared/grammar";
import type { SentenceInput } from "../shared/protocol";
import type { RepairErrorGroup } from "./repair-errors";

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
 * completeness-first 排最前:先判输入是否构成分句(带定式谓语、或省略主语的
 * 祈使句,都算分句),再交给 clause-first 决定分句层级——不构成分句的片段标
 * FRAGMENT_HEAD,不为凑句型凭空造主谓宾。版本 13 在这条里补了页面语料的两组
 * 对照:片段内的限定/零关系词定语从句不再把输入变成完整句;标题式冒号长句按
 * 四段口径拆,冒号后是完整分句时反而按同层角色展开。
 *
 * `CORE_PROMPT_VERSION` 8 起彻底废弃 `COORDINATE_CLAUSE` 输出:所有并列句都按
 * subject/predicate/object 等同层成分平铺,只把 FANBOYS 并列连词单独标为
 * `CONJUNCTION`。版本 13 把旧的 Compound-sentence / Simple-sentence 两条独立
 * 规则并入这里的分句层级叙述,消除三处重复口径。
 */
const COMPLETENESS_FIRST_RULE =
  "Completeness-first rule: before assigning clause roles, decide whether the input forms a clause. " +
  "An input with an explicit finite predicate of its own, or an imperative with an omitted subject, is a clause and uses the clause-level roles; " +
  'a finite verb inside an embedded relative clause does not count — "The tool that we built passes every test" keeps PREDICATE "passes" at the top level instead of becoming a fragment. ' +
  "A heading, list item, noun phrase, adjective phrase, or non-finite verb phrase that does not form a clause must contain exactly one FRAGMENT_HEAD; never invent SUBJECT, PREDICATE, OBJECT, PREDICATIVE, or ADVERBIAL merely to force a fragment into a clause pattern. " +
  "A noun-phrase fragment may contain one embedded relative clause: " +
  '"An API that returns JSON responses" is FRAGMENT_HEAD "An API" plus ATTRIBUTIVE_CLAUSE "that returns JSON responses", and the finite verb inside that embedded clause does not turn the whole input into a main clause. ' +
  "Keep ordinary determiners and tightly bound single-word premodifiers with the FRAGMENT_HEAD, and emit separable postmodifying prepositional, participial, or infinitive phrases as ATTRIBUTE. " +
  '"Portable API support across AI providers for Chat, text-to-image, and Embedding models" is FRAGMENT_HEAD "Portable API support" plus ATTRIBUTE "across AI providers" plus ATTRIBUTE "for Chat, text-to-image, and Embedding models". ' +
  'An imperative is a clause, not a fragment: "Install the CLI" is PREDICATE "Install" plus OBJECT "the CLI". ' +
  "A sentence is compound only when two or more clauses each carry their own subject and are joined by a coordinating conjunction (for, and, nor, but, or, yet, so) or a semicolon; " +
  "analyse every compound clause as peer components and tag only the coordinating conjunction as its own CONJUNCTION component. Never emit COORDINATE_CLAUSE. " +
  "A comma, colon, dash, series of imperatives, or one subject shared by several verbs never makes a sentence compound: analyse all of those as peer components of a single clause.";

/**
 * 版本 13 的标题冒号口径:arXiv 论文长标题「前半活动片段 + 冒号 + 后半再说明」
 * 整块标成一个 FRAGMENT_HEAD 会超过 10 实词的片段上限,所以在冒号处拆成
 * FRAGMENT_HEAD + ATTRIBUTE + APPOSITIVE + ATTRIBUTE,冒号本身保持未覆盖;
 * 反例钉住「不是所有冒号后文本都是 APPOSITIVE」。
 */
const TRAILING_CITATION_RULE =
  'Trailing-citation rule: a bibliography citation at the sentence end (as [61]) is absorbed into the preceding component ("…probe in the 1980s [61]." = ADVERBIAL "in the 1980s [61]"); a bracketed list value (\'The vector is [1, 2].\') is sentence content, not a citation.';

const HEADING_NUMBER_RULE =
  'Heading-number rule: a section number (IV.2, II.2.2) never stands alone; number and headword form one FRAGMENT_HEAD ("IV.2 Implications for the future" = FRAGMENT_HEAD "IV.2 Implications" + ATTRIBUTE "for the future").';

const COLON_TITLE_RULE =
  "Colon-title rule: an indivisible supplement after a dash or colon takes APPOSITIVE or INDEPENDENT_ELEMENT, " +
  "but when the supplement contains separable predicate, object, or adverbial peers, emit those internal peers instead of an overlapping outer supplement. " +
  "A long title whose part after the colon renames the part before it splits at the colon, and the colon stays uncovered: " +
  'in "Expanding the scope of dark siren cosmology: Inferring the population properties of gravitational wave-hosting galaxies", "Inferring the population properties" is ONE APPOSITIVE between FRAGMENT_HEAD "Expanding the scope", ATTRIBUTE "of dark siren cosmology", and ATTRIBUTE "of gravitational wave-hosting galaxies". ' +
  'Do not mechanically tag everything after a colon as APPOSITIVE: in "The result is clear: the sampled prior reduces uncertainty", "the sampled prior reduces uncertainty" is a full clause and is analysed as peer SUBJECT, PREDICATE, and OBJECT. ' +
  "Do not label a whole noun phrase plus its relative clause as ATTRIBUTIVE_CLAUSE: in 'the ones that matter', only 'that matter' is ATTRIBUTIVE_CLAUSE.";

const CLAUSE_FIRST_RULE =
  "Clause-structure rule: decide the clause layout before anything else. " +
  "A clause introduced by a subordinating conjunction (because, although, if, when, while, since, until, as, …) must use one of the five subordinate clause roles, stay whole, and leave the main clause analysed as peer components. " +
  'A when/before/after/if clause with its own finite predicate is ONE ADVERBIAL_CLAUSE ("when methods are called"), but when/before/after followed by a non-finite verb phrase stays at phrase level as ONE ADVERBIAL ("when performing tool calling"). ' +
  "Inside a full clause a non-finite phrase keeps its normal role (a gerund phrase as SUBJECT or OBJECT, a participial opener as ADVERBIAL); FRAGMENT_HEAD applies only when the whole input is not a clause.";

/**
 * 版本 13 把五类从句、零关系词从句、并列结构(VP vs NP)、宾语控制结构、
 * 非限定补足成分合并进「成分粒度规则」一条:它们全是「从句/短语从父节点
 * 截断后单列」的同一条粒度纪律的具体情形,分散在五条规则里只会互相重复。
 */
const COMPONENT_GRANULARITY_RULE =
  "Component-granularity rule: tag every subordinate clause as ONE whole component running from its introducing word through that clause's own subject, predicate, object, and adverbials — " +
  "never stop a clause component at its introducing word and never emit the clause's own predicate, object, or adverbial as a peer of the main clause. " +
  'In "Apple tests Siri feature that handles multiple commands at once", "that handles multiple commands at once" is ONE ATTRIBUTIVE_CLAUSE — "that" on its own is wrong, and so is "that handles" followed by a separate OBJECT; ' +
  'in "That means developers now play a frontline role", "developers now play a frontline role" is ONE OBJECT_CLAUSE. ' +
  "A relative clause whose introducing word is omitted is still ONE ATTRIBUTIVE_CLAUSE cut from the noun phrase it modifies: " +
  '"a typed object the rest of the codebase can treat" is OBJECT "a typed object" plus ATTRIBUTIVE_CLAUSE "the rest of the codebase can treat". ' +
  'The five clause roles have one example each: PREDICATIVE_CLAUSE completes a linking verb ("The real problem is that the cache entry has expired"), SUBJECT_CLAUSE acts as the subject ("Whoever wins the race gets the final ticket"), and ADVERBIAL_CLAUSE modifies the main clause ("Because the road was flooded, the bus took a longer route"). ' +
  'Coordinate verb phrases sharing one subject are peer PREDICATEs: in "They measure the time and propagate the results", "and" is its own CONJUNCTION joining two verb phrases that share one subject, while a conjunction inside a coordinated noun, adjective, or adverb phrase stays part of that single component — in "a Claude subscription or Anthropic Console account", "or" stays inside the single OBJECT ("calmly and confidently" is ONE ADVERBIAL). ' +
  'With allow/force/let plus a noun phrase plus an infinitive, the verb is PREDICATE, the noun phrase is OBJECT, and the infinitive phrase is COMPLEMENT ("allows Maven to access repositories" is PREDICATE "allows" plus OBJECT "Maven" plus COMPLEMENT "to access repositories"); a bare-infinitive chain without its own object stays inside the PREDICATE ("Help turn" is one PREDICATE, "let go" is one PREDICATE). ' +
  'A non-finite complement phrase keeps its own object inside one COMPLEMENT ("is steered to produce text" is PREDICATE "is steered" plus COMPLEMENT "to produce text"); an object complement after the object is a separate COMPLEMENT ("We consider the tool essential" is OBJECT "the tool" plus COMPLEMENT "essential"). ' +
  'A comma-braced renaming noun phrase is ONE APPOSITIVE ("Claude Code, an AI coding assistant, helps"), and a sentence-initial comment adverb is ONE INDEPENDENT_ELEMENT ("Fortunately, the deployment finished").';

/**
 * `["is independently deployable"] is one PREDICATE` 之类的旧例子已废弃:
 * 系表结构定死「系动词单独、补足部分标 PREDICATIVE」。版本 13 把
 * been/being/having 补进助动词清单。
 */
const PREDICATE_SCOPE_RULE =
  "Predicate-scope rule: inside a single clause a PREDICATE covers only the verb group — auxiliaries (can, could, may, might, must, shall, should, will, would, be, am, is, are, was, were, been, being, having, have, has, had, do, does, did) plus the main verb, " +
  "including any adverbs between them. " +
  'Passive, perfect, and progressive forms keep be/have inside the verb group ("was rebuilt", "have been told", "is deflating" are each one PREDICATE), ' +
  "but a linking verb takes only the verb itself and whatever completes it becomes its own PREDICATIVE " +
  '("Be clear" is PREDICATE "Be" plus PREDICATIVE "clear"; "are widely beneficial" is PREDICATE "are" plus PREDICATIVE "widely beneficial"). ' +
  "Two PREDICATE components must never be adjacent: side-by-side verbs belong to a single PREDICATE.";

/**
 * PP 依附的现有角色映射(动词管辖→ADVERBIAL、名词后所选→ATTRIBUTE、
 * 外层 PP 内部不再拆、pay attention to 特例)按 spec §4.3 写成一对对正例。
 */
const PREPOSITIONAL_PHRASE_RULE =
  "Prepositional-phrase rule: a preposition and everything it governs form exactly one component (ADVERBIAL or ATTRIBUTE), " +
  'including a coordinated object — "into fully formed designs and specs" is ONE ADVERBIAL, not a preposition plus separate noun phrases. ' +
  "Never emit a preposition as its own component and never let a component end on a preposition. " +
  "Pick between the two roles by what the phrase attaches to: " +
  'a prepositional phrase expressing where/when/how the action happens is ADVERBIAL, and a degree adverb in front of it stays its own ADVERBIAL component ("Claude Code works directly with git." is SUBJECT "Claude Code", PREDICATE "works", ADVERBIAL "directly", and ADVERBIAL "with git"); ' +
  'a prepositional phrase selecting or describing the preceding noun is ATTRIBUTE ("an open standard for connecting AI tools" is PREDICATIVE "an open standard" plus ATTRIBUTE "for connecting AI tools", and "the development" plus "of applications" is OBJECT plus ATTRIBUTE). ' +
  'Quantity and part expressions follow the same split, with no exception for "a lot of", "some of", or "no amount of". ' +
  'Do not split a prepositional phrase that already sits inside another one: "without looking at any of the code" stays ONE ADVERBIAL. ' +
  'Fixed verb-preposition frames keep the governed noun as OBJECT and the phrase as ATTRIBUTE: "pay attention to the details" is PREDICATE "pay" plus OBJECT "attention" plus ATTRIBUTE "to the details". ' +
  'ATTRIBUTE is a modifier attached to a noun phrase, either in front of it ("fully formed" inside "fully formed designs") or behind it ("signed yesterday"); ' +
  "never tag a noun phrase governed by a verb or preposition as ATTRIBUTE.";

const PEER_COMPONENT_RULE =
  "Peer-component rule: within a single clause, identify the coequal grammatical components rather than labeling every verb-led span as PREDICATE. " +
  "A PREDICATE must not absorb a separable OBJECT, PREDICATIVE, COMPLEMENT, or ADVERBIAL; emit each such span as its own component.";

export const CORE_OUTPUT_SHAPE = [
  "Output exactly one JSON object of this shape, not a top-level array:",
  '{"sentences": [{"sentenceId": string, "components": [{"startToken": number, "endToken": number, "role": string, "translation": string}]}]}',
  "A component must never contain only punctuation Tokens; attach punctuation to an adjacent component or leave it uncovered.",
  MINIFIED_OUTPUT,
].join("\n");

/**
 * 中文角色术语词表:detail 与 detail 修复轮共用。低频角色(表语/同位语/补语/
 * 独立成分/片段主体)必须出现,否则修复轮之后 role 词表缩水。
 */
const CHINESE_ROLE_GLOSSARY =
  "Use concise Chinese grammatical terms for roles (主语/谓语/宾语/定语/状语/表语/补语/同位语/独立成分/片段主体/系动词/引导词/连词 etc.), never English enum values.";

export const DETAIL_OUTPUT_SHAPE = [
  "Output exactly one JSON object of this shape:",
  '{"sentenceId": string, "focus": {"startToken": number, "endToken": number}, "structures": [{"startToken": number, "endToken": number, "role": string, "explanation": string, "translation": string}], "grammarPoints": [string], "explanation": string}',
  `Echo the supplied sentenceId and focus unchanged. Write explanations, grammar points, and every structure's role field in Chinese. ${CHINESE_ROLE_GLOSSARY}`,
  "The structures array must break down only the internal components of the focus range. Every structure must stay inside focus, be ordered by Token ID, and be disjoint from every other structure; never return a whole span and then repeat its nested words or phrases. When the focus contains multiple lexical Tokens, never return a single structure that covers the entire focus — split it into meaningful non-overlapping sub-components; an indivisible one-Token focus may return one structure (subject, predicate, object, clauses, etc.).",
  "Give every structure a concise Chinese translation of exactly its own English text in the translation field (a few words, like a gloss under the phrase); keep the longer analysis in explanation. The translation field must be written in Chinese characters (中文译文) — copying the English words unchanged is invalid.",
  MINIFIED_OUTPUT,
].join("\n");

export const SENTENCE_DETAILS_OUTPUT_SHAPE = [
  "Output exactly one JSON object of this shape:",
  '{"details": [{"sentenceId": string, "focus": {"startToken": number, "endToken": number}, "structures": [{"startToken": number, "endToken": number, "role": string, "explanation": string, "translation": string}], "grammarPoints": [string], "explanation": string}]}',
  "Return exactly one details entry per requested focus range, echoing the supplied sentenceId and that focus unchanged.",
  `Write explanations, grammar points, and every structure's role field in Chinese. ${CHINESE_ROLE_GLOSSARY}`,
  "Each entry's structures array must break down only the internal components of its focus range. Every structure must stay inside that focus, be ordered by Token ID, and be disjoint from every other structure; never return a whole span and then repeat its nested words or phrases. When the focus contains multiple lexical Tokens, never return a single structure that covers the entire focus — split it into meaningful non-overlapping sub-components; an indivisible one-Token focus may return one structure (subject, predicate, object, clauses, etc.).",
  "Give every structure a concise Chinese translation of exactly its own English text in the translation field (a few words, like a gloss under the phrase); keep the longer analysis in explanation. The translation field must be written in Chinese characters (中文译文) — copying the English words unchanged is invalid.",
  MINIFIED_OUTPUT,
].join("\n");

const GRAMMAR_ROLE_NAMES: readonly string[] = Object.values(GrammarRole);

/**
 * core 与 repair 共用的全套分析规则。修复轮曾只带 peer + supplement 两条,把覆盖率、
 * 角色枚举、并列/复合/简单句和译文要求全丢了——一句一旦进修复轮,剩下的唯一语法
 * 指导就是"把成分拆开",只会越修越碎。两处必须共享同一个来源。
 *
 * 版本 13 重写:删除了与黄金集 conventions 冲突/重复的旧句(独立的
 * Compound-sentence 与 Simple-sentence 条目并入 completeness-first 的分句层级
 * 叙述),页面语料新增句型全部以「正例 + 最接近反例」的对偶形式给出。
 */
const CORE_ANALYSIS_RULES: readonly string[] = [
  `The role field is a closed ${GRAMMAR_ROLE_NAMES.length}-role enum: ${GRAMMAR_ROLE_NAMES.join(", ")}.`,
  "Every component uses a closed Token interval [startToken, endToken]; both endpoints are inclusive Token IDs from the supplied sentence.",
  'Each supplied Token is {"id","text"}; a Token is punctuation only when it carries "punctuation": true.',
  "Coverage rule: every non-punctuation Token must be covered exactly once. Components must be ordered, non-overlapping, and may include punctuation but may not contain punctuation only.",
  COMPLETENESS_FIRST_RULE,
  COLON_TITLE_RULE,
  TRAILING_CITATION_RULE,
  HEADING_NUMBER_RULE,
  CLAUSE_FIRST_RULE,
  COMPONENT_GRANULARITY_RULE,
  PREDICATE_SCOPE_RULE,
  PREPOSITIONAL_PHRASE_RULE,
  PEER_COMPONENT_RULE,
  "Give every component a concise, non-empty Chinese translation that renders everything the component covers rather than only its head word: " +
    '"incorporate artificial intelligence functionality" is "整合人工智能功能", not "整合", and "of applications" is "应用程序的", not "的". ' +
    'Proper names keep their English form and add a short Chinese type: "Spring AI 框架", "JSON 数据格式", "哈勃常数 H0"; a translation that only copies or echoes the English span is invalid and will be rejected.',
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
  groups: readonly RepairErrorGroup[],
  invalidJson: unknown,
): string {
  return [
    PROMPT_FIRST_LINES.coreRepair,
    "Do not change sentence IDs or Tokens. Do not add sentences and do not reinterpret the source text.",
    "Each error group below carries one sentenceId: apply its errors to that sentence only, never to another sentence in the same payload. A group's components[k] refers to entry k of that sentence's components array in the Invalid JSON below.",
    "Ranges, roles and translations may be corrected, but sentence IDs and Tokens must not change.",
    "For each PREDICATE error caused by a determiner inside the component, split that component immediately before the determiner and emit the resulting noun phrase as its own OBJECT, PREDICATIVE, or COMPLEMENT component.",
    "Check the repaired JSON against every listed validation error before returning it; do not return until each listed error has been addressed.",
    "Return the repaired JSON only, without a Markdown fence or prose.",
    ...CORE_ANALYSIS_RULES,
    CORE_OUTPUT_SHAPE,
    "Original sentence IDs and Tokens:",
    serializeSentences(sentences),
    "Validation errors:",
    serialize(groups),
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
