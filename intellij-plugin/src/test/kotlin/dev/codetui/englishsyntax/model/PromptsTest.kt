package dev.codetui.englishsyntax.model

import dev.codetui.englishsyntax.contract.FixtureLoader
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.analysis.RepairErrorGroup
import dev.codetui.englishsyntax.domain.ValidationError
import dev.codetui.englishsyntax.language.tokenize
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
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
        listOf(RepairErrorGroup("s1", 0, "invalid", listOf(ValidationError("components[0]", "bad")))),
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
      listOf(RepairErrorGroup("s1", 0, "invalid", listOf(ValidationError("components[0]", "bad")))),
      buildJsonObject { put("sentences", buildJsonArray { }) },
    )

    listOf(
      "The role field is a closed 17-role enum:",
      "Coverage rule:",
      "Clause-structure rule:",
      "Predicate-scope rule:",
      "Prepositional-phrase rule:",
      "Peer-component rule:",
      "Colon-structure rule:",
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
        RepairErrorGroup(
          "s1",
          0,
          "invalid",
          listOf(
            ValidationError(
              "components[0]",
              "a PREDICATE must cover only the verb group; emit the noun phrase that starts at the determiner as its own OBJECT, PREDICATIVE, or COMPLEMENT component",
            ),
          ),
        ),
      ),
      buildJsonObject { put("sentences", buildJsonArray { }) },
    )

    assertTrue(prompt.contains("split that component immediately before the determiner"))
    assertTrue(prompt.contains("Check the repaired JSON against every listed validation error"))
  }

  /**
   * 2026-10-11 真机：并列名词片段里第二项被同位语隔开，既不能被并进同一个
   * FRAGMENT_HEAD，也不该被改标成修饰语。与 TS `prompts.test.ts` 同一清单。
   * 2026-11-02（core 19）：repair 指令改为按连接方式分流——有 FANBOYS 连词才逐项
   * head + 连词单列；无连词（逗号/分号/vs）合并成一个 head 或 retag APPOSITIVE。
   */
  @Test
  fun `teaches coordinated fragment heads and tells repair to split the conjunction out`() {
    val core = buildCorePrompt(listOf(sentence("Classify the request.")))
    val repair = buildRepairPrompt(
      listOf(sentence("Classify the request.")),
      listOf(RepairErrorGroup("s1", 0, "invalid", listOf(ValidationError("components[0]", "bad")))),
      buildJsonObject { put("sentences", buildJsonArray { }) },
    )

    listOf(core, repair).forEach { prompt ->
      assertTrue(
        prompt.contains(
          "\"A DESIGN.md — a note — and a FRAME.md\" = FRAGMENT_HEAD \"A DESIGN.md\" + APPOSITIVE \"a note\" + CONJUNCTION \"and\" + FRAGMENT_HEAD \"a FRAME.md\"",
        ),
      )
      assertTrue(prompt.contains("a conjunction inside one uninterrupted phrase stays inside that single component"))
    }
    assertTrue(repair.contains("keep that head only when the component directly in front of it is a separate FANBOYS CONJUNCTION component"))
    assertTrue(repair.contains("never leave a real conjunction inside a FRAGMENT_HEAD"))
  }

  /** 2026-11-02 真机（HyperFrames vs Remotion 页 7/49 句两轮修复仍失败）：与 TS 同一死锁。 */
  @Test
  fun `teaches non-FANBOYS coordination as one merged head and forbids punctuation conjunctions`() {
    val core = buildCorePrompt(listOf(sentence("Classify the request.")))
    val repair = buildRepairPrompt(
      listOf(sentence("Classify the request.")),
      listOf(RepairErrorGroup("s1", 0, "invalid", listOf(ValidationError("components[0]", "bad")))),
      buildJsonObject { put("sentences", buildJsonArray { }) },
    )

    listOf(core, repair).forEach { prompt ->
      assertTrue(prompt.contains("Conjuncts joined without a coordinating conjunction never get one FRAGMENT_HEAD each"))
      assertTrue(prompt.contains("\"Same request, two agents\" and \"HyperFrames vs Remotion\" are each ONE FRAGMENT_HEAD"))
      assertTrue(prompt.contains("punctuation, semicolons, and \"vs\" are never tagged CONJUNCTION"))
    }
    assertTrue(repair.contains("judge EVERY extra FRAGMENT_HEAD by the semantic component directly in front of it"))
    assertTrue(repair.contains("including an item of a list that merely ends with \"; and\" — retag it APPOSITIVE"))
  }

  @Test
  fun `dash supplements remain explanations and keep relative clause boundaries`() {
    val input = sentence("Ask clarifying questions — one at a time, the ones that matter.")
    val prompts = listOf(
      buildCorePrompt(listOf(input)),
      buildRepairPrompt(
        listOf(input),
        listOf(RepairErrorGroup("s1", 0, "invalid", listOf(ValidationError("components[0]", "bad")))),
        buildJsonObject { put("sentences", buildJsonArray { }) },
      ),
    )

    prompts.forEach { prompt ->
      assertTrue(prompt.contains("Colon-structure rule:"))
      assertTrue(prompt.contains("INDEPENDENT_ELEMENT"))
      assertTrue(prompt.contains("the ones"))
      assertTrue(prompt.contains("that matter"))
    }
  }

  @Test
  fun `repair prompt carries validation errors and invalid JSON compactly`() {
    val invalid = buildJsonObject { put("sentences", buildJsonArray { }) }
    val prompt = buildRepairPrompt(
      listOf(sentence("The service works.")),
      listOf(RepairErrorGroup("s1", null, "missing", listOf(ValidationError("", "no output for this sentenceId; emit it")))),
      invalid,
    )
    assertTrue(prompt.startsWith(firstLine("coreRepair")))
    // 分组序列化:句身份 + 去前缀路径,不再出现裸 sentences[0]。
    assertTrue(prompt.contains("\"sentenceId\":\"s1\""))
    assertTrue(prompt.contains("\"kind\":\"missing\""))
    assertTrue(prompt.contains("""{"path":"","message":"no output for this sentenceId; emit it"}"""))
    assertFalse(prompt.contains("sentences[0]"))
    assertTrue(prompt.contains("PREDICATE must not absorb"))
    assertFalse(prompt.contains("\n  \"path\""))
  }

  @Test
  fun `core and repair prompts teach natural local glosses for a noun head and its of phrase`() {
    val input = sentence("The service works.")
    val prompts = listOf(
      buildCorePrompt(listOf(input)),
      buildRepairPrompt(
        listOf(input),
        listOf(
          RepairErrorGroup(
            sentenceId = "s1",
            rawOccurrence = 0,
            kind = "invalid",
            errors = listOf(ValidationError("sentences[0].components[0]", "invalid")),
          ),
        ),
        buildJsonObject { put("sentences", buildJsonArray {}) },
      ),
    )

    prompts.forEach { prompt ->
      assertTrue(prompt.contains("\"the development\" is \"开发过程\", not \"该开发\""))
      assertTrue(prompt.contains("\"of applications\" is \"应用程序的\", not \"的\""))
    }
  }

  @Test
  fun `detail prompts teach natural local glosses for a noun head and its postmodifying of phrase`() {
    val input = sentence("The service works.")
    val core = CoreAnalysis(
      sentenceId = "s1",
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "profile-1",
    )
    val prompt = buildDetailPrompt(input, core, TokenRange(0, 1))

    assertTrue(prompt.contains("translate \"the development\" as \"开发过程\", not \"该开发\""))
    assertTrue(prompt.contains("translate \"of applications\" as \"应用程序的\""))
    assertTrue(prompt.contains("explain their combined meaning as \"应用程序的开发过程\""))
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

    // 冒号结构三步决策:完整分句/问题 → label → 长标题重命名
    assertTrue(prompt.contains("Colon-structure rule:"))
    assertTrue(prompt.contains("If it is a complete clause or question"))
    assertTrue(prompt.contains("INDEPENDENT_ELEMENT \"Binary flag\""))
    assertTrue(prompt.contains("never mix FRAGMENT_HEAD with clause roles"))
    assertTrue(
      prompt.contains(
        "\"Scope of X: Properties of Y\" = FRAGMENT_HEAD \"Scope\" + ATTRIBUTE \"of X\" + APPOSITIVE \"Properties\" + ATTRIBUTE \"of Y\"",
      ),
    )
    assertTrue(prompt.contains("leave the colon uncovered"))

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
        "a prepositional phrase expressing where/when/how the action happens is ADVERBIAL, and a degree adverb in front of it stays its own ADVERBIAL component (\"Claude Code works directly with git.\" is SUBJECT \"Claude Code\", PREDICATE \"works\", ADVERBIAL \"directly\", and ADVERBIAL \"with git\")",
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
   * 同时为页面语料新增约 10 组「正例 + 反例」对照,净增 +33%。2026-09-12 批次
   * (spec D4/D5)新增 Trailing-citation 与 Heading-number 两条规则,系数 1.35 → 1.42。
   * 2026-11-02(core 19)新增非 FANBOYS 并列片段一组正反例(实测 12038),系数
   * 1.42 → 1.48——v17/v18 的既定增长已把旧信封用到 99.6%,这次是带真机失败依据
   * 的定向教学。与 TS prompts.test.ts 同一系数。
   */
  @Test
  fun `core prompt rule text stays within the measured budget envelope`() {
    val prompt = buildCorePrompt(listOf(sentence("The service works.")))
    val payloadStart = prompt.indexOf("Numbered sentence requests:")
    val ruleTextLength = prompt.slice(0 until payloadStart).length

    assertTrue(ruleTextLength <= 8207 * 1.48, "rule text grew beyond budget: $ruleTextLength")
  }

  /** 追问对话提示词：首行是函数内字面量，绝不进 contracts.json 的 promptFirstLines。 */
  @Test
  fun `chat prompt starts with the function-local literal kept out of the shared first-line table`() {
    val chatFirstLine = "Discuss the verified translation analysis with the reader."
    val prompt = buildChatPrompt(
      sentence("The service works."),
      CoreAnalysis(sentenceId = "s1", components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")), modelProfileId = "profile-1"),
      listOf(ChatTurn("user", "为什么")),
      "那宾语呢？",
    )

    assertTrue(prompt.startsWith(chatFirstLine))
    // 首行不得混进被双端 contracts 钉死的 promptFirstLines（那张表只有五个键）。
    contractFirstLines.forEach { (key, value) ->
      assertTrue(value.jsonPrimitive.content != chatFirstLine, "chat first line leaked into promptFirstLines[$key]")
    }
  }

  /** 四段结构与 Chrome 端 prompts.ts buildChatPrompt 逐字一致；内嵌 JSON 全部紧凑序列化。 */
  @Test
  fun `chat prompt embeds sentence core history and question in four compact sections`() {
    val input = sentence("The service works.")
    val core = CoreAnalysis(sentenceId = "s1", components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")), modelProfileId = "profile-1")
    val history = listOf(ChatTurn("user", "为什么"), ChatTurn("assistant", "因为主语在前"))
    val prompt = buildChatPrompt(input, core, history, "那宾语呢？")

    val sections = prompt.split("\n\n")
    assertEquals(10, sections.size)
    assertEquals(
      "Answer the reader's question in Chinese based on the verified core analysis below. " +
        "Do not re-divide or re-tag the grammatical components: the verified analysis is fixed. " +
        "If the analysis conflicts with the question, follow the analysis and say so. " +
        "Keep the answer concise and split it into short paragraphs.",
      sections[1],
    )
    assertEquals("Selected sentence:", sections[2])
    assertEquals(serializeSentence(input), sections[3])
    assertEquals("Verified core result:", sections[4])
    assertEquals(
      """{"schemaVersion":${dev.codetui.englishsyntax.domain.ContractVersions.CORE_SCHEMA},"sentenceId":"s1",""" +
        """"components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"}],"modelProfileId":"profile-1"}""",
      sections[5],
    )
    assertEquals("Conversation history (oldest first):", sections[6])
    assertEquals(
      """[{"role":"user","content":"为什么"},{"role":"assistant","content":"因为主语在前"}]""",
      sections[7],
    )
    assertEquals("Reader question:", sections[8])
    assertEquals("那宾语呢？", sections[9])
    assertFalse(prompt.contains("\n  \""))
  }

  // ---- 纠正反馈提示词（F2）：逐字对齐 Chrome correctionPrompt / correctionRepairPrompt ----

  /** Chrome analysis-service.ts correctionPrompt 的函数内首行（不在 PROMPT_FIRST_LINES，表恰 5 键）。 */
  private val chromeCorrectionFirstLine = "Reanalyze the supplied sentence using the reader's correction feedback."

  /** Chrome analysis-service.ts correctionRepairPrompt 的函数内首行。 */
  private val chromeCorrectionRepairFirstLine =
    "Repair only the structure of the invalid correction analysis while preserving the entire correction context below."

  private val correctionCore = CoreAnalysis(
    sentenceId = "s1",
    components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
    modelProfileId = "profile-1",
  )

  /**
   * 首行是函数内字面量、逐字 = Chrome 同名 prompt 首行（先抄 chrome-plugin 原文再断言），
   * 绝不进被双端 contracts 钉死的 promptFirstLines——与 buildChatPrompt 同款约定。
   */
  @Test
  fun `correction prompt first lines are function-local literals kept out of the shared first-line table`() {
    val prompt = buildCorrectionPrompt(sentence("The service works."), correctionCore, "把 works 单独标成谓语")
    val repair = buildCorrectionPromptRepair(
      sentence("The service works."),
      correctionCore,
      "把 works 单独标成谓语",
      listOf(ValidationError("components[0]", "bad")),
      buildJsonObject { put("sentences", buildJsonArray { }) },
    )

    assertTrue(prompt.startsWith(chromeCorrectionFirstLine))
    assertTrue(repair.startsWith(chromeCorrectionRepairFirstLine))
    contractFirstLines.forEach { (key, value) ->
      val firstLine = value.jsonPrimitive.content
      assertTrue(firstLine != chromeCorrectionFirstLine, "correction first line leaked into promptFirstLines[$key]")
      assertTrue(firstLine != chromeCorrectionRepairFirstLine, "correction repair first line leaked into promptFirstLines[$key]")
    }
  }

  /**
   * 六段结构照 Chrome 原文逐段（首行 / 不变式 / CORE_OUTPUT_SHAPE / 句子 / 已核实 core / 反馈），
   * CORE_OUTPUT_SHAPE 复用双端逐字一致的那份，内嵌 JSON 全部紧凑序列化。
   */
  @Test
  fun `correction prompt embeds sentence core and feedback in six compact sections`() {
    val input = sentence("The service works.")
    val feedback = "把 works 单独标成谓语"
    val prompt = buildCorrectionPrompt(input, correctionCore, feedback)

    val sections = prompt.split("\n\n")
    assertEquals(6, sections.size)
    assertEquals(chromeCorrectionFirstLine, sections[0])
    assertEquals("Keep the sentence ID and Tokens unchanged. Return core-analysis JSON only.", sections[1])
    // CORE_OUTPUT_SHAPE 复用：第三段与 core/detail prompt 的输出形状行同源（双端逐字一致）。
    assertTrue(sections[2].contains("Output exactly one JSON object of this shape, not a top-level array:"))
    assertTrue(sections[2].contains("A component must never contain only punctuation Tokens"))
    assertTrue(sections[2].contains("Output minified JSON on a single line"))
    assertEquals("Sentence and Tokens:\n${serializeSentence(input)}", sections[3])
    assertEquals("Previously verified core analysis:\n${serialize(correctionCore.toJsonElement())}", sections[4])
    assertEquals("Reader feedback:\n$feedback", sections[5])
    assertFalse(prompt.contains("\n  \""))
  }

  /**
   * 修复轮结构照 Chrome 原文：修复指令 → 完整首轮纠正 prompt（整段内嵌，自带 \n\n 分隔，
   * 整串按 \n\n 切会超过元素数——按拼接边界断言）→ 平铺 errors（单句无需 RepairErrorGroup
   * 分组，Chrome 亦如此）→ 非法 JSON → 收尾不变式。
   */
  @Test
  fun `correction repair prompt embeds the whole correction prompt and flat errors`() {
    val input = sentence("The service works.")
    val feedback = "把 works 单独标成谓语"
    val errors = listOf(ValidationError("components[0]", "coverage is incomplete"))
    val invalidJson = buildJsonObject { put("sentences", buildJsonArray { }) }
    val prompt = buildCorrectionPromptRepair(input, correctionCore, feedback, errors, invalidJson)
    val correction = buildCorrectionPrompt(input, correctionCore, feedback)

    assertTrue(prompt.startsWith("${chromeCorrectionRepairFirstLine}\n\n$correction"))
    val tail = prompt.removePrefix("${chromeCorrectionRepairFirstLine}\n\n$correction")
    assertEquals(
      "\n\nValidation errors:\n" + """[{"path":"components[0]","message":"coverage is incomplete"}]""" +
        "\n\nInvalid JSON:\n" + """{"sentences":[]}""" +
        "\n\nReturn the repaired core-analysis JSON only. Do not add sentences or change sentence IDs or Tokens.",
      tail,
    )
    // 平铺 errors：不出现 RepairErrorGroup 的分组信封（sentenceId/kind/rawOccurrence 键）。
    assertFalse(prompt.contains("\"kind\""))
    assertFalse(prompt.contains("\"rawOccurrence\""))
    assertFalse(prompt.contains("sentences[0]"))
    assertFalse(prompt.contains("\n  \""))
  }
}
