package dev.codetui.englishsyntax.model

import dev.codetui.englishsyntax.contract.FixtureLoader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * 与 `chrome-plugin/src/background/lenient-json.test.ts` 同跑一批向量:救回来的**文本**
 * 两端必须逐字相同。只在一端改救援规则会立刻红在这里。
 */
class LenientJsonTest {
  private val vectors = Json.parseToJsonElement(FixtureLoader.text("truncated-json-salvage.json")).jsonArray

  @Test
  fun `shared fixtures repair to the same text as Chrome`() {
    assert(vectors.isNotEmpty())
    for (vector in vectors) {
      val item = vector.jsonObject
      val name = item.getValue("name").jsonPrimitive.content
      val input = item.getValue("input").jsonPrimitive.content
      val expectedElement = item.getValue("expected")
      val expected = if (expectedElement == JsonNull) null else expectedElement.jsonPrimitive.content
      assertEquals(expected, repairTruncatedJson(input), name)
    }
  }

  @Test
  fun `every repaired candidate parses`() {
    for (vector in vectors) {
      val item = vector.jsonObject
      val expectedElement = item.getValue("expected")
      if (expectedElement == JsonNull) continue
      Json.parseToJsonElement(expectedElement.jsonPrimitive.content)
    }
  }

  @Test
  fun `keeps the complete sentences of a truncated batch`() {
    val truncated =
      """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"编辑"}]},{"sentenceId":"s2","components":[{"startToken":0,"endTo"""
    assertEquals(
      """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"编辑"}]},{"sentenceId":"s2","components":[{"startToken":0}]}]}""",
      repairTruncatedJson(truncated),
    )
  }

  @Test
  fun `never trusts a half string or a half number`() {
    assertEquals(
      """{"sentences":[{"sentenceId":"s1","components":[]}]}""",
      repairTruncatedJson("""{"sentences":[{"sentenceId":"s1","components":[],"note":"这句还没写完"""),
    )
    assertEquals(
      """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0}]}]}""",
      repairTruncatedJson("""{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1"""),
    )
  }

  @Test
  fun `returns null when there is no complete value`() {
    assertNull(repairTruncatedJson("""{"sentences":[{"sen"""))
    assertNull(repairTruncatedJson(""))
    assertNull(repairTruncatedJson("对不起，我不确定怎么拆解这句话。"))
  }

  @Test
  fun `stops at the first unbalanced closer`() {
    assertEquals(
      """{"sentences":[]}""",
      repairTruncatedJson("""{"sentences":[]}}}{"sentences":[{"sentenceId":"x"}]}"""),
    )
  }

  @Test
  fun `passes a complete output through and strips a lone opening fence`() {
    val complete = """{"sentences":[{"sentenceId":"s1","components":[]}]}"""
    assertEquals(complete, repairTruncatedJson(complete))
    assertEquals(complete, repairTruncatedJson("```json\n$complete\n```"))
    assertEquals(complete, repairTruncatedJson("```json\n$complete"))
  }
}
