package dev.codetui.englishsyntax.model

import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.domain.ValidationError
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.encodeToJsonElement

/**
 * 与 TS `JSON.stringify` 等价：只关闭缩进，不省略字段。kotlinx 的 `encodeDefaults`
 * 默认是 false，会把带默认值的字段（如 CoreAnalysis.schemaVersion = 1）从内嵌结果里
 * 吞掉，造成跨端 prompt 分叉，所以这里必须显式置 true。
 */
private val promptJson = Json {
  prettyPrint = false
  encodeDefaults = true
}

/** prompt 内嵌 JSON 一律不缩进；模型按结构读，排版一个字符都用不上。 */
fun serialize(value: JsonElement): String = promptJson.encodeToString(JsonElement.serializer(), value)

/** 域对象转可序列化 JSON 元素（修复 prompt 里内嵌核心结果/focus 时使用）。 */
fun CoreAnalysis.toJsonElement(): JsonElement = promptJson.encodeToJsonElement(CoreAnalysis.serializer(), this)

fun TokenRange.toJsonElement(): JsonElement = buildJsonObject {
  put("startToken", startToken)
  put("endToken", endToken)
}

private fun modelSentence(sentence: SentenceInput): JsonObject = buildJsonObject {
  put("sentenceId", sentence.sentenceId)
  put("text", sentence.text)
  putJsonArray("tokens") {
    for (token in sentence.tokens) {
      addJsonObject {
        put("id", token.id)
        put("text", token.text)
        if (token.punctuation) put("punctuation", true)
      }
    }
  }
}

fun serializeSentence(sentence: SentenceInput): String = serialize(modelSentence(sentence))

fun serializeSentences(sentences: List<SentenceInput>): String =
  serialize(buildJsonArray { sentences.forEach { add(modelSentence(it)) } })

private const val MINIFIED_OUTPUT =
  "Output minified JSON on a single line: no newlines, no indentation, no spaces after ':' or ','. " +
    "Do not wrap it in a Markdown code fence."

/**
 * 成分粒度的三条边界，以及它们必须按这个顺序出现的原因。
 *
 * 缺了这三条，同一个模型（deepseek-v4-flash）对指令型文本会给出词级碎片：实测
 * "Help turn ideas into fully formed designs and specs through natural collaborative
 * dialogue." 被切成 8-9 个成分——Help / turn 两个 PREDICATE、介词 into 与其宾语拆开、
 * 拆出来的名词短语再误标 ATTRIBUTE；补上后稳定收敛到 4 个短语级成分。
 * 判定顺序必须写死"先分句、再句内"：只把分句规则与 peer 规则并列摆着，两条会
 * 互相打架，实测同一句在两次调用之间会在两种切法之间跳。所以 peer 规则也收窄成
 * 「在单个分句之内」——它原本要挡的"谓语吞掉宾语"照旧被挡住。
 *
 * **CORE_PROMPT_VERSION 8 彻底废弃了 COORDINATE_CLAUSE 输出。** 版本 7 虽然已经让
 * validator 拒绝这种整块分句，提示词里却还残留「每个并列分句输出一个
 * COORDINATE_CLAUSE」的旧指令，模型照做后必然进入修复轮。现在所有并列句都按
 * subject/predicate/object 等同层成分平铺，只把 FANBOYS 并列连词单独标为
 * CONJUNCTION；分号可以连接两个分句，但不需要为它生成成分。
 *
 * 与 Chrome 端 `prompts.ts` 逐字一致，由 shared-fixtures/core-prompt-parity.json 钉住。
 */
private const val CLAUSE_FIRST_RULE =
  "Clause-structure-first rule: decide the clause layout before anything else. " +
    "A sentence is compound only when two or more clauses each carry their own subject and are joined by a coordinating conjunction (for, and, nor, but, or, yet, so) or a semicolon; " +
    "analyse every compound clause as peer components (subject, predicate, object, adverbial, …), and tag only a coordinating conjunction as its own CONJUNCTION component. Never emit COORDINATE_CLAUSE. " +
    "A comma, a colon, or a dash on its own never makes a sentence compound, and neither does a series of imperatives nor one subject shared by several verbs: " +
    "analyse every one of those as peer components of a single clause. " +
    "Tag a coordinating conjunction as CONJUNCTION only when it joins whole clauses or whole verb phrases; one inside a coordinated noun, adjective, or adverb phrase stays part of that single component (\"calmly and confidently\" is ONE ADVERBIAL). " +
    "A clause introduced by a subordinating conjunction (because, although, if, when, while, since, until, as, …) must use one of the five subordinate clause roles, stay whole, and leave the main clause analysed as peer components."

/**
 * `"is independently deployable" is one PREDICATE` 这个例子废弃了：它与
 * `PEER_COMPONENT_RULE`（PREDICATE 不得吸收可分离的 PREDICATIVE）直接打架，
 * 黄金集里 `are` + `the front door`、`seem` + `clear enough` 都是拆开的。
 * 两种口径混用时同一句在两次调用之间会跳，所以这里把系表结构定死成
 * 「系动词单独、补足部分标 PREDICATIVE」。
 */
private const val PREDICATE_SCOPE_RULE =
  "Predicate-scope rule: inside a single clause a PREDICATE covers only the verb group — auxiliaries (can, could, may, might, must, shall, should, will, would, be, am, is, are, was, were, have, has, had, do, does, did) plus the main verb, " +
    "including any adverbs between them and any bare-infinitive chain (\"Help turn\" is one PREDICATE, \"let go\" is one PREDICATE, \"must close\" is one PREDICATE). " +
    "Passive, perfect, and progressive forms keep be/have inside the verb group (\"was rebuilt\", \"have been told\", \"is deflating\" are each one PREDICATE), " +
    "but a linking verb takes only the verb itself and whatever completes it becomes its own PREDICATIVE " +
    "(\"Be clear\" is PREDICATE \"Be\" plus PREDICATIVE \"clear\"; \"are widely beneficial\" is PREDICATE \"are\" plus PREDICATIVE \"widely beneficial\"). " +
    "Two PREDICATE components must never be adjacent: side-by-side verbs belong to a single PREDICATE."

/**
 * 旧文案把 ATTRIBUTE 限死成「名词短语内部的修饰语」并只给了前置修饰的例子，
 * 后置的介词短语于是无处可归，模型一律退回 ADVERBIAL——`the development` +
 * `of applications` 实测就被标成宾语 + 状语，而这正是技术文档里最高频的结构。
 * 黄金集 conventions 与手工标注本来就是 ATTRIBUTE，提示词那半边在这里补齐。
 */
private const val PREPOSITIONAL_PHRASE_RULE =
  "Prepositional-phrase rule: a preposition and everything it governs form exactly one component (ADVERBIAL or ATTRIBUTE), " +
    "including a coordinated object — \"into fully formed designs and specs\" is ONE ADVERBIAL, not a preposition plus separate noun phrases. " +
    "Never emit a preposition as its own component and never let a component end on a preposition. " +
    "Pick between the two roles by what the phrase modifies: a prepositional phrase that directly follows the noun phrase it modifies is ATTRIBUTE, " +
    "so \"the development\" plus \"of applications\" is OBJECT plus ATTRIBUTE and \"Four\" plus \"of the biggest US technology companies\" is SUBJECT plus ATTRIBUTE — never ADVERBIAL; " +
    "a phrase that modifies the verb or the whole clause is ADVERBIAL. " +
    "Quantity and part expressions follow the same split, with no exception for \"a lot of\", \"some of\", or \"no amount of\". " +
    "Do not split a prepositional phrase that already sits inside another one: \"without looking at any of the code\" stays ONE ADVERBIAL. " +
    "ATTRIBUTE is a modifier attached to a noun phrase, either in front of it " +
    "(\"fully formed\" inside \"fully formed designs\") or behind it (\"signed yesterday\" in \"The documents signed yesterday\"); " +
    "never tag a noun phrase governed by a verb or preposition as ATTRIBUTE."

private const val PEER_COMPONENT_RULE =
  "Peer-component rule: within a single clause, identify the coequal grammatical components rather than labeling every verb-led span as PREDICATE. " +
    "A PREDICATE must not absorb a separable OBJECT, PREDICATIVE, COMPLEMENT, or ADVERBIAL; emit each such span as its own component."

private const val SUPPLEMENT_RULE =
  "Supplement rule: text after an em dash or colon is often an explanation, reformulation, or list, not a coordinate clause and not a conjunction. " +
    "Keep the output flat and non-overlapping: use APPOSITIVE or INDEPENDENT_ELEMENT for an indivisible supplement, but when it contains separable predicate, object, or adverbial peers, emit those internal peers instead of an overlapping outer supplement. " +
    "Do not label a whole noun phrase plus its relative clause as ATTRIBUTIVE_CLAUSE: in 'the ones that matter', 'the ones' is the noun phrase and only 'that matter' is ATTRIBUTIVE_CLAUSE."

private val CORE_OUTPUT_SHAPE = listOf(
  "Output exactly one JSON object of this shape, not a top-level array:",
  """{"sentences": [{"sentenceId": string, "components": [{"startToken": number, "endToken": number, "role": string, "translation": string}]}]}""",
  "A component must never contain only punctuation Tokens; attach punctuation to an adjacent component or leave it uncovered.",
  MINIFIED_OUTPUT,
).joinToString("\n")

private val DETAIL_OUTPUT_SHAPE = listOf(
  "Output exactly one JSON object of this shape:",
  """{"sentenceId": string, "focus": {"startToken": number, "endToken": number}, "structures": [{"startToken": number, "endToken": number, "role": string, "explanation": string, "translation": string}], "grammarPoints": [string], "explanation": string}""",
  "Echo the supplied sentenceId and focus unchanged. Write explanations, grammar points, and every structure's role field in Chinese. Use concise Chinese grammatical terms for roles (主语/谓语/宾语/定语/状语/系动词/引导词/连词 etc.), never English enum values.",
  "The structures array must break down only the internal components of the focus range. Every structure must stay inside focus, be ordered by Token ID, and be disjoint from every other structure; never return a whole span and then repeat its nested words or phrases. When the focus contains multiple lexical Tokens, never return a single structure that covers the entire focus — split it into meaningful non-overlapping sub-components; an indivisible one-Token focus may return one structure (subject, predicate, object, clauses, etc.).",
  "Give every structure a concise Chinese translation of exactly its own English text in the translation field (a few words, like a gloss under the phrase); keep the longer analysis in explanation. The translation field must be written in Chinese characters (中文译文) — copying the English words unchanged is invalid.",
  MINIFIED_OUTPUT,
).joinToString("\n")

private val GRAMMAR_ROLE_NAMES: List<String> = GrammarRole.entries.map { it.name }

/**
 * core 与 repair 共用的全套分析规则。修复轮曾只带 peer + supplement 两条，把覆盖率、
 * 角色枚举、并列/复合/简单句和译文要求全丢了——一句一旦进修复轮，剩下的唯一语法
 * 指导就是"把成分拆开"，只会越修越碎。两处必须共享同一个来源。
 */
private val CORE_ANALYSIS_RULES: List<String> = listOf(
  "The role field is a closed ${GRAMMAR_ROLE_NAMES.size}-role enum: ${GRAMMAR_ROLE_NAMES.joinToString(", ")}.",
  "Every component uses a closed Token interval [startToken, endToken]; both endpoints are inclusive Token IDs from the supplied sentence.",
  """Each supplied Token is {"id","text"}; a Token is punctuation only when it carries "punctuation": true.""",
  "Coverage rule: every non-punctuation Token must be covered exactly once. Components must be ordered, non-overlapping, and may include punctuation but may not contain punctuation only.",
  CLAUSE_FIRST_RULE,
  PREDICATE_SCOPE_RULE,
  PREPOSITIONAL_PHRASE_RULE,
  PEER_COMPONENT_RULE,
  SUPPLEMENT_RULE,
  "Compound-sentence rule: when two or more clauses that could each stand alone as a sentence are joined by a coordinating conjunction (for, and, nor, but, or, yet, so) or a semicolon, analyse the inside of every clause as peer components and tag only the coordinating conjunction as its own CONJUNCTION component (in a comma-plus-conjunction pair, tag only the conjunction itself). Never emit COORDINATE_CLAUSE.",
  "Complex-sentence rule: tag a subordinate clause as one whole component with one of the five clause roles (SUBJECT_CLAUSE, OBJECT_CLAUSE, PREDICATIVE_CLAUSE, ATTRIBUTIVE_CLAUSE, ADVERBIAL_CLAUSE) and never split its internal structure. " +
    "The component runs from the introducing word through that clause's own subject, predicate, object, and adverbials, so never stop a clause component at its introducing word and never emit the clause's own predicate, object, or adverbial as a peer of the main clause: " +
    "in \"Apple tests Siri feature that handles multiple commands at once\", \"that handles multiple commands at once\" is ONE ATTRIBUTIVE_CLAUSE — \"that\" on its own is wrong, and so is \"that handles\" followed by a separate OBJECT. " +
    "A clause whose introducing word is omitted is still one whole component: in \"That means developers now play a frontline role\", \"developers now play a frontline role\" is ONE OBJECT_CLAUSE.",
  "Simple-sentence rule: analyse a sentence with a single subject-predicate structure as peer components.",
  "Give every component a concise, non-empty Chinese translation that renders everything the component covers rather than only its head word: " +
    "\"incorporate artificial intelligence functionality\" is \"整合人工智能功能\", not \"整合\", and \"of applications\" is \"应用程序的\", not \"的\".",
)

fun buildCorePrompt(sentences: List<SentenceInput>): String =
  (
    listOf("Analyze the numbered English sentences below into core grammatical components.") +
      CORE_ANALYSIS_RULES +
      listOf(
        "Keep every sentenceId and every supplied Token unchanged. Return JSON only, with no Markdown or explanatory prose.",
        CORE_OUTPUT_SHAPE,
        "Numbered sentence requests:",
        serializeSentences(sentences),
      )
    ).joinToString("\n\n")

fun buildRepairPrompt(
  sentences: List<SentenceInput>,
  errors: List<ValidationError>,
  invalidJson: JsonElement,
): String = (
  listOf(
    "Repair only the structure of the invalid core-analysis JSON so it satisfies every validation error.",
    "Do not change sentence IDs or Tokens. Do not add sentences and do not reinterpret the source text.",
    "For each PREDICATE error caused by a determiner inside the component, split that component immediately before the determiner and emit the resulting noun phrase as its own OBJECT, PREDICATIVE, or COMPLEMENT component.",
    "Check the repaired JSON against every listed validation error before returning it; do not return until each listed error has been addressed.",
    "Return the repaired JSON only, without a Markdown fence or prose.",
  ) +
    CORE_ANALYSIS_RULES +
    listOf(
      CORE_OUTPUT_SHAPE,
      "Original sentence IDs and Tokens:",
      serializeSentences(sentences),
      "Validation errors:",
      serialize(promptJson.encodeToJsonElement(errors)),
      "Invalid JSON:",
      serialize(invalidJson),
    )
  ).joinToString("\n\n")

fun buildDetailPrompt(
  sentence: SentenceInput,
  verifiedCore: CoreAnalysis,
  focus: TokenRange,
): String = listOf(
  "Explain only the selected grammatical component in the single sentence below.",
  "Treat the verified core result and focus Token range as immutable. Refer only to supplied Token IDs.",
  "Return JSON only, with no Markdown or explanatory prose.",
  DETAIL_OUTPUT_SHAPE,
  "Selected sentence:",
  serializeSentence(sentence),
  "Verified core result:",
  serialize(promptJson.encodeToJsonElement(verifiedCore)),
  "Focus range:",
  serialize(promptJson.encodeToJsonElement(focus)),
).joinToString("\n\n")
