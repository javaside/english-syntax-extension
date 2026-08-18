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
  "The structures array must break down the internal components of the focus range. Never return a single structure that covers the entire focus — split it into meaningful sub-components (subject, predicate, object, clauses, etc.).",
  "Give every structure a concise Chinese translation of exactly its own English text in the translation field (a few words, like a gloss under the phrase); keep the longer analysis in explanation. The translation field must be written in Chinese characters (中文译文) — copying the English words unchanged is invalid.",
  MINIFIED_OUTPUT,
).joinToString("\n")

fun buildCorePrompt(sentences: List<SentenceInput>): String {
  val roles = GrammarRole.entries.map { it.name }
  return listOf(
    "Analyze the numbered English sentences below into core grammatical components.",
    "The role field is a closed ${roles.size}-role enum: ${roles.joinToString(", ")}.",
    "Every component uses a closed Token interval [startToken, endToken]; both endpoints are inclusive Token IDs from the supplied sentence.",
    """Each supplied Token is {"id","text"}; a Token is punctuation only when it carries "punctuation": true.""",
    "Coverage rule: every non-punctuation Token must be covered exactly once. Components must be ordered, non-overlapping, and may include punctuation but may not contain punctuation only.",
    "Compound-sentence rule: when two or more clauses that could each stand alone as a sentence are joined by a coordinating conjunction (for, and, nor, but, or, yet, so) or a semicolon, tag each clause as one whole COORDINATE_CLAUSE whose translation is the complete Chinese translation of that clause, and tag the coordinating conjunction as its own separate CONJUNCTION component (in a comma-plus-conjunction pair, tag only the conjunction itself as CONJUNCTION).",
    "Complex-sentence rule: keep tagging a subordinate clause as one whole component with one of the five clause roles (SUBJECT_CLAUSE, OBJECT_CLAUSE, PREDICATIVE_CLAUSE, ATTRIBUTIVE_CLAUSE, ADVERBIAL_CLAUSE); never split its internal structure.",
    "Simple-sentence rule: never wrap a sentence with a single subject-predicate structure in COORDINATE_CLAUSE.",
    "Give every component other than a COORDINATE_CLAUSE a concise, non-empty Chinese translation; a COORDINATE_CLAUSE keeps the complete clause translation required above.",
    "Keep every sentenceId and every supplied Token unchanged. Return JSON only, with no Markdown or explanatory prose.",
    CORE_OUTPUT_SHAPE,
    "Numbered sentence requests:",
    serializeSentences(sentences),
  ).joinToString("\n\n")
}

fun buildRepairPrompt(
  sentences: List<SentenceInput>,
  errors: List<ValidationError>,
  invalidJson: JsonElement,
): String = listOf(
  "Repair only the structure of the invalid core-analysis JSON so it satisfies every validation error.",
  "Do not change sentence IDs or Tokens. Do not add sentences and do not reinterpret the source text.",
  "Return the repaired JSON only, without a Markdown fence or prose.",
  CORE_OUTPUT_SHAPE,
  "Original sentence IDs and Tokens:",
  serializeSentences(sentences),
  "Validation errors:",
  serialize(promptJson.encodeToJsonElement(errors)),
  "Invalid JSON:",
  serialize(invalidJson),
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
