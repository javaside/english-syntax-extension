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
  fun `core prompt forbids predicates from swallowing peer components`() {
    val prompt = buildCorePrompt(
      listOf(sentence("Start by classifying how much process the request needs, then work through your path.")),
    )

    assertTrue(prompt.contains("PREDICATE must not absorb"))
    assertTrue(prompt.contains("OBJECT, PREDICATIVE, COMPLEMENT, or ADVERBIAL"))
  }

  /**
   * 三条粒度边界：少了它们，实测同一句会被切成词级碎片（Help/turn 两个谓语、介词与
   * 宾语分离、宾语短语误标定语）。判定顺序也是实测出来的——分句规则必须排在 peer
   * 规则之前，两条平列时模型会在两种切法之间跳。
   */
  @Test
  fun `core prompt bounds granularity and decides clause layout first`() {
    val prompt = buildCorePrompt(listOf(sentence("Help turn ideas into fully formed designs and specs.")))

    assertTrue(prompt.contains("Clause-structure-first rule:"))
    assertTrue(prompt.contains("analyse every compound clause as peer components"))
    assertTrue(prompt.contains("Never emit COORDINATE_CLAUSE"))
    assertFalse(prompt.contains("emit exactly one COORDINATE_CLAUSE per clause"))
    assertTrue(prompt.contains("\"Help turn\" is one PREDICATE"))
    assertTrue(prompt.contains("Two PREDICATE components must never be adjacent"))
    assertTrue(prompt.contains("a preposition and everything it governs form exactly one component"))
    assertTrue(prompt.contains("never tag a noun phrase governed by a verb or preposition as ATTRIBUTE"))
    assertTrue(prompt.indexOf("Clause-structure-first rule:") < prompt.indexOf("Peer-component rule:"))
    assertTrue(prompt.contains("Peer-component rule: within a single clause"))
  }

  /**
   * 修复轮曾只带 peer + supplement 两条规则，覆盖率/角色枚举/复合句/译文要求全丢，
   * 于是"修一次就更碎"。core 与 repair 现在共享同一份规则清单。
   */
  @Test
  fun `repair prompt carries the full rule set`() {
    val input = sentence("The service works.")
    val core = buildCorePrompt(listOf(input))
    val repair = buildRepairPrompt(
      listOf(input),
      listOf(ValidationError("sentences[0]", "bad")),
      buildJsonObject { put("sentences", buildJsonArray { }) },
    )

    listOf(
      "The role field is a closed 16-role enum:",
      "Coverage rule:",
      "Clause-structure-first rule:",
      "Predicate-scope rule:",
      "Prepositional-phrase rule:",
      "Peer-component rule:",
      "Supplement rule:",
      "Compound-sentence rule:",
      "Complex-sentence rule:",
      "Simple-sentence rule:",
      "Give every component a concise, non-empty Chinese translation",
    ).forEach { rule ->
      assertTrue(core.contains(rule), rule)
      assertTrue(repair.contains(rule), rule)
    }
  }

  @Test
  fun `dash supplements remain explanations and keep relative clause boundaries`() {
    val input = sentence("Ask clarifying questions — one at a time, the ones that matter.")
    val prompts = listOf(
      buildCorePrompt(listOf(input)),
      buildRepairPrompt(
        listOf(input),
        listOf(ValidationError("sentences[0]", "bad")),
        buildJsonObject { put("sentences", buildJsonArray { }) },
      ),
    )

    prompts.forEach { prompt ->
      assertTrue(prompt.contains("dash or colon"))
      assertTrue(prompt.contains("APPOSITIVE or INDEPENDENT_ELEMENT"))
      assertTrue(prompt.contains("the ones"))
      assertTrue(prompt.contains("that matter"))
    }
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
    assertTrue(prompt.contains("PREDICATE must not absorb"))
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
    assertTrue(prompt.contains("\"schemaVersion\":${dev.codetui.englishsyntax.domain.ContractVersions.CORE_SCHEMA}"))
    assertTrue(prompt.contains("\"role\":\"SUBJECT\""))
    assertTrue(prompt.contains("\"startToken\":0,\"endToken\":1"))
  }
}
