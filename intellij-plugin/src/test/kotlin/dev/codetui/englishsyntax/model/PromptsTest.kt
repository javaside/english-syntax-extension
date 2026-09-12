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
  fun `core prompt lists all seventeen closed roles`() {
    val prompt = buildCorePrompt(listOf(sentence("The service works.")))
    assertTrue(prompt.contains("closed 17-role enum"))
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

  @Test
  fun `core and repair prompts classify complete clauses before fragments without sentence translations`() {
    val input = sentence("The service works.")
    val prompts = listOf(
      buildCorePrompt(listOf(input)),
      buildRepairPrompt(
        listOf(input),
        listOf(ValidationError("sentences[0]", "bad")),
        buildJsonObject { put("sentences", buildJsonArray { }) },
      ),
    )
    val completenessRuleParts = listOf(
      "Completeness-first rule:",
      "FRAGMENT_HEAD",
      "Portable API support",
      "across AI providers",
      "for Chat, text-to-image, and Embedding models",
      "An imperative is a clause, not a fragment",
      "\"Install the CLI\" is PREDICATE \"Install\" plus OBJECT \"the CLI\"",
    )

    prompts.forEach { prompt ->
      assertTrue(prompt.contains("The role field is a closed 17-role enum:"))
      var previousIndex = -1
      completenessRuleParts.forEach { part ->
        val index = prompt.indexOf(part, previousIndex + 1)
        assertTrue(index > previousIndex, part)
        previousIndex = index
      }
      assertTrue(previousIndex < prompt.indexOf("Clause-structure rule:"))
      assertTrue(prompt.contains("Give every component a concise, non-empty Chinese translation"))
      assertFalse(prompt.contains("sentence-level translation"))
      assertFalse(prompt.contains("""{"sentenceId": string, "translation": string"""))
    }
  }

  /**
   * 四条粒度边界：少了它们，实测同一句会被切成词级碎片（Help/turn 两个谓语、介词与
   * 宾语分离、宾语短语误标定语）。completeness-first 排最前——先判输入是否构成
   * 分句，再定分句层级。判定顺序也是实测出来的——分句规则必须排在 peer
   * 规则之前，两条平列时模型会在两种切法之间跳。
   */
  @Test
  fun `core prompt bounds granularity and decides clause layout first`() {
    val prompt = buildCorePrompt(listOf(sentence("Help turn ideas into fully formed designs and specs.")))

    assertTrue(prompt.contains("Clause-structure rule:"))
    assertTrue(prompt.contains("analyse every compound clause as peer components"))
    assertTrue(prompt.contains("Never emit COORDINATE_CLAUSE"))
    assertFalse(prompt.contains("emit exactly one COORDINATE_CLAUSE per clause"))
    assertTrue(prompt.contains("\"Help turn\" is one PREDICATE"))
    assertTrue(prompt.contains("Two PREDICATE components must never be adjacent"))
    assertTrue(prompt.contains("a preposition and everything it governs form exactly one component"))
    assertTrue(prompt.contains("never tag a noun phrase governed by a verb or preposition as ATTRIBUTE"))
    assertTrue(prompt.indexOf("Clause-structure rule:") < prompt.indexOf("Peer-component rule:"))
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
      "The role field is a closed 17-role enum:",
      "Coverage rule:",
      "Clause-structure rule:",
      "Predicate-scope rule:",
      "Prepositional-phrase rule:",
      "Peer-component rule:",
      "Colon-title rule:",
      "Component-granularity rule:",
      "Give every component a concise, non-empty Chinese translation",
    ).forEach { rule ->
      assertTrue(core.contains(rule), rule)
      assertTrue(repair.contains(rule), rule)
    }
  }

  @Test
  fun `repair prompt explains determiner split and requires an error self-check`() {
    val prompt = buildRepairPrompt(
      listOf(sentence("Classify the request.")),
      listOf(
        ValidationError(
          "sentences[0].components[0]",
          "a PREDICATE must cover only the verb group; emit the noun phrase that starts at the determiner as its own OBJECT, PREDICATIVE, or COMPLEMENT component",
        ),
      ),
      buildJsonObject { put("sentences", buildJsonArray { }) },
    )

    assertTrue(prompt.contains("split that component immediately before the determiner"))
    assertTrue(prompt.contains("Check the repaired JSON against every listed validation error"))
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

  /**
   * CORE_PROMPT_VERSION 13 的页面句型重写,与 TS `prompts.test.ts` 同一清单:
   * 每条口径一条正例 + 一条最接近的反例,文案与 Chrome 端逐字一致,由
   * core-prompt-parity.json 钉住全文,这里只逐条钉「新教学内容确实存在」。
   */
  @Test
  fun `core prompt teaches the page-sentence patterns of version 13`() {
    val prompt = buildCorePrompt(listOf(sentence("The service works.")))

    // fragment-relative 定语从句 + 完整句反例
    assertTrue(
      prompt.contains(
        "\"An API that returns JSON responses\" is FRAGMENT_HEAD \"An API\" plus ATTRIBUTIVE_CLAUSE \"that returns JSON responses\"",
      ),
    )
    assertTrue(
      prompt.contains(
        "the finite verb inside that embedded clause does not turn the whole input into a main clause",
      ),
    )
    assertTrue(
      prompt.contains(
        "\"The tool that we built passes every test\" keeps PREDICATE \"passes\" at the top level",
      ),
    )

    // arXiv 长冒号标题四段口径 + 冒号后完整分句反例
    assertTrue(
      prompt.contains(
        "in \"Expanding the scope of dark siren cosmology: Inferring the population properties of gravitational wave-hosting galaxies\", \"Inferring the population properties\" is ONE APPOSITIVE",
      ),
    )
    assertTrue(prompt.contains("the colon stays uncovered"))
    assertTrue(
      prompt.contains(
        "in \"The result is clear: the sampled prior reduces uncertainty\", \"the sampled prior reduces uncertainty\" is a full clause and is analysed as peer SUBJECT, PREDICATE, and OBJECT",
      ),
    )

    // VP / NP coordination 对照
    assertTrue(
      prompt.contains(
        "in \"They measure the time and propagate the results\", \"and\" is its own CONJUNCTION joining two verb phrases that share one subject",
      ),
    )
    assertTrue(
      prompt.contains(
        "in \"a Claude subscription or Anthropic Console account\", \"or\" stays inside the single OBJECT",
      ),
    )

    // finite / non-finite when 对照
    assertTrue(
      prompt.contains(
        "A when/before/after/if clause with its own finite predicate is ONE ADVERBIAL_CLAUSE (\"when methods are called\")",
      ),
    )
    assertTrue(
      prompt.contains(
        "when/before/after followed by a non-finite verb phrase stays at phrase level as ONE ADVERBIAL (\"when performing tool calling\")",
      ),
    )

    // allow/force/let 宾语控制结构
    assertTrue(
      prompt.contains(
        "With allow/force/let plus a noun phrase plus an infinitive, the verb is PREDICATE, the noun phrase is OBJECT, and the infinitive phrase is COMPLEMENT (\"allows Maven to access repositories\" is PREDICATE \"allows\" plus OBJECT \"Maven\" plus COMPLEMENT \"to access repositories\")",
      ),
    )
    assertTrue(prompt.contains("\"let go\" is one PREDICATE"))

    // 零关系词定语从句
    assertTrue(
      prompt.contains(
        "A relative clause whose introducing word is omitted is still ONE ATTRIBUTIVE_CLAUSE cut from the noun phrase it modifies: \"a typed object the rest of the codebase can treat\" is OBJECT \"a typed object\" plus ATTRIBUTIVE_CLAUSE \"the rest of the codebase can treat\"",
      ),
    )

    // 非限定补足成分(conventions 第 11 条)
    assertTrue(
      prompt.contains(
        "A non-finite complement phrase keeps its own object inside one COMPLEMENT (\"is steered to produce text\" is PREDICATE \"is steered\" plus COMPLEMENT \"to produce text\")",
      ),
    )

    // PP 依附四类
    assertTrue(
      prompt.contains(
        "a prepositional phrase expressing where/when/how the action happens is ADVERBIAL (\"works directly with git\" is PREDICATE \"works\" plus ADVERBIAL \"directly with git\")",
      ),
    )
    assertTrue(
      prompt.contains(
        "a prepositional phrase selecting or describing the preceding noun is ATTRIBUTE (\"an open standard for connecting AI tools\" is PREDICATIVE \"an open standard\" plus ATTRIBUTE \"for connecting AI tools\", and \"the development\" plus \"of applications\" is OBJECT plus ATTRIBUTE)",
      ),
    )
    assertTrue(prompt.contains("\"without looking at any of the code\" stays ONE ADVERBIAL"))
    assertTrue(
      prompt.contains(
        "\"pay attention to the details\" is PREDICATE \"pay\" plus OBJECT \"attention\" plus ATTRIBUTE \"to the details\"",
      ),
    )

    // 译文质量:每成分中文释义、专名保留 + 中文类型、拒绝英文回显
    assertTrue(prompt.contains("Spring AI 框架"))
    assertTrue(prompt.contains("JSON 数据格式"))
    assertTrue(prompt.contains("哈勃常数 H0"))
    assertTrue(
      prompt.contains(
        "a translation that only copies or echoes the English span is invalid and will be rejected",
      ),
    )

    // 低频角色一例
    assertTrue(
      prompt.contains(
        "PREDICATIVE_CLAUSE completes a linking verb (\"The real problem is that the cache entry has expired\")",
      ),
    )
    assertTrue(
      prompt.contains(
        "SUBJECT_CLAUSE acts as the subject (\"Whoever wins the race gets the final ticket\")",
      ),
    )
    assertTrue(
      prompt.contains(
        "ADVERBIAL_CLAUSE modifies the main clause (\"Because the road was flooded, the bus took a longer route\")",
      ),
    )
    assertTrue(
      prompt.contains(
        "\"We consider the tool essential\" is OBJECT \"the tool\" plus COMPLEMENT \"essential\"",
      ),
    )
    assertTrue(
      prompt.contains(
        "A comma-braced renaming noun phrase is ONE APPOSITIVE (\"Claude Code, an AI coding assistant, helps\")",
      ),
    )
    assertTrue(
      prompt.contains(
        "a sentence-initial comment adverb is ONE INDEPENDENT_ELEMENT (\"Fortunately, the deployment finished\")",
      ),
    )
    assertTrue(prompt.contains("\"have been told\""))
    assertTrue(Regex("being").containsMatchIn(prompt))
    assertTrue(Regex("having").containsMatchIn(prompt))

    // 重写去重:旧的两个独立条目并入 clause-first
    assertFalse(prompt.contains("Compound-sentence rule:"))
    assertFalse(prompt.contains("Simple-sentence rule:"))
    assertTrue(prompt.contains("A sentence is compound only when"))
  }

  /**
   * 重写后的规则段预算：spec §实施前置 5 要求增量有测量依据。旧版规则段(版本 12,
   * 单句)实测 8207 字符；重写删除 SUPPLEMENT_RULE 与内联 Compound/Simple 重复条目,
   * 同时为页面语料新增约 10 组「正例 + 反例」对照,净增 +33%(新实测 ≤ 旧值 × 1.35)。
   */
  @Test
  fun `core prompt rule text stays within the measured budget envelope`() {
    val prompt = buildCorePrompt(listOf(sentence("The service works.")))
    val payloadStart = prompt.indexOf("Numbered sentence requests:")
    val ruleTextLength = prompt.slice(0 until payloadStart).length

    assertTrue(ruleTextLength <= 8207 * 1.35, "rule text grew beyond budget: $ruleTextLength")
  }
}
