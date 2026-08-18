package dev.codetui.englishsyntax.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class StreamParserTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `core parser emits a closed component with its sentence id`() {
    val parser = CoreStreamParser()
    val chunks = listOf(
      """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},""",
      """{"startToken":2,"endToken":2,"role":"PREDICATE","translation":"工作"}]}]}""",
    )
    val emitted = chunks.flatMap(parser::push)
    assertEquals(2, emitted.size)
    assertEquals("s1", emitted[0].sentenceId)
    assertEquals("SUBJECT", emitted[0].component["role"]?.jsonPrimitive?.content)
    assertEquals("PREDICATE", emitted[1].component["role"]?.jsonPrimitive?.content)
  }

  @Test
  fun `core parser buffers components that arrive before the sentence id`() {
    val parser = CoreStreamParser()
    val emitted = parser.push(
      """{"sentences":[{"components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"}],"sentenceId":"s1","components":[]}]}""",
    )
    assertEquals(1, emitted.size)
    assertEquals("s1", emitted[0].sentenceId)
  }

  @Test
  fun `core parser ignores prose before the first brace`() {
    val parser = CoreStreamParser()
    val emitted = parser.push(
      "Here is the JSON.\n{\"sentences\":[{\"sentenceId\":\"s1\",\"components\":[{\"startToken\":0,\"endToken\":0,\"role\":\"SUBJECT\",\"translation\":\"它\"}]}]}",
    )
    assertEquals(1, emitted.size)
  }

  @Test
  fun `detail parser emits structures and ignores focus object`() {
    val parser = DetailStreamParser()
    val emitted = parser.push(
      """{"sentenceId":"s1","focus":{"startToken":0,"endToken":1},"structures":[{"startToken":0,"endToken":0,"role":"冠词","explanation":"限定词"},{"startToken":1,"endToken":1,"role":"名词","explanation":"中心词"}],"grammarPoints":[],"explanation":"主语"}""",
    )
    assertEquals(2, emitted.size)
    assertEquals("冠词", emitted[0]["role"]?.jsonPrimitive?.content)
    assertEquals("名词", emitted[1]["role"]?.jsonPrimitive?.content)
  }

  @Test
  fun `detail parser ignores nested objects inside a structure`() {
    val parser = DetailStreamParser()
    val emitted = parser.push(
      """{"structures":[{"startToken":0,"endToken":1,"role":"主语","explanation":"包含嵌套","nested":{"a":1}}]}""",
    )
    assertEquals(1, emitted.size)
    assertTrue(emitted[0].jsonObject.containsKey("nested"))
  }
}
