package dev.codetui.englishsyntax.analysis

import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.ValidationError
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * repair 错误的按句分组(与 TS `repair-errors.ts` 同构)。
 *
 * 验证器按句单独调用,错误路径恒以 sentences[0] 起;多句错误被扁平拼装后模型
 * 无从定位该改哪一句。这里按 sentenceId 重新分组,rawOccurrence 标明该
 * sentenceId 在 raw 里的第几个实例(零基)。
 *
 * 这是发给模型的序列化形状,不是 JCEF bridge 协议的一部分。
 */
data class RepairErrorGroup(
  val sentenceId: String,
  val rawOccurrence: Int? = null,
  val kind: String,
  val errors: List<ValidationError>,
)

private val sentencePrefix = Regex("^sentences\\[\\d+\\]\\.?")

private fun rawSentenceIds(raw: JsonElement?): List<String> {
  val sentences = (raw as? JsonObject)?.get("sentences") as? JsonArray ?: return emptyList()
  return sentences.mapNotNull { entry ->
    ((entry as? JsonObject)?.get("sentenceId") as? JsonPrimitive)?.contentOrNull
  }
}

fun groupRepairErrors(
  invalid: List<Pair<SentenceInput, List<ValidationError>>>,
  raw: JsonElement?,
): List<RepairErrorGroup> {
  val ids = rawSentenceIds(raw)
  val groups = mutableListOf<RepairErrorGroup>()
  for ((sentence, errors) in invalid) {
    val occurrences = ids.count { it == sentence.sentenceId }
    if (occurrences == 0) {
      groups += RepairErrorGroup(
        sentenceId = sentence.sentenceId,
        kind = "missing",
        errors = listOf(ValidationError("", "no output for this sentenceId; emit it")),
      )
      continue
    }
    val stripped = errors
      // 「is duplicated」是批级簿记错误,不是该实例的结构错误:不进首实例组。
      .filterNot { it.message.contains("is duplicated") }
      .map { ValidationError(sentencePrefix.replace(it.path, ""), it.message) }
    if (stripped.isNotEmpty()) {
      groups += RepairErrorGroup(
        sentenceId = sentence.sentenceId,
        rawOccurrence = 0,
        kind = "invalid",
        errors = stripped,
      )
    }
    for (occurrence in 1 until occurrences) {
      groups += RepairErrorGroup(
        sentenceId = sentence.sentenceId,
        rawOccurrence = occurrence,
        kind = "duplicate",
        errors = listOf(ValidationError("", "remove this duplicate instance")),
      )
    }
  }
  return groups
}
