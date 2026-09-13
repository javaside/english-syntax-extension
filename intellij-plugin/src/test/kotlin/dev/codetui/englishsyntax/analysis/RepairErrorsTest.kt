package dev.codetui.englishsyntax.analysis

import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.Token
import dev.codetui.englishsyntax.domain.ValidationError
import dev.codetui.englishsyntax.language.tokenize
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 与 TS `repair-errors.test.ts` 同构:按句分组、四类路径、重复与非法并存。
 */
class RepairErrorsTest {
  private fun sentence(id: String): SentenceInput {
    val text = "The service works well."
    return SentenceInput(id, text, tokenize(text))
  }

  private fun raw(json: String): JsonElement = Json.parseToJsonElement(json)

  @Test
  fun `多句错误各自归属到 sentenceId 且路径去掉 sentences 前缀`() {
    val groups = groupRepairErrors(
      listOf(
        sentence("a") to listOf(ValidationError("sentences[0].components[1].translation", "m-a")),
        sentence("b") to listOf(ValidationError("sentences[0].components[3].translation", "m-b")),
      ),
      raw("""{"sentences":[{"sentenceId":"a"},{"sentenceId":"b"}]}"""),
    )
    assertEquals(
      listOf(
        RepairErrorGroup("a", 0, "invalid", listOf(ValidationError("components[1].translation", "m-a"))),
        RepairErrorGroup("b", 0, "invalid", listOf(ValidationError("components[3].translation", "m-b"))),
      ),
      groups,
    )
  }

  @Test
  fun `缺失句与重复句各有明确 kind`() {
    val missing = groupRepairErrors(
      listOf(sentence("a") to emptyList()),
      raw("""{"sentences":[]}"""),
    )
    assertEquals(RepairErrorGroup("a", null, "missing", listOf(ValidationError("", "no output for this sentenceId; emit it"))), missing.single())

    val duplicate = groupRepairErrors(
      listOf(sentence("a") to listOf(ValidationError("sentences[1].sentenceId", "is duplicated"))),
      raw("""{"sentences":[{"sentenceId":"a"},{"sentenceId":"a"}]}"""),
    )
    assertEquals(
      listOf(RepairErrorGroup("a", 1, "duplicate", listOf(ValidationError("", "remove this duplicate instance")))),
      duplicate,
    )
  }

  @Test
  fun `重复实例与首实例非法并存时互不吞并`() {
    val groups = groupRepairErrors(
      listOf(
        sentence("a") to listOf(
          ValidationError("sentences[1].sentenceId", "is duplicated"),
          ValidationError("sentences[0].components[1].translation", "m-a"),
        ),
      ),
      raw("""{"sentences":[{"sentenceId":"a"},{"sentenceId":"a"},{"sentenceId":"a"}]}"""),
    )
    assertEquals(
      listOf(
        RepairErrorGroup("a", 0, "invalid", listOf(ValidationError("components[1].translation", "m-a"))),
        RepairErrorGroup("a", 1, "duplicate", listOf(ValidationError("", "remove this duplicate instance"))),
        RepairErrorGroup("a", 2, "duplicate", listOf(ValidationError("", "remove this duplicate instance"))),
      ),
      groups,
    )
  }
}
