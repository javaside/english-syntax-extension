package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.contract.FixtureLoader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
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
  fun `错误路径索引是原始数组下标不受纯标点成分影响`() {
    // "The service works well.": 0 The / 1 service / 2 works / 3 well / 4 .(p)
    val s = sentence("The service works well.", "raw-index-1")
    val raw = core(
      """
      {"startToken":4,"endToken":4,"role":"PUNCTUATION","translation":"。"},
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"服务"},
      {"startToken":2,"endToken":3,"role":"PREDICATE","translation":"works well"}
      """.trimIndent(),
      "raw-index-1",
    )
    val result = validateCoreBatch(raw, listOf(s), "p1")
    assertIs<ValidationResult.Invalid>(result)
    val paths = result.errors.map { it.path }
    assertTrue("sentences[0].components[2].translation" in paths, "actual: $paths")
    assertTrue("sentences[0].components[1].translation" !in paths)
    assertTrue("sentences[0].components[0].translation" !in paths)
  }

  @Test
  fun `从句之前插入纯标点成分后 grammar 错误路径随 rawIndex 平移`() {
    // 0 The / 1 API / 2 that / 3 returns / 4 JSON / 5 responses / 6 ,(p) / 7 an / 8 object / 9 .(p)
    val s = sentence("The API that returns JSON responses, an object.", "adjacency-1")
    val raw = core(
      """
      {"startToken":9,"endToken":9,"role":"PUNCTUATION","translation":"。"},
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该 API"},
      {"startToken":2,"endToken":5,"role":"ATTRIBUTIVE_CLAUSE","translation":"返回 JSON 响应的"},
      {"startToken":7,"endToken":8,"role":"OBJECT","translation":"一个对象"}
      """.trimIndent(),
      "adjacency-1",
    )
    val result = validateCoreBatch(raw, listOf(s), "p1")
    assertIs<ValidationResult.Invalid>(result)
    val grammar = result.errors.firstOrNull { it.message.contains("ATTRIBUTIVE_CLAUSE") }
    assertNotNull(grammar) { "errors: ${result.errors}" }
    assertEquals("sentences[0].components[2]", grammar!!.path)
  }

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
          it.message == "COORDINATE_CLAUSE is deprecated; analyse compound sentences as peer components (subject, predicate, object, …) with the coordinating conjunction tagged separately as CONJUNCTION"
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
  fun `accepts throughout as an ADVERBIAL without an object`() {
    val request = sentence("Claude uses tools throughout.")
    val raw = core(
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"Claude 助手"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"使用"},
      {"startToken":2,"endToken":2,"role":"OBJECT","translation":"工具"},
      {"startToken":3,"endToken":4,"role":"ADVERBIAL","translation":"全程"}
      """.trimIndent(),
      sentenceId = request.sentenceId,
    )

    assertTrue(validateCoreBatch(raw, listOf(request), "profile-1").ok)
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
  fun `accepts a non clausal fragment with one FRAGMENT_HEAD and modifiers`() {
    assertAccepted(
      "Portable API support across AI providers for Chat, text-to-image, and Embedding models.",
      """
      {"startToken":0,"endToken":2,"role":"FRAGMENT_HEAD","translation":"可移植 API 支持"},
      {"startToken":3,"endToken":5,"role":"ATTRIBUTE","translation":"跨 AI 提供商"},
      {"startToken":6,"endToken":14,"role":"ATTRIBUTE","translation":"面向聊天、文生图和嵌入模型"}
      """.trimIndent(),
    )
  }

  @Test
  fun `accepts one FRAGMENT_HEAD covering a whole multi word fragment`() {
    assertAccepted(
      "Portable API support across providers.",
      """{"startToken":0,"endToken":5,"role":"FRAGMENT_HEAD","translation":"跨提供商的可移植 API 支持"}""",
    )
  }

  @Test
  fun `rejects more than one FRAGMENT_HEAD`() {
    assertGrammarError(
      "Portable API support across providers.",
      """
      {"startToken":0,"endToken":1,"role":"FRAGMENT_HEAD","translation":"可移植 API"},
      {"startToken":2,"endToken":5,"role":"FRAGMENT_HEAD","translation":"跨提供商支持"}
      """.trimIndent(),
      "sentences[0].components",
      "a non-clausal fragment must contain at most one FRAGMENT_HEAD",
    )
  }

  @Test
  fun `rejects FRAGMENT_HEAD mixed with clause level roles`() {
    val forbiddenRoles = listOf(
      "SUBJECT",
      "PREDICATE",
      "OBJECT",
      "PREDICATIVE",
      "COMPLEMENT",
      "SUBJECT_CLAUSE",
      "OBJECT_CLAUSE",
      "PREDICATIVE_CLAUSE",
      "ADVERBIAL_CLAUSE",
      "COORDINATE_CLAUSE",
    )
    forbiddenRoles.forEach { forbiddenRole ->
      assertGrammarError(
        "Portable support works well.",
        """
        {"startToken":0,"endToken":1,"role":"FRAGMENT_HEAD","translation":"可移植支持"},
        {"startToken":2,"endToken":4,"role":"$forbiddenRole","translation":"运行良好"}
        """.trimIndent(),
        "sentences[0].components",
        "FRAGMENT_HEAD marks a non-clausal fragment and must not be mixed with clause-level " +
          "SUBJECT, PREDICATE, OBJECT, PREDICATIVE, COMPLEMENT, SUBJECT_CLAUSE, OBJECT_CLAUSE, " +
          "PREDICATIVE_CLAUSE, ADVERBIAL_CLAUSE, or the deprecated COORDINATE_CLAUSE; a whole " +
          "ATTRIBUTIVE_CLAUSE is the only clause role allowed beside a FRAGMENT_HEAD",
      )
    }
  }

  @Test
  fun `accepts a fragment head followed by a whole attributive clause`() {
    // fragment-relative:不成句的名词片段后跟一个完整定语从句,从句整块覆盖。
    assertAccepted(
      "An API that returns JSON responses.",
      """
      {"startToken":0,"endToken":1,"role":"FRAGMENT_HEAD","translation":"一个 API"},
      {"startToken":2,"endToken":5,"role":"ATTRIBUTIVE_CLAUSE","translation":"返回 JSON 响应的"}
      """.trimIndent(),
    )
  }

  @Test
  fun `keeps rejecting a fragment head followed by a truncated attributive clause`() {
    // 放行只针对「完整从句」:只标引导词依旧被从句最小长度门拦住。
    assertGrammarError(
      "An API that returns JSON responses.",
      """
      {"startToken":0,"endToken":1,"role":"FRAGMENT_HEAD","translation":"一个 API"},
      {"startToken":2,"endToken":2,"role":"ATTRIBUTIVE_CLAUSE","translation":"引导词"},
      {"startToken":3,"endToken":5,"role":"PREDICATE","translation":"返回 JSON 响应"}
      """.trimIndent(),
      "sentences[0].components[1]",
      "a clause component must cover a whole clause: extend it through the clause's own subject, " +
        "predicate, and any objects or adverbials instead of a single word",
    )
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
  fun `rejects an overlong whole-sentence fragment component`() {
    val text = "The quick brown fox jumps over the lazy dog near the river bank."
    val request = sentence(text)
    assertGrammarError(
      text,
      """{"startToken":0,"endToken":${request.tokens.last().id},"role":"FRAGMENT_HEAD","translation":"整句片段"}""",
      "sentences[0].components",
      "a whole-sentence fragment component must not exceed 10 lexical tokens; split it into a fragment head plus its modifiers",
    )
  }

  @Test
  fun `accepts bounded whole-sentence fragment roles`() {
    listOf(
      "What a wonderful surprise!" to GrammarRole.INDEPENDENT_ELEMENT,
      "A fast reliable secure modern accessible unified developer experience platform" to GrammarRole.FRAGMENT_HEAD,
      "A fast reliable secure modern accessible unified developer experience platform" to GrammarRole.APPOSITIVE,
    ).forEach { (text, role) ->
      val request = sentence(text)
      assertAccepted(
        text,
        """{"startToken":0,"endToken":${request.tokens.last().id},"role":"${role.name}","translation":"片段"}""",
      )
    }
  }

  @Test
  fun `keeps the known short complete-sentence FRAGMENT_HEAD gap visible`() {
    val text = "The system works correctly."
    val request = sentence(text)
    assertAccepted(
      text,
      """{"startToken":0,"endToken":${request.tokens.last().id},"role":"FRAGMENT_HEAD","translation":"系统正常工作"}""",
    )
  }

  @Test
  fun `accepts a short fragment covered by one component`() {
    // 三个实词以下的片段(标题、列表项)本来就没有可拆的同层结构,拆了只是噪音。
    assertAccepted(
      "Detailed usage instructions.",
      """{"startToken":0,"endToken":3,"role":"FRAGMENT_HEAD","translation":"详细使用说明"}""",
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
      "COORDINATE_CLAUSE is deprecated; analyse compound sentences as peer components (subject, predicate, object, …) " +
        "with the coordinating conjunction tagged separately as CONJUNCTION",
    )
  }

  @Test
  fun `rejects COORDINATE_CLAUSE even when CONJUNCTION is present`() {
    // 并列句约定已废弃：真正各带主语的并列分句现在也按同层成分平铺，只保留 CONJUNCTION。
    assertGrammarError(
      "The team shipped the code, and the client reviewed it.",
      """
      {"startToken":0,"endToken":4,"role":"COORDINATE_CLAUSE","translation":"团队发布了代码"},
      {"startToken":6,"endToken":6,"role":"CONJUNCTION","translation":"而且"},
      {"startToken":7,"endToken":10,"role":"COORDINATE_CLAUSE","translation":"客户审查了它"}
      """.trimIndent(),
      "sentences[0].components",
      "COORDINATE_CLAUSE is deprecated; analyse compound sentences as peer components (subject, predicate, object, …) " +
        "with the coordinating conjunction tagged separately as CONJUNCTION",
    )
  }

  @Test
  fun `accepts peer components with CONJUNCTION for compound structure`() {
    // 正确的并列句标注：各分句的 subject/predicate/object 平铺，CONJUNCTION 单独标记。
    assertAccepted(
      "The team shipped the code, and the client reviewed it.",
      """
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"团队"},
      {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"发布了"},
      {"startToken":3,"endToken":4,"role":"OBJECT","translation":"代码"},
      {"startToken":6,"endToken":6,"role":"CONJUNCTION","translation":"而且"},
      {"startToken":7,"endToken":8,"role":"SUBJECT","translation":"客户"},
      {"startToken":9,"endToken":9,"role":"PREDICATE","translation":"审查了"},
      {"startToken":10,"endToken":10,"role":"OBJECT","translation":"它"}
      """.trimIndent(),
    )
  }

  @Test
  fun `rejects a clause component that only covers its introducing word`() {
    // 线上实测:"that" 被单独标成 ATTRIBUTIVE_CLAUSE,从句的谓语与宾语平铺到主句层,
    // 页面上于是出现两个同级"谓语",引导词底下还挂着整个从句的译文。
    assertGrammarError(
      "Apple tests Siri feature that handles multiple commands.",
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"苹果"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"测试"},
      {"startToken":2,"endToken":3,"role":"OBJECT","translation":"Siri 功能"},
      {"startToken":4,"endToken":4,"role":"ATTRIBUTIVE_CLAUSE","translation":"处理多条指令的"},
      {"startToken":5,"endToken":5,"role":"PREDICATE","translation":"处理"},
      {"startToken":6,"endToken":8,"role":"OBJECT","translation":"多条指令"}
      """.trimIndent(),
      "sentences[0].components[3]",
      "a clause component must cover a whole clause: extend it through the clause's own subject, " +
        "predicate, and any objects or adverbials instead of a single word",
    )
  }

  @Test
  fun `accepts an object complement after an object's ATTRIBUTIVE_CLAUSE`() {
    assertAccepted(
      "We consider the movie that she directed a masterpiece.",
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"我们"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"认为"},
      {"startToken":2,"endToken":3,"role":"OBJECT","translation":"这部电影"},
      {"startToken":4,"endToken":6,"role":"ATTRIBUTIVE_CLAUSE","translation":"她导演的"},
      {"startToken":7,"endToken":8,"role":"COMPLEMENT","translation":"一部杰作"}
      """.trimIndent(),
    )
  }

  @Test
  fun `rejects an ATTRIBUTIVE_CLAUSE followed immediately by the object it should contain`() {
    // 主句宾语不可能出现在定语从句之后,出现了就说明从句自己的宾语被切了出来。
    assertGrammarError(
      "Apple tests Siri feature that handles multiple commands.",
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"苹果"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"测试"},
      {"startToken":2,"endToken":3,"role":"OBJECT","translation":"Siri 功能"},
      {"startToken":4,"endToken":5,"role":"ATTRIBUTIVE_CLAUSE","translation":"处理"},
      {"startToken":6,"endToken":8,"role":"OBJECT","translation":"多条指令"}
      """.trimIndent(),
      "sentences[0].components[3]",
      "an ATTRIBUTIVE_CLAUSE keeps its whole internal structure in one component; absorb the " +
        "object or predicative that follows it",
    )
  }

  @Test
  fun `accepts clauses that legally end on dangling object requiring prepositions`() {
    listOf(
      Triple("That's what dreams are made of.", 6, "of"),
      Triple("This is the range the value stays within.", 7, "within"),
      Triple("That is what the choice lies between.", 7, "between"),
      Triple("These are the peers the service runs among.", 8, "among"),
    ).forEach { (text, endToken, preposition) ->
      assertAccepted(
        text,
        """
        {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"主语"},
        {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"系词"},
        {"startToken":2,"endToken":$endToken,"role":"PREDICATIVE_CLAUSE","translation":"以 $preposition 收尾的从句"}
        """.trimIndent(),
      )
    }
  }

  @Test
  fun `rejects a component that ends on a preposition whose object was split off`() {
    // 实测 "near the frontier of what AI can do" 被切成介词悬空的状语 + 宾语从句。
    assertGrammarError(
      "He performed near the frontier of what AI can do.",
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"他"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"表现"},
      {"startToken":2,"endToken":5,"role":"ADVERBIAL","translation":"在前沿附近"},
      {"startToken":6,"endToken":10,"role":"OBJECT_CLAUSE","translation":"AI 能做到的事"}
      """.trimIndent(),
      "sentences[0].components[2]",
      "a component must not end on a preposition; merge the phrase that preposition governs " +
        "into the same component",
    )
  }

  @Test
  fun `rejects a SUBJECT_CLAUSE that does not start with an introducer`() {
    assertGrammarError(
      "Today, developers now play a frontline role.",
      """
      {"startToken":0,"endToken":1,"role":"INDEPENDENT_ELEMENT","translation":"今天"},
      {"startToken":2,"endToken":7,"role":"SUBJECT_CLAUSE","translation":"开发者现在发挥前线作用"}
      """.trimIndent(),
      "sentences[0].components[1]",
      "a SUBJECT_CLAUSE must start with a subject-clause introducer (that/whether/what/who/…); retag or extend the component",
    )
  }

  @Test
  fun `accepts valid subject-clause layouts without affecting other clause roles`() {
    listOf(
      "Whoever wins gets the prize." to """
        {"startToken":0,"endToken":1,"role":"SUBJECT_CLAUSE","translation":"无论谁获胜"},
        {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"获得"},
        {"startToken":3,"endToken":5,"role":"OBJECT","translation":"奖品"}
      """.trimIndent(),
      "How he did it remains a mystery." to """
        {"startToken":0,"endToken":3,"role":"SUBJECT_CLAUSE","translation":"他如何做到"},
        {"startToken":4,"endToken":4,"role":"PREDICATE","translation":"仍然是"},
        {"startToken":5,"endToken":7,"role":"PREDICATIVE","translation":"一个谜"}
      """.trimIndent(),
      "It is obvious that the cache is stale." to """
        {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"这"},
        {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"是"},
        {"startToken":2,"endToken":2,"role":"PREDICATIVE","translation":"显然的"},
        {"startToken":3,"endToken":8,"role":"SUBJECT_CLAUSE","translation":"缓存已过期"}
      """.trimIndent(),
      "The problem is that the cache is stale." to """
        {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"问题"},
        {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"是"},
        {"startToken":3,"endToken":8,"role":"PREDICATIVE_CLAUSE","translation":"缓存已过期"}
      """.trimIndent(),
    ).forEach { (text, components) -> assertAccepted(text, components) }
  }

  @Test
  fun `rejects non-clause roles that start with clause-only conjunctions`() {
    val message = "a component that starts with a subordinating conjunction (because/although/…) is a clause and must be tagged with a clause role (ADVERBIAL_CLAUSE/…)"
    listOf(
      Triple("Because the road was flooded, we stayed home.", 4, "ADVERBIAL"),
      Triple("Although the road was flooded, we stayed home.", 4, "ATTRIBUTE"),
      Triple("Because, we stayed.", 0, "ADVERBIAL"),
    ).forEach { (text, endToken, role) ->
      val request = sentence(text)
      assertGrammarError(
        text,
        """
        {"startToken":0,"endToken":$endToken,"role":"$role","translation":"从句"},
        {"startToken":${endToken + 1},"endToken":${request.tokens.last().id},"role":"INDEPENDENT_ELEMENT","translation":"主句"}
        """.trimIndent(),
        "sentences[0].components[0]",
        message,
      )
    }
  }

  @Test
  fun `accepts conservative non-clause conjunction exceptions`() {
    assertAccepted(
      "Because of this limitation, we stayed home.",
      """
      {"startToken":0,"endToken":4,"role":"ADVERBIAL","translation":"由于此限制"},
      {"startToken":5,"endToken":5,"role":"SUBJECT","translation":"我们"},
      {"startToken":6,"endToken":7,"role":"PREDICATE","translation":"留在家里"}
      """.trimIndent(),
    )
    assertAccepted(
      "The docs don't cover it, though.",
      """
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"文档"},
      {"startToken":2,"endToken":3,"role":"PREDICATE","translation":"没有涵盖"},
      {"startToken":4,"endToken":5,"role":"OBJECT","translation":"它"},
      {"startToken":6,"endToken":7,"role":"ADVERBIAL","translation":"不过"}
      """.trimIndent(),
    )
  }

  @Test
  fun `accepts a relative clause that keeps its own object and adverbial inside one component`() {
    assertAccepted(
      "Apple tests Siri feature that handles multiple commands at once.",
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"苹果"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"测试"},
      {"startToken":2,"endToken":3,"role":"OBJECT","translation":"Siri 功能"},
      {"startToken":4,"endToken":10,"role":"ATTRIBUTIVE_CLAUSE","translation":"能一次处理多条指令的"}
      """.trimIndent(),
    )
  }

  @Test
  fun `accepts a relative clause followed by the main clause predicate`() {
    assertAccepted(
      "The novel that she recommended won a national award.",
      """
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"那本小说"},
      {"startToken":2,"endToken":4,"role":"ATTRIBUTIVE_CLAUSE","translation":"她推荐的"},
      {"startToken":5,"endToken":5,"role":"PREDICATE","translation":"获得了"},
      {"startToken":6,"endToken":8,"role":"OBJECT","translation":"一项全国性奖项"}
      """.trimIndent(),
    )
  }

  @Test
  fun `accepts a relative clause followed by a main clause adverbial`() {
    // 定语从句修饰句中名词时,主句状语紧跟在从句后面是合法的——这条不得误拒。
    assertAccepted(
      "I met the man who called yesterday in the park.",
      """
      {"startToken":0,"endToken":0,"role":"SUBJECT","translation":"我"},
      {"startToken":1,"endToken":1,"role":"PREDICATE","translation":"遇见"},
      {"startToken":2,"endToken":3,"role":"OBJECT","translation":"那个男人"},
      {"startToken":4,"endToken":6,"role":"ATTRIBUTIVE_CLAUSE","translation":"昨天打电话来的"},
      {"startToken":7,"endToken":10,"role":"ADVERBIAL","translation":"在公园里"}
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
  fun `rejects an all-punctuation component list after pre-filtering`() {
    val request = sentence("...", sentenceId = "punctuation-only")
    val raw = core(
      """{"startToken":0,"endToken":0,"role":"INDEPENDENT_ELEMENT","translation":"省略号"}""",
      sentenceId = request.sentenceId,
    )

    val result = validateCoreBatch(raw, listOf(request), "profile-1")

    assertFalse(result.ok)
    assertTrue(
      result.errors.any {
        it.path == "sentences[0].components" &&
          it.message == "must contain a non-punctuation component"
      },
    )
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

  @Test
  fun `word list sizes stay pinned`() {
    assertEquals(7, coordinatingConjunctions.size)
    assertEquals(15, prepositions.size)
    assertEquals(7, subjectPronouns.size)
    assertEquals(13, determiners.size)
    assertEquals(21, subordinatingConjunctions.size)
    assertEquals(11, objectRequiringPrepositions.size)
    assertEquals(5, clauseOnlyConjunctions.size)
    assertEquals(15, subjectClauseIntroducers.size)
  }

  /**
   * Han 脚本边界与 Chrome 端共享 `shared-fixtures/translation-quality.json` 的
   * `hanScriptBoundary` 组(15 case):假名/谚文/CJK 标点/纯 ASCII false,
   * 扩展 A 区(㐀)/CJK 兼容区(丽 = U+2F800,代理对)/〇 true。有人把 `\p{IsHan}` 简化成
   * `[\u4e00-\u9fff]` 时,三个跨区块 true case 在双端同时变红——不再依赖单端口头验证。
   */
  @Test
  fun `Han script regex boundaries replay the shared fixture`() {
    val fixture = Json.parseToJsonElement(FixtureLoader.text("translation-quality.json")).jsonObject
    val boundaries = fixture.getValue("hanScriptBoundary").jsonArray

    assertEquals(15, boundaries.size)
    val ids = boundaries.map { it.jsonObject.getValue("id").jsonPrimitive.content }
    assertEquals(ids.size, ids.toSet().size)
    assertTrue(boundaries.any { it.jsonObject.getValue("containsHan").jsonPrimitive.content.toBooleanStrict() })
    assertTrue(boundaries.any { !it.jsonObject.getValue("containsHan").jsonPrimitive.content.toBooleanStrict() })

    boundaries.forEach { element ->
      val boundary = element.jsonObject
      val id = boundary.getValue("id").jsonPrimitive.content
      val text = boundary.getValue("text").jsonPrimitive.content
      val expected = boundary.getValue("containsHan").jsonPrimitive.content.toBooleanStrict()
      assertEquals(expected, hanPattern.containsMatchIn(text), "Han boundary case $id ($text)")
    }
  }

  @Test
  fun `shared translation quality fixture replays with exact ordered errors`() {
    val fixture = Json.parseToJsonElement(FixtureLoader.text("translation-quality.json")).jsonObject
    val cases = fixture.getValue("cases").jsonArray
    val ids = cases.map { it.jsonObject.getValue("id").jsonPrimitive.content }

    assertEquals(1, fixture.getValue("schemaVersion").jsonPrimitive.content.toInt())
    assertTrue(cases.isNotEmpty())
    assertEquals(ids.size, ids.toSet().size)

    cases.forEach { element ->
      val testCase = element.jsonObject
      val sentenceJson = testCase.getValue("sentence").jsonObject
      val text = sentenceJson.getValue("text").jsonPrimitive.content
      val sentence = SentenceInput(
        sentenceId = sentenceJson.getValue("id").jsonPrimitive.content,
        text = text,
        tokens = tokenize(text),
      )
      val accepted = testCase.getValue("accepted").jsonPrimitive.content.toBooleanStrict()
      val result = validateCoreBatch(testCase.getValue("raw"), listOf(sentence), "translation-quality-fixture")
      assertEquals(accepted, result.ok, "fixture case ${testCase.id()} acceptance")
      assertEquals(expectedErrors(testCase), result.errors.map { it.path to it.message }, "fixture case ${testCase.id()}")
    }
  }

  private fun expectedErrors(testCase: JsonObject) = testCase.getValue("expected").jsonArray.map { element ->
    val expected = element.jsonObject
    expected.getValue("path").jsonPrimitive.content to expected.getValue("message").jsonPrimitive.content
  }

  private fun JsonObject.id() = getValue("id").jsonPrimitive.content
}
