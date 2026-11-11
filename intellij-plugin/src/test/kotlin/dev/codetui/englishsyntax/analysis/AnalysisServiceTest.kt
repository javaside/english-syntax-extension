package dev.codetui.englishsyntax.analysis

import dev.codetui.englishsyntax.cache.AnalysisCache
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.language.tokenize
import dev.codetui.englishsyntax.language.validateCoreBatch
import dev.codetui.englishsyntax.model.ChatMessage
import dev.codetui.englishsyntax.model.ChatTurn
import dev.codetui.englishsyntax.model.JsonSchemaSpec
import dev.codetui.englishsyntax.model.OpenAiCompatibleClient
import dev.codetui.englishsyntax.model.StreamedComponent
import dev.codetui.englishsyntax.scheduler.RequestScheduler
import dev.codetui.englishsyntax.settings.CredentialStore
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import dev.codetui.englishsyntax.contract.FixtureLoader
import dev.codetui.englishsyntax.testsupport.FakeOpenAiServer
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class AnalysisServiceTest {
  private lateinit var tempDir: java.nio.file.Path
  private lateinit var server: FakeOpenAiServer
  private lateinit var cache: AnalysisCache
  private lateinit var service: AnalysisService

  private val json = Json { prettyPrint = false }

  @BeforeTest
  fun setUp() {
    tempDir = createTempDirectory("analysis-service")
    server = FakeOpenAiServer()
    cache = AnalysisCache(tempDir.resolve("cache.sqlite"))
    service = newService()
  }

  @AfterTest
  fun tearDown() {
    cache.close()
    server.close()
    tempDir.toFile().deleteRecursively()
  }

  private object NoopCredentialStore : CredentialStore {
    override suspend fun get(profileId: String, field: String): String? = null
    override suspend fun put(profileId: String, field: String, value: String) = Unit
    override suspend fun delete(profileId: String, field: String) = Unit
  }

  private class MapCredentialStore : CredentialStore {
    val values = mutableMapOf<Pair<String, String>, String>()

    override suspend fun get(profileId: String, field: String): String? = values[profileId to field]

    override suspend fun put(profileId: String, field: String, value: String) {
      values[profileId to field] = value
    }

    override suspend fun delete(profileId: String, field: String) {
      values.remove(profileId to field)
    }
  }

  private fun newService(
    loopbackDetector: (String) -> Boolean = { true },
    scheduler: RequestScheduler = RequestScheduler(concurrency = 4),
    credentials: CredentialStore = NoopCredentialStore,
  ) = AnalysisService(
    client = OpenAiCompatibleClient(credentials),
    cache = cache,
    scheduler = scheduler,
    loopbackDetector = loopbackDetector,
  )

  private fun profile(baseUrl: String = server.baseUrl, timeoutMs: Int = 30_000) = ModelProfile(
    id = "profile-1",
    name = "Test",
    baseUrl = baseUrl,
    model = "test-model",
    headerNames = emptySet(),
    timeoutMs = timeoutMs,
    jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
  )

  private fun sentence(id: String, text: String) = SentenceInput(id, text, tokenize(text))

  /**
   * 构造一个覆盖整句的合法 core raw envelope。必须是真的同层划分：
   * 「单成分包住整句」现在被 validator 判非法（那等于没有划分）。
   * 两个用到它的句子("The service validates every response." /
   * "Sentence number N has words.")token 布局相同：实词 0-4、句点 5。
   */
  private fun validCoreRaw(vararg ids: String): String {
    val components = """
      {"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},
      {"startToken":2,"endToken":2,"role":"PREDICATE","translation":"校验"},
      {"startToken":3,"endToken":5,"role":"OBJECT","translation":"每个响应"}
    """.trimIndent().replace("\n", "")
    val sentences = ids.joinToString(",") { id ->
      """{"sentenceId":"$id","components":[$components]}"""
    }
    return """{"sentences":[$sentences]}"""
  }

  @Test
  fun `core request sends a valid object schema with required arrays and properties`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    server.enqueueJson(validCoreRaw("s1"))

    service.analyzeCore(profile(), "doc-1", listOf(sentence))

    val schema = server.requests.single().body.getValue("response_format").jsonObject
      .getValue("json_schema").jsonObject.getValue("schema").jsonObject
    assertEquals(listOf("sentences"), schema.getValue("required").jsonArray.map { it.jsonPrimitive.content })
    val sentenceSchema = schema.getValue("properties").jsonObject.getValue("sentences").jsonObject
      .getValue("items").jsonObject
    assertEquals(
      setOf("sentenceId", "components"),
      sentenceSchema.getValue("required").jsonArray.map { it.jsonPrimitive.content }.toSet(),
    )
    assertTrue(sentenceSchema.getValue("properties").jsonObject.containsKey("components"))
  }

  @Test
  fun `cache hit does not call the client`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    // 直接以 Chrome CoreAnalysis 交换形状写入一条合法缓存。
    val key = dev.codetui.englishsyntax.cache.createCoreCacheKey(
      dev.codetui.englishsyntax.cache.CoreCacheKeyInput(
        "The service validates every response.",
        dev.codetui.englishsyntax.domain.ContractVersions.CORE_SCHEMA,
        dev.codetui.englishsyntax.domain.ContractVersions.CORE_PROMPT,
      ),
    )
    cache.putCore(
      key,
      "other-profile",
      json.parseToJsonElement("""{"schemaVersion":${dev.codetui.englishsyntax.domain.ContractVersions.CORE_SCHEMA},"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},{"startToken":2,"endToken":2,"role":"PREDICATE","translation":"校验"},{"startToken":3,"endToken":5,"role":"OBJECT","translation":"每个响应"}],"modelProfileId":"other-profile"}""") as JsonObject,
    )

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(0, server.requests.size)
    assertTrue(outcome.cacheHit)
    assertEquals(1, outcome.result.size)
    assertEquals("profile-1", outcome.result[0].modelProfileId)
  }

  @Test
  fun `loopback chunks six sentences per request`() = runBlocking {
    // 假服务器在 127.0.0.1 → loopback 策略：一次请求合并全部 6 句。
    val sentences = (1..6).map { sentence("s$it", "Sentence number $it has words.") }
    server.enqueueJson(validCoreRaw(*Array(6) { "s${it + 1}" }))

    val outcome = service.analyzeCore(profile(), "doc-1", sentences)

    assertEquals(1, server.requests.size)
    assertEquals(6, outcome.result.size)
    // 请求体中携带全部 6 个句子。
    val body = server.requests[0].body["messages"].toString()
    sentences.forEach { assertTrue(body.contains(it.sentenceId), "missing ${it.sentenceId}") }
  }

  @Test
  fun `remote chunking uses two sentences per request`() = runBlocking {
    val remoteService = newService(loopbackDetector = { false })
    val sentences = (1..5).map { sentence("s$it", "Sentence number $it has words.") }
    // 假服务器按 FIFO 回队，而 3 个 chunk 的 HTTP 到达顺序不定；每份响应都包含
    // 全部 5 句（校验按句提取，多余的兄弟句无副作用），任意配对都能通过。
    val anyChunk = validCoreRaw("s1", "s2", "s3", "s4", "s5")
    server.enqueueJson(anyChunk)
    server.enqueueJson(anyChunk)
    server.enqueueJson(anyChunk)

    val outcome = remoteService.analyzeCore(profile(), "doc-1", sentences)

    assertEquals(3, server.requests.size)
    assertEquals(5, outcome.result.size)
    assertTrue(outcome.failures.isEmpty())
  }

  @Test
  fun `invalid sentence gets repaired once`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    // 首轮缺覆盖（只覆盖到 token 0-1，句内还有非标点 token 未覆盖）
    server.enqueueJson("""{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"部分"}]}]}""")
    // 修复轮给出合法结果
    server.enqueueJson(validCoreRaw("s1"))

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(2, server.requests.size)
    assertTrue(outcome.failures.isEmpty())
    assertEquals(1, outcome.result.size)
  }

  @Test
  fun `truncated first round is salvaged instead of killing the chunk`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    // 少最后一个 `}`：本机模型每次如此。救回来即合法，一趟就够。
    val truncated = validCoreRaw("s1").removeSuffix("}")
    server.enqueueJson(truncated)

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(1, server.requests.size)
    assertTrue(outcome.failures.isEmpty())
    assertEquals(1, outcome.result.size)
  }

  @Test
  fun `unsalvageable first round still enters the repair loop`() = runBlocking {
    // 回归:此前首轮 INVALID_MODEL_OUTPUT 直接把整块判死，修复轮压根不跑。
    val sentence = sentence("s1", "The service validates every response.")
    server.enqueueJson("对不起，我无法解析这句话。")
    server.enqueueJson(validCoreRaw("s1"))

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(2, server.requests.size)
    assertTrue(outcome.failures.isEmpty())
    assertEquals(1, outcome.result.size)
  }

  @Test
  fun `sentence still invalid after first repair gets a second repair`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    val invalid = """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"部分"}]}]}"""
    server.enqueueJson(invalid)
    server.enqueueJson(invalid)
    server.enqueueJson(validCoreRaw("s1"))

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(3, server.requests.size)
    assertTrue(outcome.failures.isEmpty())
    assertEquals(1, outcome.result.size)
  }

  @Test
  fun `two unparseable repair responses become invalid model output`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    server.enqueueJson("not-json-first")
    server.enqueueJson("not-json-repair-one")
    server.enqueueJson("not-json-repair-two")

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(3, server.requests.size)
    assertEquals(1, outcome.failures.size)
    assertEquals(
      dev.codetui.englishsyntax.domain.ErrorCode.INVALID_MODEL_OUTPUT,
      outcome.failures[0].error.code,
    )
  }

  @Test
  fun `shared evaluation trace replays through production service with identical shrinking subsets`() = runBlocking {
    val fixture = json.parseToJsonElement(FixtureLoader.text("core-evaluation-traces.json")).jsonObject
    assertEquals("core-evaluation-trace/v1", fixture.getValue("schemaVersion").jsonPrimitive.content)
    val trace = fixture.getValue("traces").jsonArray.first().jsonObject
    val snapshots = fixture.getValue("tokenizerSnapshot").jsonObject.getValue("sentences").jsonArray
      .associate { item ->
        val value = item.jsonObject
        value.getValue("id").jsonPrimitive.content to value.getValue("text").jsonPrimitive.content
      }
    val ids = trace.getValue("inputSentenceIds").jsonArray.map { it.jsonPrimitive.content }
    val denominator = fixture.getValue("corpus").jsonObject.getValue("denominatorSentenceIds").jsonArray
      .map { it.jsonPrimitive.content }
    assertEquals(denominator.take(6), ids)
    val sentences = ids.map { id -> sentence(id, snapshots.getValue(id)) }
    val firstPass = trace.getValue("firstPass").jsonObject
    val repairs = trace.getValue("repairs").jsonArray.map { it.jsonObject }
    val rounds = listOf(firstPass) + repairs
    assertEquals(ids, firstPass.getValue("subsetSentenceIds").jsonArray.map { it.jsonPrimitive.content })
    assertEquals(listOf(1, 2), repairs.map { it.getValue("round").jsonPrimitive.content.toInt() })
    rounds.forEach { round -> server.enqueueJson(round.getValue("raw").toString()) }

    val outcome = service.analyzeCore(
      profile(),
      "trace-doc",
      sentences,
      bypassCache = true,
    )

    assertEquals(3, server.requests.size)
    val observedMessages = server.requests.map { request -> request.body.getValue("messages").jsonArray }
    val expectedMessages = rounds.map { round -> round.getValue("messages").jsonArray }
    assertEquals(expectedMessages, observedMessages)
    val observedDiagnostics = rounds.map { round ->
      val subsetIds = round.getValue("subsetSentenceIds").jsonArray.map { it.jsonPrimitive.content }
      val subset = sentences.filter { it.sentenceId in subsetIds }
      validateCoreBatch(round.getValue("raw"), subset, "profile-1").errors
        .map { it.path to it.message }
    }
    val expectedDiagnostics = rounds.map { round ->
      round.getValue("validatorErrors").jsonArray.flatMap { rejection ->
        rejection.jsonObject.getValue("errors").jsonArray.map { error ->
          val value = error.jsonObject
          value.getValue("path").jsonPrimitive.content to value.getValue("message").jsonPrimitive.content
        }
      }
    }
    assertEquals(expectedDiagnostics, observedDiagnostics)
    val final = trace.getValue("final").jsonObject
    assertEquals(
      final.getValue("successSentenceIds").jsonArray.map { it.jsonPrimitive.content },
      outcome.result.map { it.sentenceId },
    )
    assertEquals(
      final.getValue("failureSentenceIds").jsonArray.map { it.jsonPrimitive.content },
      outcome.failures.map { it.sentenceId },
    )
    val expectedSubsets = repairs.map { repair ->
      repair.getValue("subsetSentenceIds").jsonArray.map { it.jsonPrimitive.content }
    }
    val observedSubsets = server.requests.drop(1).map { request ->
      ids.filter { id -> request.body.getValue("messages").toString().contains("\\\"sentenceId\\\":\\\"$id\\\"") }
    }
    assertEquals(expectedSubsets, observedSubsets)
    assertTrue(observedSubsets.flatten().none { it == ids[0] })
    val firstErrors = firstPass.getValue("validatorErrors").jsonArray
    assertTrue(firstErrors.any { it.jsonObject.getValue("sentenceId").jsonPrimitive.content == ids[1] })
    val damagedId = ids[2]
    val damagedErrors = firstErrors.single {
      it.jsonObject.getValue("sentenceId").jsonPrimitive.content == damagedId
    }.jsonObject.getValue("errors").jsonArray
    assertEquals(listOf("non-grammar"), damagedErrors.map { it.jsonObject.getValue("kind").jsonPrimitive.content })
    val corpusById = fixture.getValue("corpus").jsonObject.getValue("sentences").jsonArray.associate {
      it.jsonObject.getValue("id").jsonPrimitive.content to it.jsonObject
    }
    val tokenizerById = fixture.getValue("tokenizerSnapshot").jsonObject.getValue("sentences").jsonArray.associate {
      it.jsonObject.getValue("id").jsonPrimitive.content to it.jsonObject
    }
    val damagedGold = corpusById.getValue(damagedId).getValue("boundaries").jsonArray.map { boundary ->
      val value = boundary.jsonObject
      val tokens = tokenizerById.getValue(damagedId).getValue("tokens").jsonArray
      Triple(
        tokens.single { it.jsonObject.getValue("start").jsonPrimitive.content.toInt() == value.getValue("startChar").jsonPrimitive.content.toInt() }.jsonObject.getValue("id").jsonPrimitive.content.toInt(),
        tokens.single { it.jsonObject.getValue("end").jsonPrimitive.content.toInt() == value.getValue("endChar").jsonPrimitive.content.toInt() }.jsonObject.getValue("id").jsonPrimitive.content.toInt(),
        value.getValue("role").jsonPrimitive.content,
      )
    }
    fun componentShape(analysis: JsonObject): List<Triple<Int, Int, String>> =
      analysis.getValue("components").jsonArray.map { component ->
        val value = component.jsonObject
        Triple(
          value.getValue("startToken").jsonPrimitive.content.toInt(),
          value.getValue("endToken").jsonPrimitive.content.toInt(),
          value.getValue("role").jsonPrimitive.content,
        )
      }
    val damagedFirst = firstPass.getValue("raw").jsonObject.getValue("sentences").jsonArray
      .single { it.jsonObject.getValue("sentenceId").jsonPrimitive.content == damagedId }.jsonObject
    val damagedFinal = final.getValue("analyses").jsonArray
      .single { it.jsonObject.getValue("sentenceId").jsonPrimitive.content == damagedId }.jsonObject
    assertEquals(damagedGold, componentShape(damagedFirst))
    assertTrue(damagedGold != componentShape(damagedFinal))
    val failedId = ids[3]
    assertTrue(rounds.all { round ->
      round.getValue("validatorErrors").jsonArray.any {
        it.jsonObject.getValue("sentenceId").jsonPrimitive.content == failedId
      }
    })
    val narrowA = ids[4]
    val narrowB = ids[5]
    assertTrue(narrowA in expectedSubsets[0] && narrowB in expectedSubsets[0])
    assertTrue(narrowA !in expectedSubsets[1] && narrowB in expectedSubsets[1])
    assertEquals(listOf(failedId), final.getValue("failureSentenceIds").jsonArray.map { it.jsonPrimitive.content })
    val expectedAnalyses = final.getValue("analyses").jsonArray.map { analysis ->
      val value = analysis.jsonObject
      value.getValue("sentenceId").jsonPrimitive.content to value.getValue("components").jsonArray.map { component ->
        val fields = component.jsonObject
        Triple(
          fields.getValue("startToken").jsonPrimitive.content.toInt(),
          fields.getValue("endToken").jsonPrimitive.content.toInt(),
          fields.getValue("role").jsonPrimitive.content,
        )
      }
    }
    assertEquals(
      expectedAnalyses,
      outcome.result.map { analysis ->
        analysis.sentenceId to analysis.components.map { Triple(it.startToken, it.endToken, it.role.name) }
      },
    )
  }

  @Test
  fun `core stream never renders a punctuation token as a grammar component`() = runBlocking {
    val sentence = sentence("s1", "The service works, reliably.")
    val raw = """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},{"startToken":2,"endToken":2,"role":"PREDICATE","translation":"工作"},{"startToken":3,"endToken":3,"role":"CONJUNCTION","translation":"，"},{"startToken":4,"endToken":4,"role":"ADVERBIAL","translation":"可靠地"}]}]}"""
    server.enqueueSse(listOf(raw))
    val streamed = mutableListOf<List<CoreComponent>>()

    val outcome = service.analyzeCore(
      profile(),
      "doc-1",
      listOf(sentence),
      onStreamedComponent = StreamedComponentSink { _, components -> streamed += components },
    )

    assertTrue(outcome.failures.isEmpty())
    assertEquals(listOf(1, 2, 3), streamed.map { it.size })
    assertTrue(streamed.flatten().none { it.startToken == 3 && it.endToken == 3 })
  }

  @Test
  fun `streamed provisional components do not reach the cache`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    // 带流式 sink 的请求走流式路径：假服务器需要返回 SSE 分片。
    val first = """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},{"startToken":2,"endToken":2,"role":"PREDICATE","translation":"校验"},{"startToken":3,"endToken":5,"role":"OBJECT","translation":"每个响应"}"""
    val rest = "]}]}"
    server.enqueueSse(listOf(first, rest))
    val streamed = mutableListOf<String>()

    val outcome = service.analyzeCore(
      profile(),
      "doc-1",
      listOf(sentence),
      onStreamedComponent = StreamedComponentSink { id, _ -> streamed += id },
    )

    assertEquals(1, outcome.result.size)
    // 流式 sink 收到过暂定成分；完整结果已校验并写缓存（第二次查询命中）。
    assertTrue(streamed.isNotEmpty())
    server.clearRequests()
    val second = service.analyzeCore(profile(), "doc-1", listOf(sentence))
    assertTrue(second.cacheHit)
    assertEquals(0, server.requests.size)
  }

  @Test
  fun `detail stream drops nested structures before rendering`() = runBlocking {
    val sentence = sentence("s1", "Start by classifying how much process the request needs.")
    val core = CoreAnalysis(
      sentenceId = "s1",
      components = listOf(CoreComponent(2, 9, GrammarRole.OBJECT_CLAUSE, "请求需要多少处理过程")),
      modelProfileId = "profile-1",
    )
    val overlapping = """{"sentenceId":"s1","focus":{"startToken":2,"endToken":9},"structures":[{"startToken":2,"endToken":9,"role":"宾语从句","explanation":"整个从句"},{"startToken":2,"endToken":3,"role":"引导词","explanation":"重复内部"}],"grammarPoints":[],"explanation":"解析"}"""
    val repaired = """{"sentenceId":"s1","focus":{"startToken":2,"endToken":9},"structures":[{"startToken":2,"endToken":3,"role":"引导词","explanation":"疑问词短语"},{"startToken":4,"endToken":5,"role":"主语","explanation":"名词短语"},{"startToken":6,"endToken":9,"role":"谓语","explanation":"谓语部分"}],"grammarPoints":[],"explanation":"解析"}"""
    server.enqueueSse(listOf(overlapping))
    server.enqueueJson(repaired)
    val streamed = mutableListOf<List<DetailStructure>>()

    val outcome = service.analyzeDetail(
      profile(),
      "doc-1",
      sentence,
      core,
      TokenRange(2, 9),
      StreamedStructureSink { _, _, structures -> streamed += structures },
    )

    assertEquals(listOf(1), streamed.map { it.size })
    assertEquals(3, outcome.result.structures.size)
  }

  @Test
  fun `detail cache key matches the click path`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    val core = CoreAnalysis(
      sentenceId = "s1",
      components = listOf(CoreComponent(0, 5, GrammarRole.SUBJECT, "整句")),
      modelProfileId = "profile-1",
    )
    server.enqueueJson(
      """{"sentenceId":"s1","focus":{"startToken":0,"endToken":1},"structures":[{"startToken":0,"endToken":1,"role":"主语","explanation":"名词短语"}],"grammarPoints":["一般现在时"],"explanation":"主语解析"}""",
    )

    val outcome = service.analyzeDetail(profile(), "doc-1", sentence, core, TokenRange(0, 1))
    assertTrue(!outcome.cacheHit)
    assertEquals(1, server.requests.size)

    // 第二次同 focus 查询命中缓存
    server.clearRequests()
    val second = service.analyzeDetail(profile(), "doc-1", sentence, core, TokenRange(0, 1))
    assertTrue(second.cacheHit)
    assertEquals(0, server.requests.size)
    assertEquals(outcome.result.structures, second.result.structures)
  }

  /** 与 Chrome 端 analysis-service.test.ts「英文回显译文被拒并走修复」逐条同构。 */
  @Test
  fun `echo translation triggers repair whose prompt carries the exact error and caches only the fixed chinese`() = runBlocking {
    val sentence = sentence("s1", "Learners read.")
    // 首轮：两个成分都原样回显英文 span（无 Han）。
    val echo = """{"sentences":[{"sentenceId":"s1","components":[""" +
      """{"startToken":0,"endToken":0,"role":"SUBJECT","translation":"Learners"},""" +
      """{"startToken":1,"endToken":2,"role":"PREDICATE","translation":"read."}]}]}"""
    val repaired = """{"sentences":[{"sentenceId":"s1","components":[""" +
      """{"startToken":0,"endToken":0,"role":"SUBJECT","translation":"学习者"},""" +
      """{"startToken":1,"endToken":2,"role":"PREDICATE","translation":"阅读"}]}]}"""
    server.enqueueJson(echo)
    server.enqueueJson(repaired)

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(0, outcome.failures.size)
    assertEquals(1, outcome.result.size)
    assertEquals(listOf("学习者", "阅读"), outcome.result[0].components.map { it.translation })
    assertEquals(2, server.requests.size)
    val repairPrompt = server.requests[1].body.getValue("messages").jsonArray
      .first().jsonObject.getValue("content").jsonPrimitive.content
    assertTrue(
      "translation must include a meaningful Chinese gloss for the complete covered English span instead of echoing or only copying it" in repairPrompt,
    )
    // 只缓存修好的中文版本：缓存条目数 = 成功句数 = 1，且重新读取不触发请求。
    server.clearRequests()
    val second = service.analyzeCore(profile(), "doc-1", listOf(sentence))
    assertTrue(second.cacheHit)
    assertEquals(0, server.requests.size)
    assertEquals(listOf("学习者", "阅读"), second.result[0].components.map { it.translation })
  }

  /** DETAIL_PROMPT_VERSION 7：详解修复轮必须带输出模板与完整中文角色词表（含低频角色）。 */
  @Test
  fun `detail repair prompt carries output shape and the full Chinese role glossary`() = runBlocking {
    val sentence = sentence("s1", "The service works.")
    val core = CoreAnalysis(
      sentenceId = "s1",
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "profile-1",
    )
    // 首轮 explanation 为空 → 校验失败进修复轮。
    server.enqueueJson(
      """{"sentenceId":"s1","focus":{"startToken":0,"endToken":1},"structures":[],"grammarPoints":[],"explanation":""}""",
    )
    server.enqueueJson(
      """{"sentenceId":"s1","focus":{"startToken":0,"endToken":1},"structures":[{"startToken":0,"endToken":1,"role":"主语","explanation":"名词短语"}],"grammarPoints":[],"explanation":"主语解析"}""",
    )

    service.analyzeDetail(profile(), "doc-1", sentence, core, TokenRange(0, 1))

    assertEquals(2, server.requests.size)
    val repairPrompt = server.requests[1].body.getValue("messages").jsonArray
      .first().jsonObject.getValue("content").jsonPrimitive.content
    // 输出 shape(与首轮 DETAIL_OUTPUT_SHAPE 同款 JSON 形状行与紧凑指令)。
    assertTrue(
      """{"sentenceId": string, "focus": {"startToken": number, "endToken": number}, "structures""""
        .replace("\\\"", "\"") in repairPrompt,
    )
    assertTrue("Output minified JSON on a single line" in repairPrompt)
    // 中文角色词表:低频角色必须出现在修复轮。
    for (term in listOf("主语", "谓语", "宾语", "定语", "状语", "表语", "补语", "同位语", "独立成分", "系动词", "引导词", "连词", "片段主体")) {
      assertTrue(term in repairPrompt, "detail repair 缺少角色词「$term」")
    }
    // 假服务器红线:Focus: 标签原样保留。
    assertTrue("Focus:" in repairPrompt)
  }

  @Test
  fun `echo translation under the current cache key is treated as a miss and re-requested`() = runBlocking {
    val sentence = sentence("s1", "Learners read.")
    val chinese = """{"sentences":[{"sentenceId":"s1","components":[""" +
      """{"startToken":0,"endToken":0,"role":"SUBJECT","translation":"学习者"},""" +
      """{"startToken":1,"endToken":2,"role":"PREDICATE","translation":"阅读"}]}]}"""
    server.enqueueJson(chinese)
    service.analyzeCore(profile(), "doc-1", listOf(sentence))
    server.clearRequests()

    // 把当前 key 下的缓存值改写为英文回显形状（旧版本写入的合法形状）。
    val key = dev.codetui.englishsyntax.cache.createCoreCacheKey(
      dev.codetui.englishsyntax.cache.CoreCacheKeyInput(
        sentence.text,
        dev.codetui.englishsyntax.domain.ContractVersions.CORE_SCHEMA,
        dev.codetui.englishsyntax.domain.ContractVersions.CORE_PROMPT,
      ),
    )
    cache.putCore(
      key,
      "stale-profile",
      json.parseToJsonElement(
        """{"schemaVersion":${dev.codetui.englishsyntax.domain.ContractVersions.CORE_SCHEMA},"sentenceId":"s1","components":[""" +
          """{"startToken":0,"endToken":0,"role":"SUBJECT","translation":"Learners"},""" +
          """{"startToken":1,"endToken":2,"role":"PREDICATE","translation":"read."}],"modelProfileId":"stale-profile"}""",
      ) as JsonObject,
    )
    server.enqueueJson(chinese)

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertTrue(!outcome.cacheHit)
    assertEquals(1, server.requests.size)
    assertEquals(listOf("学习者", "阅读"), outcome.result[0].components.map { it.translation })
    // 回显旧值没有留下第二条缓存；当前 key 指向重取后的中文结果。
    server.clearRequests()
    val second = service.analyzeCore(profile(), "doc-1", listOf(sentence))
    assertTrue(second.cacheHit)
    assertEquals(0, server.requests.size)
    assertEquals(listOf("学习者", "阅读"), second.result[0].components.map { it.translation })
  }

  @Test
  fun `echo translation surviving two repairs fails without a third round or caching`() = runBlocking {
    val sentence = sentence("s1", "Learners read.")
    val echo = """{"sentences":[{"sentenceId":"s1","components":[""" +
      """{"startToken":0,"endToken":0,"role":"SUBJECT","translation":"Learners"},""" +
      """{"startToken":1,"endToken":2,"role":"PREDICATE","translation":"read."}]}]}"""
    server.enqueueJson(echo)
    server.enqueueJson(echo)
    server.enqueueJson(echo)

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(0, outcome.result.size)
    assertEquals(1, outcome.failures.size)
    assertEquals("s1", outcome.failures[0].sentenceId)
    assertEquals(dev.codetui.englishsyntax.domain.ErrorCode.INVALID_MODEL_OUTPUT, outcome.failures[0].error.code)
    // 首轮 + 至多两轮修复，绝无第三轮；失败结果不写缓存（缓存条目数为 0）。
    assertEquals(3, server.requests.size)
    assertEquals(0, cache.stats().entries)
  }

  // ---- 追问对话（chat）：无缓存、无修复轮、独立命名空间、按轮 cacheKey ----

  private val chatInput: SentenceInput get() = sentence("s1", "The service validates every response.")
  private val chatCore = CoreAnalysis(
    sentenceId = "s1",
    components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
    modelProfileId = "profile-1",
  )

  @Test
  fun `chat streams the accumulated full text and wires the chat prompt`() = runBlocking {
    server.enqueueSse(listOf("这个", "动词", "是谓语。"))
    val pushed = mutableListOf<String>()

    val answer = service.chat(
      profile(), "doc-1", "c1", chatInput, chatCore,
      listOf(ChatTurn("user", "上一问"), ChatTurn("assistant", "上一答")),
      "validates 是什么成分？",
      StreamedTextSink { pushed += it },
    )

    // 每次回调给的都是截至目前的完整回答（整段重画约定）。
    assertEquals(listOf("这个", "这个动词", "这个动词是谓语。"), pushed)
    assertEquals("这个动词是谓语。", answer)
    assertEquals(1, server.requests.size)
    val content = server.requests[0].body.getValue("messages").jsonArray.first().jsonObject
      .getValue("content").jsonPrimitive.content
    assertTrue(content.startsWith("Discuss the verified translation analysis with the reader."))
    assertTrue(content.contains("""{"role":"user","content":"上一问"}"""))
  }

  @Test
  fun `chat buffered path returns free text without cache or repair`() = runBlocking {
    server.enqueueJson("对不起，这个问题与句法无关。")

    val answer = service.chat(profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "今天天气如何？")

    // 自由文本原样返回：既不走 JSON 校验，也没有修复轮。
    assertEquals("对不起，这个问题与句法无关。", answer)
    assertEquals(1, server.requests.size)
    assertEquals(0, cache.stats().entries)
  }

  @Test
  fun `chat is never cached - repeated identical turns hit the model again`() = runBlocking {
    server.enqueueJson("第一次回答")
    server.enqueueJson("第二次回答")

    val first = service.chat(profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "同一句重复问")
    val second = service.chat(profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "同一句重复问")

    assertEquals("第一次回答", first)
    assertEquals("第二次回答", second)
    assertEquals(2, server.requests.size)
    assertEquals(0, cache.stats().entries)
  }

  @Test
  fun `two different questions in one conversation are two separate in-flight turns`() = runBlocking {
    server.enqueueJson("回答甲")
    server.enqueueJson("回答乙")

    val first = async { service.chat(profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "问题甲") }
    while (server.requests.isEmpty()) delay(10)
    val second = async { service.chat(profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "问题乙") }

    assertEquals("回答甲", first.await())
    assertEquals("回答乙", second.await())
    // 按轮 cacheKey 防住调度器去重：若 key 不含问题，第二问会直接拿到第一问的 promise。
    assertEquals(2, server.requests.size)
  }

  @Test
  fun `chat runs in its own scheduler namespace - page cancellation leaves it alone`() = runBlocking {
    server.enqueueSlowSse(listOf("缓", "慢", "回", "答"), gapMillis = 120)

    val job = async {
      service.chat(profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "问", StreamedTextSink { })
    }
    while (server.requests.isEmpty()) delay(10)
    // 页面命名空间的取消精确匹配，绝不连坐 "${documentId}:chat"。
    service.cancelDocument("doc-1")

    assertEquals("缓慢回答", job.await())
  }

  @Test
  fun `cancelDocument on the chat namespace cancels an in-flight chat`() = runBlocking {
    server.enqueueSlowSse(listOf("缓", "慢"), gapMillis = 300)

    // runCatching 放在 async 内部：async 子协程的失败会取消 runBlocking 父协程。
    val job = async {
      runCatching {
        service.chat(profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "问", StreamedTextSink { })
      }
    }
    while (server.requests.isEmpty()) delay(10)
    service.cancelDocument("doc-1:chat")

    val error = job.await().exceptionOrNull()
    assertNotNull(error)
    assertEquals(ErrorCode.REQUEST_CANCELLED, (error as ExtensionFailure).code)
  }

  /**
   * 调度器对可重试失败会静默重跑 run()：流式累积器必须声明在 run 块内部、每次尝试
   * 从零累积，否则重试会把两次尝试的流拼成 "AB…AB…"（Chrome analysis-service.ts 同款教训）。
   */
  @Test
  fun `a retryable mid-stream failure restarts the text without concatenating attempts`() = runBlocking {
    // 第一次尝试：两片后停在尾部空转 → 静默超时（可重试）→ 调度器静默重跑。
    // tailGap 必须 > 静默超时检出点(~2×timeoutMs)且 < 重试到达时刻(timeout+500ms 退避),
    // 否则假服务器单线程 handler 会把第二次尝试挡在门外、烧掉队尾响应。
    server.enqueueSlowSse(listOf("第一次", "尝试"), gapMillis = 20, tailGapMillis = 400)
    // 第二次尝试：完整回答。
    server.enqueueSse(listOf("第二", "次", "回答"))
    val pushed = mutableListOf<String>()

    val answer = service.chat(
      profile(timeoutMs = 120), "doc-1", "c1", chatInput, chatCore, emptyList(), "问",
      StreamedTextSink { pushed += it },
    )

    assertEquals(2, server.requests.size)
    assertEquals("第二次回答", answer)
    // 最终推送只含第二次尝试；任何一次推送都不得同时含两次尝试的文本。
    assertEquals("第二次回答", pushed.last())
    assertTrue(pushed.none { it.contains("第一") && it.contains("第二次") }, "pushed contained both attempts: $pushed")
  }

  /** DETAIL_CLICK 优先级：并发 1 时排队的 chat 必须插到更早入队的可见 core 请求之前。 */
  @Test
  fun `chat outranks a queued visible core request when the slot frees up`() = runBlocking {
    val singleSlot = newService(scheduler = RequestScheduler(concurrency = 1))
    val slowSentence = sentence("slow", "Sentence number 1 has words.")
    val laterSentence = sentence("later", "Sentence number 2 has words.")
    // 第一个请求带流式 sink → 走 SSE 路径，流完一整块 core 后再睡 600ms 才发 [DONE]，
    // 以此占住唯一槽位（缓冲路径收到 SSE 正文会判 INVALID 进修复轮，别用）。
    server.enqueueSlowSse(listOf(validCoreRaw("slow")), gapMillis = 0, tailGapMillis = 600)
    server.enqueueJson("排队后的回答")
    server.enqueueJson(validCoreRaw("later"))

    val coreJob = async {
      singleSlot.analyzeCore(profile(), "doc-1", listOf(slowSentence), onStreamedComponent = StreamedComponentSink { _, _ -> })
    }
    while (server.requests.isEmpty()) delay(10)
    // 更早入队的是第二个 core（ACTIVE_VISIBLE_CORE），更晚入队的 chat 必须先出队。
    val laterJob = async { singleSlot.analyzeCore(profile(), "doc-1", listOf(laterSentence)) }
    val chatJob = async {
      singleSlot.chat(profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "问")
    }

    assertEquals(1, coreJob.await().result.size)
    assertEquals("排队后的回答", chatJob.await())
    assertEquals(1, laterJob.await().result.size)

    assertEquals(3, server.requests.size)
    assertFalse(server.requests[1].body.containsKey("response_format"), "chat must run before the queued core")
    assertTrue(server.requests[2].body.containsKey("response_format"), "queued core must run after chat")
  }

  @Test
  fun `chat redacts profile secrets from streamed and final text`() = runBlocking {
    val credentials = MapCredentialStore()
    credentials.put("profile-1", CredentialStore.API_KEY_FIELD, "sk-chat-secret")
    val secretService = newService(credentials = credentials)
    // 密钥跨两个分片：逐片脱敏拦不住，必须对累积全量脱敏。
    server.enqueueSse(listOf("密钥是 sk-chat-", "secret 请保密。"))
    val pushed = mutableListOf<String>()

    val answer = secretService.chat(
      profile(), "doc-1", "c1", chatInput, chatCore, emptyList(), "问",
      StreamedTextSink { pushed += it },
    )

    assertEquals("密钥是 [redacted] 请保密。", answer)
    assertTrue(pushed.isNotEmpty())
    pushed.forEach { text ->
      assertFalse(text.contains("sk-chat-secret"), "streamed text leaked the api key: $text")
    }
    assertEquals("密钥是 [redacted] 请保密。", pushed.last())
  }
}
