package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.contract.FixtureLoader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
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
      assertEquals(expected.size, actual.size)
      expected.zip(actual).forEach { (expectedSentence, sentence) ->
        val expectedObject = expectedSentence.jsonObject
        assertEquals(expectedObject.getValue("text").jsonPrimitive.content, sentence.text)
        assertEquals(expectedObject.getValue("start").jsonPrimitive.int, sentence.start)
        assertEquals(expectedObject.getValue("end").jsonPrimitive.int, sentence.end)

        val expectedTokens = expectedObject.getValue("tokens").jsonArray.map { it.jsonObject }
        val tokens = tokenize(sentence.text)
        assertEquals(expectedTokens.map { it.getValue("text").jsonPrimitive.content }, tokens.map { it.text })
        assertEquals(expectedTokens.map { it.getValue("start").jsonPrimitive.int }, tokens.map { it.start })
        assertEquals(expectedTokens.map { it.getValue("end").jsonPrimitive.int }, tokens.map { it.end })
        assertEquals(expectedTokens.map { it.getValue("leadingWhitespace").jsonPrimitive.content }, tokens.map { it.leadingWhitespace })
        assertEquals(expectedTokens.map { it.getValue("punctuation").jsonPrimitive.content.toBoolean() }, tokens.map { it.punctuation })
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
  fun `uses JavaScript whitespace semantics without emitting Unicode separators as tokens`() {
    val sentence = "Alpha\u00a0Beta\u2003Gamma\u202fDelta\u2028Epsilon\u2029Zeta"

    val tokens = tokenize(sentence)

    assertEquals(listOf("Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"), tokens.map { it.text })
    assertEquals(listOf("", "\u00a0", "\u2003", "\u202f", "\u2028", "\u2029"), tokens.map { it.leadingWhitespace })
    assertEquals(sentence, rebuildTokens(tokens))
  }

  @Test
  fun `trims Unicode whitespace and reports JVM UTF-16 sentence and token offsets`() {
    val block = "\u00a0😊 First.\u2003\u202fSecond!\u2028\u2029"

    assertEquals(
      listOf(
        SegmentedSentence("😊 First.", 1, 10),
        SegmentedSentence("Second!", 12, 19),
      ),
      segmentBlock(block),
    )
    assertEquals(
      listOf(
        Triple("😊", 0, 2),
        Triple("First", 3, 8),
        Triple(".", 8, 9),
      ),
      tokenize("😊 First.").map { Triple(it.text, it.start, it.end) },
    )
  }

  @ParameterizedTest
  @ValueSource(strings = ["Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "e.g.", "i.e.", "U.S."])
  fun `keeps supported abbreviations with the following clause`(abbreviation: String) {
    assertEquals(
      listOf("$abbreviation Smith arrived.", "Next sentence."),
      segmentBlock("$abbreviation Smith arrived. Next sentence.").map { it.text },
    )
  }

  @Test
  fun `sentence id matches TypeScript SHA-256 input and changes for every scoped field`() {
    assertEquals("667d275dc95590100189d49b", createSentenceId("session-1", "block-1", 0, "Same text."))
    assertEquals("a64d9d4a1fcf4ad97588ce67", createSentenceId("session-2", "block-1", 0, "Same text."))
    assertEquals("379970409f78d6e61511b85a", createSentenceId("session-1", "block-2", 0, "Same text."))
    assertEquals("67499c3f8b3146c094b32179", createSentenceId("session-1", "block-1", 1, "Same text."))
    assertEquals("a53681bc69b3814ca3d4e5da", createSentenceId("session-1", "block-1", 0, "Different text."))
  }
}
