package dev.codetui.englishsyntax.contract

import dev.codetui.englishsyntax.domain.ContractVersions
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.FailureDetail
import dev.codetui.englishsyntax.domain.GRAMMAR_LABELS
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.language.tokenize
import dev.codetui.englishsyntax.model.buildCorePrompt
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

  /**
   * 两端的核心提示词必须逐字一致：此前只靠人肉同步，一边改了规则、另一边没改，
   * 两个平台就会给出不同粒度的成分，而且没有任何测试会红。fixture 里存的是整段
   * 提示词，所以规则文本、章节顺序、分词结果任何一处分叉都会在这里失败。
   * 改提示词的正确姿势：两端一起改 + 更新 fixture + 升 CORE_PROMPT。
   */
  @Test
  fun `core prompt is byte-identical to the Chrome fixture`() {
    val fixture = Json.parseToJsonElement(FixtureLoader.text("core-prompt-parity.json")).jsonObject
    val sentence = fixture.getValue("sentence").jsonObject
    val text = sentence.getValue("text").jsonPrimitive.content
    val input = SentenceInput(
      sentenceId = sentence.getValue("sentenceId").jsonPrimitive.content,
      text = text,
      tokens = tokenize(text),
    )

    assertEquals(fixture.getValue("prompt").jsonPrimitive.content, buildCorePrompt(listOf(input)))
    assertEquals(ContractVersions.CORE_PROMPT, fixture.getValue("corePromptVersion").jsonPrimitive.content.toInt())
  }
}
