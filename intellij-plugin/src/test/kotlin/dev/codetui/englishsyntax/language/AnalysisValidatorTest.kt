package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AnalysisValidatorTest {
  private fun <T> ValidationResult<T>.requireValue(): T = assertIs<ValidationResult.Valid<T>>(this).value

  private fun sentence(
    text: String = "The service validates every response.",
    sentenceId: String = "s1",
  ) = SentenceInput(sentenceId, text, tokenize(text))

  private fun core(components: String, sentenceId: String = "s1", extra: String = "") = Json.parseToJsonElement(
    """{"sentences":[{"sentenceId":"$sentenceId","components":[$components]$extra}]}""",
  )

  private val completeComponents = """
    {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},
    {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"校验"},
    {"startToken":3,"endToken":4,"role":"OBJECT","translation":"每个响应"}
  """.trimIndent()

  private fun detail(
    focus: String = """{"startToken":2,"endToken":2}""",
    structures: String = "[]",
    grammarPoints: String = "[]",
    explanation: String = "主语短语",
    extra: String = "",
  ) = Json.parseToJsonElement(
    """{"sentenceId":"s1","focus":$focus,"structures":$structures,"grammarPoints":$grammarPoints,"explanation":"$explanation"$extra}""",
  )

  @Test
  fun `accepts complete non punctuation coverage and injects profile`() {
    val result = validateCoreBatch(core(completeComponents), listOf(sentence()), "profile-1")

    assertTrue(result.ok)
    val analysis = result.requireValue().single()
    assertEquals("profile-1", analysis.modelProfileId)
    assertEquals(listOf(GrammarRole.SUBJECT, GrammarRole.PREDICATE, GrammarRole.OBJECT), analysis.components.map { it.role })
  }

  @Test
  fun `rejects missing token and overlap`() {
    val raw = core(
      """
      {"startToken":0,"endToken":2,"role":"SUBJECT","translation":"该服务校验"},
      {"startToken":2,"endToken":3,"role":"OBJECT","translation":"响应"}
      """.trimIndent(),
    )

    val result = validateCoreBatch(raw, listOf(sentence()), "profile-1")

    assertFalse(result.ok)
    assertTrue(result.errors.any { it.message.contains("overlap", ignoreCase = true) || it.message.contains("covered") })
  }

  @Test
  fun `drops punctuation only components before core validation`() {
    val request = sentence("The service works.")
    val raw = core(
      """
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},
      {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"工作"},
      {"startToken":3,"endToken":3,"role":"INDEPENDENT_ELEMENT","translation":"。"}
      """.trimIndent(),
    )

    val result = validateCoreBatch(raw, listOf(request), "profile-1")

    assertTrue(result.ok)
    assertEquals(2, result.requireValue().single().components.size)
  }

  @Test
  fun `drops punctuation components before validating their invented role`() {
    val request = sentence("The service works.")
    val raw = core("""
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},
      {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"工作"},
      {"startToken":3,"endToken":3,"role":"PUNCTUATION","translation":"。"}
    """.trimIndent())

    val result = validateCoreBatch(raw, listOf(request), "profile-1")

    assertTrue(result.ok)
    assertEquals(2, result.requireValue().single().components.size)
  }

  @Test
  fun `rejects non primitive string and unsafe integer forms`() {
    val request = sentence()
    val textVariants = listOf(
      "123", "true", "null", "{\"value\":\"该服务\"}", "[\"该服务\"]",
    )
    textVariants.forEach { translation ->
      assertFalse(validateCoreBatch(core(completeComponents.replace("\"该服务\"", translation)), listOf(request), "profile-1").ok)
    }
    val integerVariants = listOf(
      "\"0\"", "0.0", "true", "null", "9007199254740992",
    )
    integerVariants.forEach { start ->
      val components = completeComponents.replace("\"startToken\":0", "\"startToken\":$start")
      assertFalse(validateCoreBatch(core(components), listOf(request), "profile-1").ok)
    }
  }

  @Test
  fun `rejects unsafe output even when punctuation component can be dropped`() {
    val request = sentence("The service works.")
    val raw = core(
      """
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"<script>alert(1)</script>"},
      {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"工作"},
      {"startToken":3,"endToken":3,"role":"OBJECT","translation":"。"}
      """.trimIndent(),
    )

    assertFalse(validateCoreBatch(raw, listOf(request), "profile-1").ok)
  }

  @Test
  fun `rejects unknown role empty and overlong translations`() {
    val variants = listOf(
      completeComponents.replace("\"SUBJECT\"", "\"COMMAND\""),
      completeComponents.replace("\"该服务\"", "\"  \""),
      completeComponents.replace("\"该服务\"", "\"${"译".repeat(501)}\""),
    )

    variants.forEach { assertFalse(validateCoreBatch(core(it), listOf(sentence()), "profile-1").ok) }
  }

  @Test
  fun `rejects missing duplicate unrequested sentences and unknown fields`() {
    val request = sentence()
    val missing = Json.parseToJsonElement("""{"sentences":[]}""")
    val duplicate = Json.parseToJsonElement(
      """{"sentences":[{"sentenceId":"s1","components":[$completeComponents]},{"sentenceId":"s1","components":[$completeComponents]}]}""",
    )
    val unrequested = core(completeComponents, sentenceId = "other")
    val unknownEnvelope = Json.parseToJsonElement("""{"sentences":[],"modelProfileId":"attacker"}""")
    val unknownSentence = core(completeComponents, extra = ",\"modelProfileId\":\"attacker\"")
    val unknownComponent = core(completeComponents.replace("\"translation\":\"该服务\"", "\"translation\":\"该服务\",\"extra\":true"))

    listOf(missing, duplicate, unrequested, unknownEnvelope, unknownSentence, unknownComponent).forEach {
      assertFalse(validateCoreBatch(it, listOf(request), "profile-1").ok)
    }
  }

  @Test
  fun `rejects reversed negative out of range and unordered intervals`() {
    val variants = listOf(
      completeComponents.replace("\"startToken\":0,\"endToken\":1", "\"startToken\":1,\"endToken\":0"),
      completeComponents.replace("\"startToken\":0", "\"startToken\":-1"),
      completeComponents.replace("\"endToken\":4", "\"endToken\":9"),
      completeComponents.split(",\n").reversed().joinToString(",\n"),
    )

    variants.forEach { assertFalse(validateCoreBatch(core(it), listOf(sentence()), "profile-1").ok) }
  }

  @Test
  fun `returns validation errors for malformed JsonElements`() {
    listOf(JsonNull, JsonPrimitive("text"), JsonArray(emptyList())).forEach {
      val result = validateCoreBatch(it, listOf(sentence()), "profile-1")
      assertFalse(result.ok)
      assertTrue(result.errors.isNotEmpty())
    }
  }

  @Test
  fun `detail must preserve requested focus`() {
    val result = validateDetail(
      detail(focus = """{"startToken":0,"endToken":1}"""),
      sentence(),
      TokenRange(2, 2),
      "profile-1",
    )

    assertFalse(result.ok)
  }

  @Test
  fun `rejects malformed detail top level values`() {
    listOf(JsonNull, JsonPrimitive("text"), JsonPrimitive(1), JsonArray(emptyList())).forEach {
      val result = validateDetail(it, sentence(), TokenRange(2, 2), "profile-1")
      assertFalse(result.ok)
      assertTrue(result.errors.isNotEmpty())
    }
  }

  @Test
  fun `accepts valid detail and normalizes optional blank translation`() {
    val structures = """[{"startToken":2,"endToken":2,"role":"谓语动词","explanation":"谓语中心","translation":"  "}]"""
    val result = validateDetail(detail(structures = structures), sentence(), TokenRange(2, 2), "trusted-profile")

    assertTrue(result.ok)
    val analysis = result.requireValue()
    assertEquals("trusted-profile", analysis.modelProfileId)
    assertNull(analysis.structures.single().translation)
  }

  @Test
  fun `rejects detail structures outside focus or overlapping earlier structures`() {
    val request = sentence("Start by classifying how much process the request needs.")
    val focus = TokenRange(2, 9)
    val outsideFocus = detail(
      focus = """{"startToken":2,"endToken":9}""",
      structures = """[{"startToken":0,"endToken":9,"role":"谓语","explanation":"越出点击成分"}]""",
    )
    val nestedAndRepeated = detail(
      focus = """{"startToken":2,"endToken":9}""",
      structures = """[
        {"startToken":2,"endToken":9,"role":"宾语从句","explanation":"整个从句"},
        {"startToken":2,"endToken":3,"role":"引导词","explanation":"重复拆内部"},
        {"startToken":6,"endToken":7,"role":"主语","explanation":"名词短语"},
        {"startToken":7,"endToken":7,"role":"中心词","explanation":"再次重复"}
      ]""",
    )

    listOf(outsideFocus, nestedAndRepeated).forEach {
      assertFalse(validateDetail(it, request, focus, "profile-1").ok)
    }
  }

  @Test
  fun `rejects invalid detail envelope focus and structure`() {
    val variants = listOf(
      detail(focus = "null"),
      detail(focus = """{"startToken":2,"endToken":2,"extra":1}"""),
      detail(extra = ",\"modelProfileId\":\"attacker\""),
      detail(structures = """[{"startToken":4,"endToken":2,"role":"x","explanation":"x"}]"""),
      detail(structures = """[{"startToken":2,"endToken":9,"role":"x","explanation":"x"}]"""),
      detail(structures = """[{"startToken":2,"endToken":2,"role":"x","explanation":"x","extra":1}]"""),
    )

    variants.forEach { assertFalse(validateDetail(it, sentence(), TokenRange(2, 2), "profile-1").ok) }
  }

  @Test
  fun `rejects unsafe detail text`() {
    val variants = listOf(
      detail(explanation = "<script>alert(1)</script>"),
      detail(structures = """[{"startToken":2,"endToken":2,"role":"javascript:x","explanation":"x"}]"""),
      detail(structures = """[{"startToken":2,"endToken":2,"role":"x","explanation":"<iframe"}]"""),
      detail(structures = """[{"startToken":2,"endToken":2,"role":"x","explanation":"x","translation":"javascript:x"}]"""),
      // 控制字符用转义写（三引号不过转义）：源文件里埋裸 NUL 会让 grep 把这个文件当二进制。
      detail(grammarPoints = "[\"safe\u0000unsafe\"]"),
    )

    variants.forEach { assertFalse(validateDetail(it, sentence(), TokenRange(2, 2), "profile-1").ok) }
  }

  @Test
  fun `rejects invalid grammar points and missing detail fields`() {
    val thirteen = (0..12).joinToString(prefix = "[", postfix = "]") { "\"point $it\"" }
    val variants = listOf(
      detail(grammarPoints = thirteen),
      detail(grammarPoints = """["${"语".repeat(301)}"]"""),
      detail(grammarPoints = """[""]"""),
      Json.parseToJsonElement("""{"sentenceId":"s1","structures":[],"grammarPoints":[],"explanation":"x"}"""),
      Json.parseToJsonElement("""{"sentenceId":"s1","focus":{"startToken":2,"endToken":2},"grammarPoints":[],"explanation":"x"}"""),
    )

    variants.forEach { assertFalse(validateDetail(it, sentence(), TokenRange(2, 2), "profile-1").ok) }
  }
}
