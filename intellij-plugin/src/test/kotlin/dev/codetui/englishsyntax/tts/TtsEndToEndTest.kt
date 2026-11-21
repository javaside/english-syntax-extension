package dev.codetui.englishsyntax.tts

import com.sun.net.httpserver.HttpServer
import dev.codetui.englishsyntax.settings.CredentialStore
import dev.codetui.englishsyntax.settings.EnglishSyntaxConfigurable
import dev.codetui.englishsyntax.settings.ProfileRepository
import dev.codetui.englishsyntax.settings.ProfileState
import dev.codetui.englishsyntax.settings.TtsSourceRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 端到端验收:复刻生产链路「设置页保存 → 朗读时读取 → 真实 HTTP 合成」,
 * 除 fallback/通知外零打桩——Test speech 通而朗读不通这类断链,只有把
 * 生产装配原样串起来才能暴露。
 */
class TtsEndToEndTest {

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

  private class RecordingFallback : SpeechSpeaker {
    val spoken = mutableListOf<String>()
    override fun speak(text: String) {
      spoken += text
    }
    override fun stop() = Unit
    override fun shutdown() = Unit
  }

  private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
  private val hits = mutableListOf<String?>()

  init {
    server.createContext("/") { exchange ->
      synchronized(hits) {
        hits += exchange.requestHeaders.getFirst("Authorization")
      }
      val payload = ByteArray(64)
      exchange.sendResponseHeaders(200, payload.size.toLong())
      exchange.responseBody.use { it.write(payload) }
      exchange.close()
    }
    server.start()
  }

  @AfterTest
  fun stop() {
    server.stop(0)
  }

  @Test
  fun `保存的配置驱动真实 HTTP 合成(生产装配端到端)`() = runBlocking {
    val state = ProfileState()
    val credentials = InMemoryCredentials()
    val repository = TtsSourceRepository(state, credentials)
    val configurable = EnglishSyntaxConfigurable(
      repository = ProfileRepository(state, credentials),
      profileState = state,
      ttsRepository = repository,
      background = EnglishSyntaxConfigurable.BackgroundDispatcher { it() },
      profileRefresh = EnglishSyntaxConfigurable.ProfileRefresh { },
      pauseControl = object : EnglishSyntaxConfigurable.PauseControl {
        override suspend fun releaseIfFingerprintChanged(profileId: String) = false
        override fun release(profileId: String) = Unit
      },
    )

    // ① 用户在设置页填表并保存(生产保存路径)。
    configurable.resetForm()
    configurable.form.ttsEnabled = true
    configurable.form.ttsBaseUrl = "http://127.0.0.1:${server.address.port}/v1"
    configurable.form.ttsModel = "FunAudioLLM/CosyVoice2-0.5B"
    configurable.form.ttsVoice = "anna"
    configurable.form.ttsApiKey = "sk-e2e-secret"
    // profile 表单刻意留空(name 空→校验必炸):tts 保存绝不许被连坐。
    val profileFailure = runCatching { configurable.applyForm() }.exceptionOrNull()
    assertTrue(profileFailure is IllegalArgumentException, "预期 profile 校验失败: $profileFailure")

    // ② profile 炸了,tts 仍然完整落库(PasswordSafe 侧)——核心断言。
    assertEquals("sk-e2e-secret", credentials.values["tts-source" to "api-key"])
    assertEquals(true, state.state.ttsEnabled)

    // ③ 生产朗读装配:与 PreviewSession.effectiveSpeaker 同款读取与 fetcher。
    val fallback = RecordingFallback()
    val notices = mutableListOf<String>()
    val speaker = CloudSpeechSpeaker(
      fallback = fallback,
      configReader = { repository.load() },
      fetcher = { config, text -> HttpTtsFetcher(config, text) },
      onSpeakError = { },
      scope = CoroutineScope(Dispatchers.Default + Job()),
      onFallbackNotice = { reason -> notices += reason },
    )
    speaker.speak("hello end to end")

    // ④ 真实 HTTP 合成发生了(带保存的 Key),且没有回落。
    val deadline = System.currentTimeMillis() + 8_000
    while (synchronized(hits) { hits.isEmpty() } && System.currentTimeMillis() < deadline) {
      Thread.sleep(20)
    }
    val authorizations = synchronized(hits) { hits.toList() }
    assertTrue(authorizations.isNotEmpty(), "云端合成请求未发生——链路断在朗读侧;回落记录: ${fallback.spoken};通知: $notices")
    assertTrue(authorizations.single()?.contains("sk-e2e-secret") == true, "Authorization=$authorizations")
    assertEquals(emptyList<String>(), notices, "不应回落: $notices")
    assertTrue(fallback.spoken.isEmpty(), "不应回落到本地: ${fallback.spoken}")
  }
}
