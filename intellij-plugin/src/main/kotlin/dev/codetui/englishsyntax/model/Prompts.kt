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
 * **CORE_PROMPT_VERSION 7 收紧了并列句的判据。** 此前只要「两个以上各带谓语的分句被
 * 逗号/冒号/分号/破折号/并列连词分隔」就整句一个 COORDINATE_CLAUSE，并且明令"不要分析
 * 任何分句的内部"。真实散文绝大多数是多分句的，于是卡片退化成 2-3 个巨大色块、每块挂
 * 一整句中文——看着就是译文而不是成分划分；主从复合句还会被标成并列句。现在并列句要求
 * 各分句自带主语且由并列连词或分号连接；逗号串起来的祈使句、共享主语的并列谓语一律按
 * 同层成分平铺。碎片化改由硬门直接拦（相邻 PREDICATE 合并、谓语首词/内部限定词、
 * 单成分不得包住整句），不再靠"祈使句串整体标 COORDINATE_CLAUSE"这条豁免。
 *
 * 与 Chrome 端 `prompts.ts` 逐字一致，由 shared-fixtures/core-prompt-parity.json 钉住。
 */
private const val CLAUSE_FIRST_RULE =
  "Clause-structure-first rule: decide the clause layout before anything else. " +
    "A sentence is compound only when two or more clauses each carry their own subject and are joined by a coordinating conjunction (for, and, nor, but, or, yet, so) or a semicolon; " +
    "only then emit exactly one COORDINATE_CLAUSE per clause, carrying the complete Chinese translation of that clause plus the coordinating conjunction as its own CONJUNCTION component, and do not analyse the inside of those clauses. " +
    "A comma, a colon, or a dash on its own never makes a sentence compound, and neither does a series of imperatives nor one subject shared by several verbs: " +
    "analyse every one of those as peer components of a single clause (subject, predicate, object, adverbial, …). " +
    "Tag a coordinating conjunction as CONJUNCTION only when it joins whole clauses or whole verb phrases; one inside a coordinated noun, adjective, or adverb phrase stays part of that single component (\"calmly and confidently\" is ONE ADVERBIAL). " +
    "A clause introduced by a subordinating conjunction (because, although, if, when, while, since, until, as, …) is never a COORDINATE_CLAUSE: " +
    "tag it with one of the five subordinate clause roles, keep it whole, and analyse the main clause as peer components."

private const val PREDICATE_SCOPE_RULE =
  "Predicate-scope rule: inside a single clause a PREDICATE covers only the verb group — auxiliaries plus the main verb, " +
    "including a bare-infinitive chain that belongs to it (\"Help turn\" is one PREDICATE, \"let go\" is one PREDICATE). " +
    "Two PREDICATE components must never be adjacent: side-by-side verbs belong to a single PREDICATE."

private const val PREPOSITIONAL_PHRASE_RULE =
  "Prepositional-phrase rule: a preposition and everything it governs form exactly one component (ADVERBIAL or ATTRIBUTE), " +
    "including a coordinated object — \"into fully formed designs and specs\" is ONE ADVERBIAL, not a preposition plus separate noun phrases. " +
    "Never emit a preposition as its own component, and never tag a noun phrase governed by a verb or preposition as ATTRIBUTE; " +
    "ATTRIBUTE is only a modifier sitting inside a noun phrase, like \"fully formed\" inside \"fully formed designs\"."

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
  "Compound-sentence rule: when two or more clauses that could each stand alone as a sentence are joined by a coordinating conjunction (for, and, nor, but, or, yet, so) or a semicolon, tag each clause as one whole COORDINATE_CLAUSE whose translation is the complete Chinese translation of that clause, and tag the coordinating conjunction as its own separate CONJUNCTION component (in a comma-plus-conjunction pair, tag only the conjunction itself as CONJUNCTION).",
  "Complex-sentence rule: keep tagging a subordinate clause as one whole component with one of the five clause roles (SUBJECT_CLAUSE, OBJECT_CLAUSE, PREDICATIVE_CLAUSE, ATTRIBUTIVE_CLAUSE, ADVERBIAL_CLAUSE); never split its internal structure.",
  "Simple-sentence rule: never wrap a sentence with a single subject-predicate structure in COORDINATE_CLAUSE.",
  "Give every component other than a COORDINATE_CLAUSE a concise, non-empty Chinese translation; a COORDINATE_CLAUSE keeps the complete clause translation required above.",
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
