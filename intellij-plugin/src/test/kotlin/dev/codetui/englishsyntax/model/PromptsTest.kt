package dev.codetui.englishsyntax.model

import dev.codetui.englishsyntax.contract.FixtureLoader
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.domain.ValidationError
import dev.codetui.englishsyntax.language.tokenize
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PromptsTest {
  private val contractJson = Json
  private val contractFirstLines = contractJson.parseToJsonElement(FixtureLoader.text("contracts.json"))
    .jsonObject.getValue("promptFirstLines").jsonObject

  private fun sentence(text: String) = SentenceInput(sentenceId = "s1", text = text, tokens = tokenize(text))

  private fun firstLine(key: String): String = contractFirstLines.getValue(key).jsonPrimitive.content

  @Test
  fun `core prompt starts with shared line and compact sentence payload`() {
    val prompt = buildCorePrompt(listOf(sentence("The service works.")))
    assertTrue(prompt.startsWith(firstLine("core")))
    assertTrue(prompt.contains("""{"sentenceId":"s1""""))
    assertFalse(prompt.contains("\n  \"sentenceId\""))
    assertTrue(prompt.contains("Output minified JSON on a single line"))
  }

  @Test
  fun `core prompt lists all sixteen closed roles`() {
    val prompt = buildCorePrompt(listOf(sentence("The service works.")))
    assertTrue(prompt.contains("closed 16-role enum"))
    GrammarRole.entries.forEach { role -> assertTrue(prompt.contains(role.name), role.name) }
  }

  @Test
  fun `repair prompt carries validation errors and invalid JSON compactly`() {
    val invalid = buildJsonObject { put("sentences", buildJsonArray { }) }
    val prompt = buildRepairPrompt(
      listOf(sentence("The service works.")),
      listOf(ValidationError("sentences[0]", "is missing")),
      invalid,
    )
    assertTrue(prompt.startsWith(firstLine("coreRepair")))
    assertTrue(prompt.contains("""{"path":"sentences[0]","message":"is missing"}"""))
    assertFalse(prompt.contains("\n  \"path\""))
  }

  @Test
  fun `detail prompt starts with shared line and embeds verified core and focus`() {
    val core = CoreAnalysis(
      sentenceId = "s1",
      components = listOf(
        CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务"),
      ),
      modelProfileId = "profile-1",
    )
    val prompt = buildDetailPrompt(sentence("The service works."), core, TokenRange(0, 1))
    assertTrue(prompt.startsWith(firstLine("detail")))
    assertTrue(prompt.contains("\"sentenceId\":\"s1\",\"text\":\"The service works.\""))
    assertTrue(prompt.contains("\"schemaVersion\":1"))
    assertTrue(prompt.contains("\"role\":\"SUBJECT\""))
    assertTrue(prompt.contains("\"startToken\":0,\"endToken\":1"))
  }
}
