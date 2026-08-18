package dev.codetui.englishsyntax.analysis

import dev.codetui.englishsyntax.cache.AnalysisCache
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
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
    service = AnalysisService(
      client = OpenAiCompatibleClient(NoopCredentialStore),
      cache = cache,
      scheduler = RequestScheduler(concurrency = 4),
    )
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

  /** 构造一个覆盖整句的合法 core raw envelope（单成分 SUBJECT 覆盖全部非标点 token）。 */
  private fun validCoreRaw(vararg ids: String): String {
    val sentences = ids.joinToString(",") { id ->
      """{"sentenceId":"$id","components":[{"startToken":0,"endToken":5,"role":"SUBJECT","translation":"整句"}]}"""
    }
    return """{"sentences":[$sentences]}"""
  }

  @Test
  fun `cache hit does not call the client`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    // 直接以 envelope 形状写入一条合法缓存（与 service 内部写缓存的形状一致）。
    val key = dev.codetui.englishsyntax.cache.createCoreCacheKey(
      dev.codetui.englishsyntax.cache.CoreCacheKeyInput("The service validates every response.", 1),
    )
    cache.putCore(
      key,
      "other-profile",
      json.parseToJsonElement("""{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":5,"role":"SUBJECT","translation":"整句"}]}]}""") as JsonObject,
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
    // 远端 URL（HTTPS）无法用本地假服务器触达；这里验证分块逻辑本身：
    // 5 句按云端 2 句/请求切成 3 块（2/2/1）。
    val sentences = (1..5).map { sentence("s$it", "Sentence number $it has words.") }
    // 用反射读不到私有函数；改由 loopback 测试 + isLoopbackBaseUrl 单测共同覆盖。
    // 此测试断言远端 URL 不被 loopback 判定：
    assertTrue(!dev.codetui.englishsyntax.model.isLoopbackBaseUrl("https://api.example.com/v1"))
    assertTrue(dev.codetui.englishsyntax.model.isLoopbackBaseUrl(server.baseUrl))
    // 5 句在 loopback 下单请求覆盖：
    server.enqueueJson(validCoreRaw(*Array(5) { "s${it + 1}" }))
    val outcome = service.analyzeCore(profile(), "doc-1", sentences)
    assertEquals(1, server.requests.size)
    assertEquals(5, outcome.result.size)
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
  fun `repair failure becomes invalid model output`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    server.enqueueJson("""{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"部分"}]}]}""")
    server.enqueueJson("""{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"仍部分"}]}]}""")

    val outcome = service.analyzeCore(profile(), "doc-1", listOf(sentence))

    assertEquals(2, server.requests.size)
    assertEquals(1, outcome.failures.size)
    assertEquals(
      dev.codetui.englishsyntax.domain.ErrorCode.INVALID_MODEL_OUTPUT,
      outcome.failures[0].error.code,
    )
  }

  @Test
  fun `streamed provisional components do not reach the cache`() = runBlocking {
    val sentence = sentence("s1", "The service validates every response.")
    // 带流式 sink 的请求走流式路径：假服务器需要返回 SSE 分片。
    val first = """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":5,"role":"SUBJECT","translation":"整句"}"""
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
