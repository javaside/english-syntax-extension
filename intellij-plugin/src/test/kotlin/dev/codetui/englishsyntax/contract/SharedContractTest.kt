package dev.codetui.englishsyntax.contract

import dev.codetui.englishsyntax.domain.ContractVersions
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.FailureDetail
import dev.codetui.englishsyntax.domain.GRAMMAR_LABELS
import dev.codetui.englishsyntax.domain.GrammarRole
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

class SharedContractTest {
  private val root = Json.parseToJsonElement(FixtureLoader.text("contracts.json")).jsonObject

  @Test
  fun `versions and constants match Chrome`() {
    assertEquals(ContractVersions.MESSAGE, root.getValue("messageVersion").jsonPrimitive.content.toInt())
    assertEquals(ContractVersions.CORE_SCHEMA, root.getValue("coreSchemaVersion").jsonPrimitive.content.toInt())
    assertEquals(ContractVersions.CORE_PROMPT, root.getValue("corePromptVersion").jsonPrimitive.content.toInt())
    assertEquals(ContractVersions.DETAIL_PROMPT, root.getValue("detailPromptVersion").jsonPrimitive.content.toInt())
    assertEquals(
      ContractVersions.MAX_SENTENCES_PER_REQUEST,
      root.getValue("maxSentencesPerRequest").jsonPrimitive.content.toInt(),
    )
    assertEquals(
      ContractVersions.CLOUD_SENTENCES_PER_REQUEST,
      root.getValue("cloudSentencesPerRequest").jsonPrimitive.content.toInt(),
    )
  }

  @Test
  fun `failure details preserve TypeScript scalar values`() {
    val failure = ExtensionFailure(
      code = ErrorCode.RATE_LIMITED,
      message = "slow down",
      retryable = true,
      details = mapOf(
        "provider" to FailureDetail.StringValue("OpenAI"),
        "retryAfterMs" to FailureDetail.NumberValue(2_500),
        "retryableByProvider" to FailureDetail.BooleanValue(true),
      ),
    )

    assertEquals(2_500, (failure.details.getValue("retryAfterMs") as FailureDetail.NumberValue).value)
  }

  @Test
  fun `roles labels and errors match Chrome`() {
    val roles = root.getValue("roles").jsonArray.map {
      val item = it.jsonObject
      item.getValue("role").jsonPrimitive.content to item.getValue("label").jsonPrimitive.content
    }
    assertEquals(GrammarRole.entries.map { it.name to GRAMMAR_LABELS.getValue(it) }, roles)
    assertEquals(ErrorCode.entries.map { it.name }, root.getValue("errorCodes").jsonArray.map { it.jsonPrimitive.content })
  }
}
