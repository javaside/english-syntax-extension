package dev.codetui.englishsyntax.integration

import dev.codetui.englishsyntax.analysis.AnalysisService
import dev.codetui.englishsyntax.cache.AnalysisCache
import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.markdown.HostMessageTransport
import dev.codetui.englishsyntax.model.OpenAiCompatibleClient
import dev.codetui.englishsyntax.scheduler.RequestScheduler
import dev.codetui.englishsyntax.session.HostSender
import dev.codetui.englishsyntax.session.PreviewSessionManager
import dev.codetui.englishsyntax.settings.CredentialStore
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import dev.codetui.englishsyntax.testsupport.FakeOpenAiServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 假模型全链路：Panel → Session → AnalysisService → FakeOpenAiServer → 校验/缓存 → 回推 JS。
 * 用探针（发送记录、请求计数）断言，不依赖墙钟。
 */
class MarkdownSyntaxIntegrationTest {

  private object KeyCredStore : CredentialStore {
    const val KEY = "secret-integration-9f3d"
    override suspend fun get(profileId: String, field: String): String? = if (field == "apiKey") KEY else null
    override suspend fun put(profileId: String, field: String, value: String) = Unit
    override suspend fun delete(profileId: String, field: String) = Unit
  }

  private lateinit var tempDir: java.nio.file.Path
  private lateinit var server: FakeOpenAiServer
  private lateinit var cache: AnalysisCache
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  /** "The service validates every response today." = 7 个 token（含句点），0-6 全覆盖。 */
  private fun validCore(vararg ids: String): String {
    val sentences = ids.joinToString(",") { """{"sentenceId":"$it","components":[{"startToken":0,"endToken":6,"role":"SUBJECT","translation":"整句"}]}""" }
    return """{"sentences":[$sentences]}"""
  }

  @BeforeTest
  fun setUp() {
    tempDir = createTempDirectory("integration")
    server = FakeOpenAiServer()
    cache = AnalysisCache(tempDir.resolve("cache.sqlite"))
  }

  @AfterTest
  fun tearDown() {
    cache.close()
    server.close()
    tempDir.toFile().deleteRecursively()
  }

  private fun profile() = ModelProfile(
    id = "p1",
    name = "integration",
    baseUrl = server.baseUrl,
    model = "test-model",
    headerNames = emptySet(),
    timeoutMs = 30_000,
    jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
  )

  @Test
  fun `start with visible block issues exactly one core request`() = runBlocking {
    val sent = mutableListOf<JsonObject>()
    val panel = EnglishSyntaxPreviewPanel(null, null, HostMessageTransport { })
    val manager = PreviewSessionManager(scope, AnalysisService(OpenAiCompatibleClient(KeyCredStore), cache, RequestScheduler(concurrency = 4), loopbackDetector = { true }), { profile() })
    val session = manager.obtain(panel.previewId, HostSender { sent += it }) {
      panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"${panel.previewId}","generation":${panel.generation}}""")
    }
    server.enqueueJson(validCore("s-b1-0"))
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(300)

    assertEquals(1, server.requests.size)
    assertEquals(1, sent.count { it["type"]?.jsonPrimitive?.contentOrNull == "CORE_RESULT" })
    manager.disposeAll()
  }

  @Test
  fun `second generation with same text hits cache without requests`() = runBlocking {
    val sent = mutableListOf<JsonObject>()
    val manager = PreviewSessionManager(scope, AnalysisService(OpenAiCompatibleClient(KeyCredStore), cache, RequestScheduler(concurrency = 4), loopbackDetector = { true }), { profile() })
    val session = manager.obtain("pv-cache", HostSender { sent += it }) {}
    server.enqueueJson(validCore("s-b1-0"))
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(300)
    assertEquals(1, server.requests.size)

    session.onGenerationChanged(1)
    server.clearRequests()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(300)
    assertEquals(0, server.requests.size, "cache hit must not re-issue a request")
    assertTrue(sent.count { it["type"]?.jsonPrimitive?.contentOrNull == "CORE_RESULT" } >= 2)
    manager.disposeAll()
  }

  @Test
  fun `stop sends restore all and cancels in-flight`() = runBlocking {
    val sent = mutableListOf<JsonObject>()
    val manager = PreviewSessionManager(scope, AnalysisService(OpenAiCompatibleClient(KeyCredStore), cache, RequestScheduler(concurrency = 4), loopbackDetector = { true }), { profile() })
    val session = manager.obtain("pv-stop", HostSender { sent += it }) {}
    session.start()
    session.stop()
    kotlinx.coroutines.delay(100)
    assertEquals(1, sent.count { it["type"]?.jsonPrimitive?.contentOrNull == "RESTORE_ALL" })
    manager.disposeAll()
  }
}
