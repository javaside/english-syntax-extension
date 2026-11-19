package dev.codetui.englishsyntax.settings

import dev.codetui.englishsyntax.tts.TtsSourceConfig
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 云端朗读语音源持久化:非密钥字段进 ProfileState(XmlSerializer),
 * apiKey 只进 PasswordSafe——密钥不进明文 XML(SecretIsolationTest 同款红线)。
 */
class TtsSourceRepositoryTest {

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

  private fun repository(state: ProfileState = ProfileState(), credentials: FakeCredentialStore = FakeCredentialStore()) =
    TtsSourceRepository(state, credentials)

  private val config = TtsSourceConfig(
    enabled = true,
    baseUrl = "https://api.siliconflow.cn/v1",
    apiKey = "ignored-at-persistence",
    model = "FunAudioLLM/CosyVoice2-0.5B",
    voice = "benjamin",
  )

  @Test
  fun `save persists fields to state and the key to the credential store, load round-trips`() = runBlocking {
    val state = ProfileState()
    val credentials = FakeCredentialStore()
    val repository = TtsSourceRepository(state, credentials)

    repository.save(config, apiKey = "sk-tts-secret")

    assertEquals(true, state.state.ttsEnabled)
    assertEquals("https://api.siliconflow.cn/v1", state.state.ttsBaseUrl)
    assertEquals("FunAudioLLM/CosyVoice2-0.5B", state.state.ttsModel)
    assertEquals("benjamin", state.state.ttsVoice)
    // 密钥只出现在 PasswordSafe 侧(独立于任何 profile id)。
    assertEquals("sk-tts-secret", credentials.values["tts-source" to "api-key"])

    val loaded = repository.load()
    assertEquals(
      TtsSourceConfig(
        enabled = true,
        baseUrl = "https://api.siliconflow.cn/v1",
        apiKey = "sk-tts-secret",
        model = "FunAudioLLM/CosyVoice2-0.5B",
        voice = "benjamin",
      ),
      loaded,
    )
  }

  @Test
  fun `secret never lands in the serialized state`() = runBlocking {
    val state = ProfileState()
    val credentials = FakeCredentialStore()
    val repository = TtsSourceRepository(state, credentials)

    repository.save(config, apiKey = "sk-tts-secret")

    // BaseState 的全部字符串属性都不许含密钥——XmlSerializer 序列化的就是它们。
    val serialized = buildString {
      state.state.javaClass.declaredFields.forEach { field ->
        field.isAccessible = true
        append(field.get(state.state)?.toString()).append('\n')
      }
    }
    assertFalse(serialized.contains("sk-tts-secret"), "密钥泄漏进持久化状态: $serialized")
  }

  @Test
  fun `null apiKey keeps the stored key, blank deletes it`() = runBlocking {
    val credentials = FakeCredentialStore()
    val repository = TtsSourceRepository(ProfileState(), credentials)
    repository.save(config, apiKey = "sk-keep")

    repository.save(config.copy(enabled = false), apiKey = null)
    assertEquals("sk-keep", repository.load().apiKey)

    repository.save(config, apiKey = "  ")
    assertEquals("", repository.load().apiKey)
    assertTrue("tts-source" to "api-key" !in credentials.values)
  }

  @Test
  fun `fresh install loads disabled defaults`() = runBlocking {
    val loaded = repository().load()
    assertFalse(loaded.enabled)
    assertEquals("https://api.siliconflow.cn/v1", loaded.baseUrl)
    assertEquals("FunAudioLLM/CosyVoice2-0.5B", loaded.model)
    assertEquals("anna", loaded.voice)
    assertEquals("", loaded.apiKey)
  }
}
