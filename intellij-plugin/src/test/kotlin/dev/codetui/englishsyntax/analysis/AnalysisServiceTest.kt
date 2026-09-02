package dev.codetui.englishsyntax.analysis

import dev.codetui.englishsyntax.cache.AnalysisCache
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.language.tokenize
import dev.codetui.englishsyntax.model.ChatMessage
import dev.codetui.englishsyntax.model.JsonSchemaSpec
import dev.codetui.englishsyntax.model.OpenAiCompatibleClient
import dev.codetui.englishsyntax.model.StreamedComponent
import dev.codetui.englishsyntax.scheduler.RequestScheduler
import dev.codetui.englishsyntax.settings.CredentialStore
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import dev.codetui.englishsyntax.testsupport.FakeOpenAiServer
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

  private fun newService(loopbackDetector: (String) -> Boolean = { true }) = AnalysisService(
    client = OpenAiCompatibleClient(NoopCredentialStore),
    cache = cache,
    scheduler = RequestScheduler(concurrency = 4),
    loopbackDetector = loopbackDetector,
  )

  private fun profile(baseUrl: String = server.baseUrl) = ModelProfile(
    id = "profile-1",
    name = "Test",
    baseUrl = baseUrl,
    model = "test-model",
    headerNames = emptySet(),
    timeoutMs = 30_000,
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
}
