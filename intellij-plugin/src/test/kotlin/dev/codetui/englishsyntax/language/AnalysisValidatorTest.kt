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

  /**
   * 提示词里能本地判定的粒度规则必须在这里也变成硬校验：与 Chrome 端 `collectGrammarErrors`
   * 逐条对应、错误文案逐字一致（两端的修复 prompt 都靠它当修复指令）。
   */
  @Test
  fun `reports non structural and grammar errors together`() {
    val adjacentRequest = sentence("Help turn ideas.")
    val adjacent = core(
      """
      {"startToken":0,"endToken":0,"role":"PREDICATE","translation":"帮助","unexpected":true},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"转化"},
      {"startToken":2,"endToken":3,"role":"OBJECT","translation":"想法"}
      """.trimIndent(),
      sentenceId = adjacentRequest.sentenceId,
    )
    val adjacentErrors = validateCoreBatch(adjacent, listOf(adjacentRequest), "profile-1").errors
    assertTrue(adjacentErrors.any { it.path == "sentences[0].components[0]" && it.message == "contains unknown fields" })
    assertTrue(
      adjacentErrors.any {
        it.path == "sentences[0].components[1]" &&
          it.message == "adjacent PREDICATE components must be merged into one PREDICATE covering the whole verb group"
      },
    )

    val coordinateRequest = sentence("Readers understand complex sentences.")
    val coordinate = core(
      """{"startToken":0,"endToken":4,"role":"COORDINATE_CLAUSE","translation":"${"译".repeat(501)}"}""",
      sentenceId = coordinateRequest.sentenceId,
    )
    val coordinateErrors = validateCoreBatch(coordinate, listOf(coordinateRequest), "profile-1").errors
    assertTrue(coordinateErrors.any { it.path.endsWith("translation") && it.message == "is too long" })
    assertTrue(
      coordinateErrors.any {
        it.path == "sentences[0].components" &&
          it.message == "a single clause must be split into peer components instead of one COORDINATE_CLAUSE; COORDINATE_CLAUSE requires at least two coordinate clauses"
      },
    )
  }

  @Test
  fun `rejects adjacent PREDICATE components and tells the model to merge the verb group`() {
    val request = sentence("Help turn ideas.")
    val raw = core(
      """
      {"startToken":0,"endToken":0,"role":"PREDICATE","translation":"帮助"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"转化"},
      {"startToken":2,"endToken":3,"role":"OBJECT","translation":"想法"}
      """.trimIndent(),
      sentenceId = request.sentenceId,
    )

    val result = validateCoreBatch(raw, listOf(request), "profile-1")

    assertFalse(result.ok)
    assertTrue(
      result.errors.any {
        it.path == "sentences[0].components[1]" &&
          it.message == "adjacent PREDICATE components must be merged into one PREDICATE covering the whole verb group"
      },
    )
  }

  @Test
  fun `accepts two PREDICATE components separated by another component`() {
    val request = sentence("Readers read books and writers revise drafts.")
    val raw = core(
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"读者"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"阅读"},
      {"startToken":2,"endToken":2,"role":"OBJECT","translation":"书籍"},
      {"startToken":3,"endToken":3,"role":"CONJUNCTION","translation":"并且"},
      {"startToken":4,"endToken":4,"role":"SUBJECT","translation":"作者"},
      {"startToken":5,"endToken":5,"role":"PREDICATE","translation":"修订"},
      {"startToken":6,"endToken":7,"role":"OBJECT","translation":"草稿"}
      """.trimIndent(),
      sentenceId = request.sentenceId,
    )

    assertTrue(validateCoreBatch(raw, listOf(request), "profile-1").ok)
  }

  @Test
  fun `rejects a bare preposition component`() {
    val request = sentence("Turn ideas into designs.")
    val raw = core(
      """
      {"startToken":0,"endToken":0,"role":"PREDICATE","translation":"转化"},
      {"startToken":1,"endToken":1,"role":"OBJECT","translation":"想法"},
      {"startToken":2,"endToken":2,"role":"ADVERBIAL","translation":"变成"},
      {"startToken":3,"endToken":4,"role":"ATTRIBUTE","translation":"设计稿"}
      """.trimIndent(),
      sentenceId = request.sentenceId,
    )

    val result = validateCoreBatch(raw, listOf(request), "profile-1")

    assertFalse(result.ok)
    assertTrue(
      result.errors.any {
        it.path == "sentences[0].components[2]" &&
          it.message == "a preposition must be merged with the phrase it governs instead of forming its own component"
      },
    )
  }

  @Test
  fun `accepts for as coordinating CONJUNCTION and ambiguous words as non-prepositions`() {
    val cases = listOf(
      Triple(
        "I stayed, for it was raining.",
        """
        {"startToken":0,"endToken":1,"role":"COORDINATE_CLAUSE","translation":"我留下了"},
        {"startToken":3,"endToken":3,"role":"CONJUNCTION","translation":"因为"},
        {"startToken":4,"endToken":7,"role":"COORDINATE_CLAUSE","translation":"当时在下雨"}
        """.trimIndent(),
        "for as CONJUNCTION",
      ),
      Triple(
        "The meeting is over.",
        """
        {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"会议"},
        {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"结束了"},
        {"startToken":3,"endToken":4,"role":"PREDICATIVE","translation":"结束"}
        """.trimIndent(),
        "over as PREDICATIVE",
      ),
      Triple(
        "Prices went down.",
        """
        {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"价格"},
        {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"下降"},
        {"startToken":2,"endToken":3,"role":"ADVERBIAL","translation":"向下"}
        """.trimIndent(),
        "down as ADVERBIAL",
      ),
      Triple(
        "I have wondered since.",
        """
        {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"我"},
        {"startToken":1,"endToken":2,"role":"PREDICATE","translation":"一直想知道"},
        {"startToken":3,"endToken":4,"role":"ADVERBIAL","translation":"从那以后"}
        """.trimIndent(),
        "since as ADVERBIAL",
      ),
      Triple(
        "The layer lies beneath.",
        """
        {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"这一层"},
        {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"位于"},
        {"startToken":3,"endToken":4,"role":"ADVERBIAL","translation":"下方"}
        """.trimIndent(),
        "beneath as ADVERBIAL",
      ),
    )

    cases.forEach { (text, components, description) ->
      val request = sentence(text)
      assertTrue(
        validateCoreBatch(core(components, sentenceId = request.sentenceId), listOf(request), "profile-1").ok,
        description,
      )
    }
  }

  @Test
  fun `rejects a lone COORDINATE_CLAUSE wrapping a simple sentence`() {
    val request = sentence("Readers understand complex sentences.")
    val raw = core(
      """{"startToken":0,"endToken":4,"role":"COORDINATE_CLAUSE","translation":"读者理解复杂句子"}""",
      sentenceId = request.sentenceId,
    )

    val result = validateCoreBatch(raw, listOf(request), "profile-1")

    assertFalse(result.ok)
    assertTrue(
      result.errors.any {
        it.path == "sentences[0].components" &&
          it.message == "a single clause must be split into peer components instead of one COORDINATE_CLAUSE; COORDINATE_CLAUSE requires at least two coordinate clauses"
      },
    )
  }

  @Test
  fun `rejects a CONJUNCTION that covers no coordinating conjunction`() {
    val request = sentence("Readers read books.")
    val raw = core(
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"读者"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"阅读"},
      {"startToken":2,"endToken":3,"role":"CONJUNCTION","translation":"书籍"}
      """.trimIndent(),
      sentenceId = request.sentenceId,
    )

    val result = validateCoreBatch(raw, listOf(request), "profile-1")

    assertFalse(result.ok)
    assertTrue(
      result.errors.any {
        it.path == "sentences[0].components[2]" &&
          it.message == "CONJUNCTION must cover a coordinating conjunction (for, and, nor, but, or, yet, so)"
      },
    )
  }

  private fun assertGrammarError(text: String, components: String, path: String, message: String) {
    val request = sentence(text)
    val result = validateCoreBatch(core(components, sentenceId = request.sentenceId), listOf(request), "profile-1")

    assertFalse(result.ok, "expected invalid core output for: $text")
    assertTrue(
      result.errors.any { it.path == path && it.message == message },
      "missing [$path] $message; got ${result.errors}",
    )
  }

  private fun assertAccepted(text: String, components: String) {
    val request = sentence(text)
    val result = validateCoreBatch(core(components, sentenceId = request.sentenceId), listOf(request), "profile-1")

    assertTrue(result.ok, "expected valid core output for: $text; got ${result.errors}")
  }

  @Test
  fun `rejects a PREDICATE that starts with a subject pronoun`() {
    // deepseek-chat 实测输出:整句只有 PREDICATE + 状语从句,主语 "She" 被吞进谓语。
    assertGrammarError(
      "She kept practicing until the melody sounded effortless.",
      """
      {"startToken":0,"endToken":2,"role":"PREDICATE","translation":"持续练习"},
      {"startToken":3,"endToken":7,"role":"ADVERBIAL_CLAUSE","translation":"直到旋律毫不费力"}
      """.trimIndent(),
      "sentences[0].components[0]",
      "a PREDICATE must begin with the verb group; move the leading subject or noun phrase into its own component",
    )
  }

  @Test
  fun `rejects a PREDICATE that starts with a determiner`() {
    assertGrammarError(
      "The ancient bridge was rebuilt by local craftsmen.",
      """
      {"startToken":0,"endToken":4,"role":"PREDICATE","translation":"古桥被重建"},
      {"startToken":5,"endToken":7,"role":"ADVERBIAL","translation":"由当地工匠"}
      """.trimIndent(),
      "sentences[0].components[0]",
      "a PREDICATE must begin with the verb group; move the leading subject or noun phrase into its own component",
    )
  }

  @Test
  fun `accepts an imperative clause whose PREDICATE carries no subject`() {
    // 祈使句本来就没有主语,所以缺主语不能直接判非法——只判「谓语开头不可能是动词」。
    assertAccepted(
      "Help turn ideas into designs.",
      """
      {"startToken":0,"endToken":1,"role":"PREDICATE","translation":"帮助转化"},
      {"startToken":2,"endToken":2,"role":"OBJECT","translation":"想法"},
      {"startToken":3,"endToken":4,"role":"ADVERBIAL","translation":"变成设计稿"}
      """.trimIndent(),
    )
  }

  @Test
  fun `accepts a multi word verb group that begins with a modal`() {
    assertAccepted(
      "The documents must be archived immediately.",
      """
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"这些文件"},
      {"startToken":2,"endToken":4,"role":"PREDICATE","translation":"必须被归档"},
      {"startToken":5,"endToken":5,"role":"ADVERBIAL","translation":"立即"}
      """.trimIndent(),
    )
  }

  @Test
  fun `rejects a PREDICATE that swallows the object noun phrase`() {
    // PEER_COMPONENT_RULE 只写在提示词里时没人拦:"writes the reports" 会整体标成谓语。
    assertGrammarError(
      "Maria writes the reports every Friday.",
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"玛丽亚"},
      {"startToken":1,"endToken":3,"role":"PREDICATE","translation":"撰写报告"},
      {"startToken":4,"endToken":5,"role":"ADVERBIAL","translation":"每周五"}
      """.trimIndent(),
      "sentences[0].components[1]",
      "a PREDICATE must cover only the verb group; emit the noun phrase that starts at the determiner as its own OBJECT, PREDICATIVE, or COMPLEMENT component",
    )
  }

  @Test
  fun `accepts a PREDICATE that ends with the complementizer that`() {
    // "that" 刻意不算限定词:它更常是宾语从句引导词,误拒的代价高于让粒度差一个词。
    assertAccepted(
      "The manager announced that the factory would close.",
      """
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"经理"},
      {"startToken":2,"endToken":3,"role":"PREDICATE","translation":"宣布"},
      {"startToken":4,"endToken":7,"role":"OBJECT_CLAUSE","translation":"工厂将要关闭"}
      """.trimIndent(),
    )
  }

  @Test
  fun `rejects a COORDINATE_CLAUSE introduced by a subordinating conjunction`() {
    // CLAUSE_FIRST_RULE 按逗号触发,主从复合句于是被整成两个「并列分句」——语法上是错的。
    assertGrammarError(
      "Because the road was flooded, the bus took a longer route.",
      """
      {"startToken":0,"endToken":4,"role":"COORDINATE_CLAUSE","translation":"因为道路被淹"},
      {"startToken":6,"endToken":11,"role":"COORDINATE_CLAUSE","translation":"公交车绕了远路"}
      """.trimIndent(),
      "sentences[0].components[0]",
      "a clause introduced by a subordinating conjunction is not a COORDINATE_CLAUSE; tag it with one of the five subordinate clause roles and analyse the main clause as peer components",
    )
  }

  @Test
  fun `accepts a subordinate clause initial COORDINATE_CLAUSE when a coordinator joins the clauses`() {
    // "Because A, B, and C" 里第一个并列分句本来就以从属连词开头,有 CONJUNCTION 就不判它。
    assertAccepted(
      "Because it rained, we stayed, and we slept.",
      """
      {"startToken":0,"endToken":5,"role":"COORDINATE_CLAUSE","translation":"因为下雨,我们留下了"},
      {"startToken":7,"endToken":7,"role":"CONJUNCTION","translation":"而且"},
      {"startToken":8,"endToken":9,"role":"COORDINATE_CLAUSE","translation":"我们睡了"}
      """.trimIndent(),
    )
  }

  @Test
  fun `rejects one component covering the whole sentence whatever its role`() {
    // 现有规则只拦 COORDINATE_CLAUSE;换成 SUBJECT 就一路通过,卡片退化成一整块译文。
    assertGrammarError(
      "The young engineer fixed the broken printer this morning.",
      """{"startToken":0,"endToken":8,"role":"SUBJECT","translation":"年轻的工程师今早修好了坏掉的打印机"}""",
      "sentences[0].components",
      "one component must not cover the whole sentence; split it into peer components (subject, predicate, object, adverbial, …)",
    )
  }

  @Test
  fun `accepts a short fragment covered by one component`() {
    // 三个实词以下的片段(标题、列表项)本来就没有可拆的同层结构,拆了只是噪音。
    assertAccepted(
      "Detailed usage instructions.",
      """{"startToken":0,"endToken":3,"role":"SUBJECT","translation":"详细使用说明"}""",
    )
  }

  @Test
  fun `rejects COORDINATE_CLAUSE components that only commas join`() {
    // 祈使句串曾被整成三个「并列分句」，读者看到的就是三整块译文而不是成分划分。
    assertGrammarError(
      "Ask clarifying questions, gather the constraints, then propose a design.",
      """
      {"startToken":0,"endToken":2,"role":"COORDINATE_CLAUSE","translation":"提出澄清问题"},
      {"startToken":4,"endToken":6,"role":"COORDINATE_CLAUSE","translation":"收集约束"},
      {"startToken":8,"endToken":11,"role":"COORDINATE_CLAUSE","translation":"然后提出设计"}
      """.trimIndent(),
      "sentences[0].components",
      "COORDINATE_CLAUSE is only for clauses joined by a coordinating conjunction tagged as its own " +
        "CONJUNCTION component or by a semicolon; analyse a comma-joined or shared-subject sequence " +
        "as peer components inside one clause",
    )
  }

  @Test
  fun `accepts COORDINATE_CLAUSE components that a semicolon joins`() {
    // 分号连接的并列句没有 CONJUNCTION 成分，不能因此判非法。
    assertAccepted(
      "Routines run in the cloud; they keep running overnight.",
      """
      {"startToken":0,"endToken":4,"role":"COORDINATE_CLAUSE","translation":"例程在云端运行"},
      {"startToken":6,"endToken":9,"role":"COORDINATE_CLAUSE","translation":"它们整夜持续运行"}
      """.trimIndent(),
    )
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
