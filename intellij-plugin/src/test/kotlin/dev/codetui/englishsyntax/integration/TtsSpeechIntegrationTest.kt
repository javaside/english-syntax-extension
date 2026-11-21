package dev.codetui.englishsyntax.integration

import com.sun.net.httpserver.HttpServer
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.session.HostSender
import dev.codetui.englishsyntax.session.PreviewSessionManager
import dev.codetui.englishsyntax.settings.CredentialStore
import dev.codetui.englishsyntax.settings.ProfileState
import dev.codetui.englishsyntax.settings.TtsSourceRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 朗读全链路：JS 桥 TTS_SPEAK → PreviewSessionManager(生产装配) → CloudSpeechSpeaker
 * → 真 HttpTtsFetcher → 本地假硅基流动。除配置仓库(内存件)外零打桩——
 * 「点喇叭到底走不走云端」由这条链一锤定音。
 */
class TtsSpeechIntegrationTest {

  private class InMemoryCredentials : CredentialStore {
    val values = mutableMapOf<Pair<String, String>, String>()
    override suspend fun get(profileId: String, field: String): String? = values[profileId to field]
    override suspend fun put(profileId: String, field: String, value: String) {
      values[profileId to field] = value
    }
    override suspend fun delete(profileId: String, field: String) {
      values.remove(profileId to field)
    }
  }

  private object NoopAnalysis : AnalysisServicePort {
    override suspend fun analyzeCore(
      profile: dev.codetui.englishsyntax.settings.ModelProfile,
      documentId: String,
      sentences: List<dev.codetui.englishsyntax.domain.SentenceInput>,
      priority: dev.codetui.englishsyntax.scheduler.SchedulerPriority,
      bypassCache: Boolean,
      onStreamedComponent: dev.codetui.englishsyntax.analysis.StreamedComponentSink?,
    ): dev.codetui.englishsyntax.analysis.CoreBatchOutcome = throw NotImplementedError()

    override suspend fun lookupCore(
      sentences: List<dev.codetui.englishsyntax.domain.SentenceInput>,
    ): List<dev.codetui.englishsyntax.domain.CoreAnalysis> = emptyList()

    override suspend fun analyzeDetail(
      profile: dev.codetui.englishsyntax.settings.ModelProfile,
      documentId: String,
      sentence: dev.codetui.englishsyntax.domain.SentenceInput,
      core: dev.codetui.englishsyntax.domain.CoreAnalysis,
      focus: dev.codetui.englishsyntax.domain.TokenRange,
      onStreamedStructure: dev.codetui.englishsyntax.analysis.StreamedStructureSink?,
    ): dev.codetui.englishsyntax.analysis.DetailOutcome = throw NotImplementedError()

    override suspend fun lookupDetail(
      sentence: dev.codetui.englishsyntax.domain.SentenceInput,
      focus: dev.codetui.englishsyntax.domain.TokenRange,
    ): dev.codetui.englishsyntax.domain.DetailAnalysis? = null

    override suspend fun chat(
      profile: dev.codetui.englishsyntax.settings.ModelProfile,
      documentId: String,
      conversationId: String,
      input: dev.codetui.englishsyntax.domain.SentenceInput,
      core: dev.codetui.englishsyntax.domain.CoreAnalysis,
      history: List<dev.codetui.englishsyntax.model.ChatTurn>,
      question: String,
      onStreamedText: dev.codetui.englishsyntax.analysis.StreamedTextSink?,
    ): String = throw NotImplementedError()

    override suspend fun analyzeWithFeedback(
      profile: dev.codetui.englishsyntax.settings.ModelProfile,
      documentId: String,
      sentence: dev.codetui.englishsyntax.domain.SentenceInput,
      core: dev.codetui.englishsyntax.domain.CoreAnalysis,
      feedback: String,
    ): dev.codetui.englishsyntax.domain.CoreAnalysis = throw NotImplementedError()

    override suspend fun cancelDocument(documentId: String) = Unit
  }

  private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
  private val authorizations = mutableListOf<String?>()

  init {
    server.createContext("/") { exchange ->
      synchronized(authorizations) {
        authorizations += exchange.requestHeaders.getFirst("Authorization")
      }
      val payload = ByteArray(64)
      exchange.sendResponseHeaders(200, payload.size.toLong())
      exchange.responseBody.use { it.write(payload) }
      exchange.close()
    }
    server.start()
  }

  @AfterTest
  fun tearDown() {
    server.stop(0)
    scope.cancel()
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val sent = mutableListOf<String>()
  private val sender = HostSender { json ->
    synchronized(sent) { sent += json.toString() }
  }

  private fun managerWith(state: ProfileState, credentials: InMemoryCredentials): PreviewSessionManager =
    PreviewSessionManager(
      scope = scope,
      analysis = NoopAnalysis,
      profileProvider = { null },
      ttsRepository = TtsSourceRepository(state, credentials),
    )

  @Test
  fun `保存的云端配置驱动真实合成——点喇叭打到假硅基流动`() = runBlocking {
    val state = ProfileState()
    val credentials = InMemoryCredentials()
    val repository = TtsSourceRepository(state, credentials)
    // 用户保存路径(生产 save):enabled + Key。
    repository.save(
      dev.codetui.englishsyntax.tts.TtsSourceConfig(
        enabled = true,
        baseUrl = "http://127.0.0.1:${server.address.port}/v1",
        apiKey = "sk-integration",
        model = "FunAudioLLM/CosyVoice2-0.5B",
        voice = "anna",
      ),
      apiKey = "sk-integration",
    )

    val manager = managerWith(state, credentials)
    val session = manager.obtain("pv-tts", sender) { }

    // JS 桥真实入口:页面点喇叭 → TTS_SPEAK。
    session.launchTts("s-1", "The cloud pipeline must speak.")

    val deadline = System.currentTimeMillis() + 8_000
    while (synchronized(authorizations) { authorizations.isEmpty() } && System.currentTimeMillis() < deadline) {
      Thread.sleep(20)
    }
    val hits = synchronized(authorizations) { authorizations.toList() }
    assertTrue(hits.isNotEmpty(), "合成请求未发生——朗读没走云端(生产装配断链)")
    assertTrue(hits.single()?.contains("sk-integration") == true, "Authorization=$hits")
  }

  @Test
  fun `未配置时不发合成请求——静默本地不打扰`() = runBlocking {
    val manager = managerWith(ProfileState(), InMemoryCredentials())
    val session = manager.obtain("pv-local", sender) { }

    session.launchTts("s-1", "local voice please")

    Thread.sleep(600)
    assertEquals(emptyList<String?>(), synchronized(authorizations) { authorizations.toList() })
  }
}
