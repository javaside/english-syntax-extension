package dev.codetui.englishsyntax.settings

import kotlinx.coroutines.runBlocking
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 「朗读语音源」设置节:表单回填(含密钥,IDEA 沿用 profile 回显现状)与
 * applyForm 持久化——密钥经 PasswordSafe、其余进 ProfileState。
 */
class EnglishSyntaxConfigurableTtsTest {

  private class FakeCredentialStore : CredentialStore {
    val values = mutableMapOf<Pair<String, String>, String>()

    override suspend fun get(profileId: String, field: String): String? = values[profileId to field]

    override suspend fun put(profileId: String, field: String, value: String) {
      values[profileId to field] = value
    }

    override suspend fun delete(profileId: String, field: String) {
      values.remove(profileId to field)
    }
  }

  private fun configurable(
    state: ProfileState = ProfileState(),
    credentials: FakeCredentialStore = FakeCredentialStore(),
  ): EnglishSyntaxConfigurable = EnglishSyntaxConfigurable(
    repository = ProfileRepository(state, credentials),
    profileState = state,
    ttsRepository = TtsSourceRepository(state, credentials),
    // applyForm 的 F6 后台块与 F5 激活刷新都走默认 service(),测试环境无 Application。
    background = EnglishSyntaxConfigurable.BackgroundDispatcher { it() },
    profileRefresh = EnglishSyntaxConfigurable.ProfileRefresh { },
    pauseControl = object : EnglishSyntaxConfigurable.PauseControl {
      override suspend fun releaseIfFingerprintChanged(profileId: String) = false
      override fun release(profileId: String) = Unit
    },
  )

  @Test
  fun `resetForm reflects the stored tts source`() = runBlocking {
    val state = ProfileState()
    state.state.ttsEnabled = true
    state.state.ttsBaseUrl = "https://api.example.com/v1"
    state.state.ttsModel = "speaker-model"
    state.state.ttsVoice = "david"
    val credentials = FakeCredentialStore()
    credentials.values["tts-source" to "api-key"] = "sk-echoed"

    val configurable = configurable(state, credentials)
    configurable.resetForm()

    assertEquals(true, configurable.form.ttsEnabled)
    assertEquals("https://api.example.com/v1", configurable.form.ttsBaseUrl)
    assertEquals("speaker-model", configurable.form.ttsModel)
    assertEquals("david", configurable.form.ttsVoice)
    assertEquals("sk-echoed", configurable.form.ttsApiKey)
  }

  @Test
  fun `applyForm persists the tts source with the key in the credential store`() = runBlocking {
    val state = ProfileState()
    val credentials = FakeCredentialStore()
    val configurable = configurable(state, credentials)

    configurable.form.id = "profile-1"
    configurable.form.name = "Example"
    configurable.form.baseUrl = "https://api.example.com/v1"
    configurable.form.model = "example-model"
    configurable.form.ttsEnabled = true
    configurable.form.ttsBaseUrl = "https://api.siliconflow.cn/v1"
    configurable.form.ttsModel = "FunAudioLLM/CosyVoice2-0.5B"
    configurable.form.ttsVoice = "benjamin"
    configurable.form.ttsApiKey = "sk-tts-new"
    configurable.applyForm()

    assertEquals(true, state.state.ttsEnabled)
    assertEquals("https://api.siliconflow.cn/v1", state.state.ttsBaseUrl)
    assertEquals("benjamin", state.state.ttsVoice)
    assertEquals("sk-tts-new", credentials.values["tts-source" to "api-key"])
    assertTrue(configurable.isFormModified().not() || configurable.form.ttsApiKey.isNotEmpty())
  }

  @Test
  fun `settings OK-Apply is wired to persist (apply overrides BoundConfigurable)`() {
    // super.apply() 依赖平台 UI 设施,单测直接调会撞 Alarm——这里钉接线存在,
    // 持久化正确性由 applyForm 的用例覆盖(apply = super.apply() + applyForm)。
    val method = EnglishSyntaxConfigurable::class.java.getMethod("apply")
    assertEquals(EnglishSyntaxConfigurable::class.java, method.declaringClass)
    val isModified = EnglishSyntaxConfigurable::class.java.getMethod("isModified")
    assertEquals(EnglishSyntaxConfigurable::class.java, isModified.declaringClass)
  }

  @Test
  fun `test speech gives immediate in-page feedback before the balloon`() {
    val dispatcher = mutableListOf<() -> Unit>()
    val configurable = EnglishSyntaxConfigurable(
      repository = ProfileRepository(ProfileState(), FakeCredentialStore()),
      profileState = ProfileState(),
      ttsRepository = TtsSourceRepository(ProfileState(), FakeCredentialStore()),
      background = EnglishSyntaxConfigurable.BackgroundDispatcher { dispatcher += it },
      profileRefresh = EnglishSyntaxConfigurable.ProfileRefresh { },
      pauseControl = object : EnglishSyntaxConfigurable.PauseControl {
        override suspend fun releaseIfFingerprintChanged(profileId: String) = false
        override fun release(profileId: String) = Unit
      },
      transferUi = BalloonUi(),
      ttsTester = { _, _ -> throw java.io.IOException("offline") },
    )
    configurable.form.ttsEnabled = true
    configurable.form.ttsApiKey = "sk-filled"

    assertTrue(configurable.runTtsTestAction())
    // 派发后台块之前,页面状态行立即有反应(不依赖 balloon/通知中心)。
    assertTrue(configurable.actionStatus.contains("正在"), configurable.actionStatus)

    dispatcher.single().invoke()
    assertTrue(configurable.actionStatus.contains("语音源"), configurable.actionStatus)
  }

  @Test
  fun `blank tts api key deletes the stored credential`() = runBlocking {
    val state = ProfileState()
    val credentials = FakeCredentialStore()
    credentials.values["tts-source" to "api-key"] = "sk-old"
    val configurable = configurable(state, credentials)

    configurable.form.id = "profile-1"
    configurable.form.name = "Example"
    configurable.form.baseUrl = "https://api.example.com/v1"
    configurable.form.model = "example-model"
    configurable.form.ttsApiKey = ""
    configurable.applyForm()

    assertTrue("tts-source" to "api-key" !in credentials.values)
  }

  // 不用「class 实现 suspend 函数类型」——该构造会卡死 Kotlin 编译器,这里以 lambda 捕获等价实现。
  private fun recordingTester(): Pair<suspend (dev.codetui.englishsyntax.tts.TtsSourceConfig, String) -> ByteArray, MutableList<Pair<dev.codetui.englishsyntax.tts.TtsSourceConfig, String>>> {
    val calls = mutableListOf<Pair<dev.codetui.englishsyntax.tts.TtsSourceConfig, String>>()
    val tester: suspend (dev.codetui.englishsyntax.tts.TtsSourceConfig, String) -> ByteArray = { config, text ->
      calls += config to text
      byteArrayOf(1, 2)
    }
    return tester to calls
  }

  private class BalloonUi : EnglishSyntaxConfigurable.CacheTransferUi {
    val balloons = mutableListOf<Pair<String, Boolean>>()

    override fun chooseExportFile(): Path? = null

    override fun chooseImportFile(): Path? = null

    override fun balloon(text: String, error: Boolean) {
      balloons += text to error
    }
  }

  @Test
  fun `tts test button synthesizes a short sample off the caller thread and balloons the result`() = runBlocking {
    val (tester, calls) = recordingTester()
    val ui = BalloonUi()
    val dispatcher = mutableListOf<() -> Unit>()
    val configurable = EnglishSyntaxConfigurable(
      repository = ProfileRepository(ProfileState(), FakeCredentialStore()),
      profileState = ProfileState(),
      ttsRepository = TtsSourceRepository(ProfileState(), FakeCredentialStore()),
      background = EnglishSyntaxConfigurable.BackgroundDispatcher { dispatcher += it },
      profileRefresh = EnglishSyntaxConfigurable.ProfileRefresh { },
      pauseControl = object : EnglishSyntaxConfigurable.PauseControl {
        override suspend fun releaseIfFingerprintChanged(profileId: String) = false
        override fun release(profileId: String) = Unit
      },
      transferUi = ui,
      ttsTester = tester,
    )
    configurable.form.ttsEnabled = true
    configurable.form.ttsBaseUrl = "https://api.example.com/v1"
    configurable.form.ttsModel = "speaker-model"
    configurable.form.ttsVoice = "david"
    configurable.form.ttsApiKey = "sk-tts"

    assertTrue(configurable.runTtsTestAction())
    // EDT 上只允许派发:合成与 balloon 都在后台块里。
    assertEquals(0, calls.size)
    assertEquals(0, ui.balloons.size)

    dispatcher.single().invoke()

    assertEquals(1, calls.size)
    val (config, text) = calls.single()
    assertEquals("https://api.example.com/v1", config.baseUrl)
    assertEquals("speaker-model", config.model)
    assertEquals("david", config.voice)
    assertEquals("sk-tts", config.apiKey)
    assertTrue(text.length in 1..10, "测试合成应是短样本文本: '$text'")
    val (message, error) = ui.balloons.single()
    assertFalse(error)
    assertTrue(message.contains("语音源可用"), message)
  }

  @Test
  fun `tts test failure balloons a warning`() {
    val ui = BalloonUi()
    val dispatcher = mutableListOf<() -> Unit>()
    val configurable = EnglishSyntaxConfigurable(
      repository = ProfileRepository(ProfileState(), FakeCredentialStore()),
      profileState = ProfileState(),
      ttsRepository = TtsSourceRepository(ProfileState(), FakeCredentialStore()),
      background = EnglishSyntaxConfigurable.BackgroundDispatcher { dispatcher += it },
      profileRefresh = EnglishSyntaxConfigurable.ProfileRefresh { },
      pauseControl = object : EnglishSyntaxConfigurable.PauseControl {
        override suspend fun releaseIfFingerprintChanged(profileId: String) = false
        override fun release(profileId: String) = Unit
      },
      transferUi = ui,
      ttsTester = { _, _ -> throw java.io.IOException("connection refused") },
    )
    configurable.form.ttsEnabled = true
    configurable.form.ttsApiKey = "sk-filled"

    assertTrue(configurable.runTtsTestAction())
    dispatcher.single().invoke()

    val (message, error) = ui.balloons.single()
    assertTrue(error, message)
    assertTrue(message.contains("语音源不可用"), message)
  }
}
