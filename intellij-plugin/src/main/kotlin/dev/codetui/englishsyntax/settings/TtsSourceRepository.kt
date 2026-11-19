package dev.codetui.englishsyntax.settings

import dev.codetui.englishsyntax.tts.TtsSourceConfig

/**
 * 云端朗读语音源的持久化:非密钥字段进 [ProfileState](XmlSerializer),
 * apiKey 只进 [CredentialStore](PasswordSafe)——密钥不进明文 XML。
 * 独立于任何模型 profile(spec 2026-11-18:LLM 与 TTS 常不同家)。
 */
class TtsSourceRepository(
  private val profileState: ProfileState = com.intellij.openapi.components.service(),
  private val credentials: CredentialStore = PasswordSafeCredentialStore(),
) {
  /** 惰性读取入口(CloudSpeechSpeaker 的 configReader);未配置时 enabled=false。 */
  suspend fun load(): TtsSourceConfig {
    val state = profileState.state
    return TtsSourceConfig(
      enabled = state.ttsEnabled,
      baseUrl = state.ttsBaseUrl ?: DEFAULT_BASE_URL,
      apiKey = credentials.get(TTS_ID, CredentialStore.API_KEY_FIELD).orEmpty(),
      model = state.ttsModel ?: DEFAULT_MODEL,
      voice = state.ttsVoice ?: DEFAULT_VOICE,
    )
  }

  /**
   * 持久化语音源。[apiKey] 三态:null=保留已存 Key;blank=删除;否则覆写。
   * config.apiKey 恒被忽略——密钥只经 [apiKey] 参数走 PasswordSafe。
   */
  suspend fun save(config: TtsSourceConfig, apiKey: String?) {
    val state = profileState.state
    state.ttsEnabled = config.enabled
    state.ttsBaseUrl = config.baseUrl
    state.ttsModel = config.model
    state.ttsVoice = config.voice
    when {
      apiKey == null -> Unit
      apiKey.isBlank() -> credentials.delete(TTS_ID, CredentialStore.API_KEY_FIELD)
      else -> credentials.put(TTS_ID, CredentialStore.API_KEY_FIELD, apiKey)
    }
  }

  companion object {
    /** PasswordSafe 里的固定条目 id(与 profile 平级、独立命名空间)。 */
    const val TTS_ID = "tts-source"
    const val DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
    const val DEFAULT_MODEL = "FunAudioLLM/CosyVoice2-0.5B"
    const val DEFAULT_VOICE = "anna"
  }
}
