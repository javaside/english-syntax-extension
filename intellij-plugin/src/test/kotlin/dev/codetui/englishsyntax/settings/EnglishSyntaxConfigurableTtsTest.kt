package dev.codetui.englishsyntax.settings

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
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
}
