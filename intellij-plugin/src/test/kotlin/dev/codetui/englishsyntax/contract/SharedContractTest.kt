package dev.codetui.englishsyntax.contract

import dev.codetui.englishsyntax.domain.ContractVersions
import dev.codetui.englishsyntax.domain.ErrorCode
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
    assertEquals(6, root.getValue("maxSentencesPerRequest").jsonPrimitive.content.toInt())
    assertEquals(2, root.getValue("cloudSentencesPerRequest").jsonPrimitive.content.toInt())
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
