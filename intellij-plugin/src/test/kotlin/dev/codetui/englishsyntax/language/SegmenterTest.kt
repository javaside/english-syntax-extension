package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.contract.FixtureLoader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

class SegmenterTest {
  @Test
  fun `matches shared segmenter vectors`() {
    val vectors = Json.parseToJsonElement(FixtureLoader.text("segmenter-vectors.json")).jsonArray
    for (vector in vectors) {
      val item = vector.jsonObject
      val block = item.getValue("block").jsonPrimitive.content
      val actual = segmentBlock(block)
      val expected = item.getValue("sentences").jsonArray
      assertEquals(expected.map { it.jsonObject.getValue("text").jsonPrimitive.content }, actual.map { it.text })
      expected.zip(actual).forEach { (expectedSentence, sentence) ->
        val expectedObject = expectedSentence.jsonObject
        val tokens = tokenize(sentence.text)
        assertEquals(expectedObject.getValue("tokens").jsonArray.map { it.jsonPrimitive.content }, tokens.map { it.text })
        assertEquals(expectedObject.getValue("punctuation").jsonArray.map { it.jsonPrimitive.content.toBoolean() }, tokens.map { it.punctuation })
        assertEquals(sentence.text, rebuildTokens(tokens))
      }
    }
  }

  @Test
  fun `preserves sentence offsets after trimming and token offsets`() {
    val block = "  Dr. Smith doesn’t guess.  "
    val sentence = segmentBlock(block).single()

    assertEquals("Dr. Smith doesn’t guess.", sentence.text)
    assertEquals(2, sentence.start)
    assertEquals(26, sentence.end)

    val tokens = tokenize(sentence.text)
    assertEquals(listOf(0, 2, 4, 10, 18, 23), tokens.map { it.start })
    assertEquals(listOf(2, 3, 9, 17, 23, 24), tokens.map { it.end })
    assertEquals(listOf("", "", " ", " ", " ", ""), tokens.map { it.leadingWhitespace })
    assertEquals(sentence.text, rebuildTokens(tokens))
  }

  @Test
  fun `sentence id is stable and scoped to preview instance`() {
    val first = createSentenceId("preview-1", "block-1", 0, "The parser works.")
    assertEquals(first, createSentenceId("preview-1", "block-1", 0, "The parser works."))
    check(first != createSentenceId("preview-2", "block-1", 0, "The parser works."))
    assertEquals(24, first.length)
  }
}
