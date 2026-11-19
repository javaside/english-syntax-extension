package dev.codetui.englishsyntax.tts

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import javax.sound.sampled.AudioSystem
import javax.sound.sampled.Clip
import javax.sound.sampled.LineEvent

/**
 * 云端朗读语音源配置（与 Chrome 端 config-repository 的 TtsSourceConfig 同构）。
 * 独立于模型 profile——LLM 与 TTS 常不同家（spec 2026-11-18 对话裁决）。
 */
data class TtsSourceConfig(
  val enabled: Boolean,
  val baseUrl: String,
  val apiKey: String,
  val model: String,
  val voice: String,
)

/**
 * 音频播放 seam：生产实现包 `javax.sound.sampled.Clip`（每次播放新实例——
 * reuse 会截断），测试注入 fake 不真开音频线。
 */
interface ClipFactory {
  fun open(wav: ByteArray): ManagedClip
}

interface ManagedClip {
  fun start()
  fun stop()
  fun close()
}

/** 生产实现：内存 AudioInputStream 直开 Clip（spec 提的「临时文件」路子被替换——内存路零 IO、免「播完删文件」的取消竞态）。 */
object JavaClipFactory : ClipFactory {
  override fun open(wav: ByteArray): ManagedClip {
    val clip = AudioSystem.getClip()
    clip.open(AudioSystem.getAudioInputStream(ByteArrayInputStream(wav)))
    clip.addLineListener { event ->
      // 播完(STOP)即关线:Clip 系统资源有限,泄漏会在多次朗读后拿不到新线。
      if (event.type == LineEvent.Type.STOP) runCatching { clip.close() }
    }
    return object : ManagedClip {
      override fun start() {
        clip.start()
      }

      override fun stop() {
        runCatching { clip.stop() }
      }

      override fun close() {
        runCatching { clip.close() }
      }
    }
  }
}

/**
 * 云端朗读 Speaker（spec 2026-11-18）：
 * - **`speak` 立即返回**（builder check 裁决 3）：调用链在 JBCefJSQuery 泵上，
 *   阻塞会停摆全部桥消息——合成在 [scope] 后台协程执行，慢 OkHttp 无感。
 * - **失败回落 [fallback]**：云端任何失败（网络/鉴权/解码）回落本地系统语音，
 *   双双失败才回调 [onSpeakError]（朗读永远有声是目标 2）。
 * - **配置懒读**（builder check 裁决 4）：[configReader] 是 suspend（PasswordSafe
 *   是 IO），首次 speak 于协程内读取并缓存 5 秒——禁用/未配置直走 fallback，
 *   未配置时行为与 1.7.0 一致；设置改动最迟 5 秒后生效。
 * - **新朗读接管**：speak 先取消旧 job、停旧 Clip 与回落音；stop/shutdown 同款全停。
 */
class CloudSpeechSpeaker(
  private val fallback: SpeechSpeaker,
  private val configReader: suspend () -> TtsSourceConfig?,
  private val fetcher: suspend (TtsSourceConfig, String) -> ByteArray,
  private val onSpeakError: (String) -> Unit,
  private val scope: CoroutineScope,
  private val clipFactory: ClipFactory = JavaClipFactory,
  private val now: () -> Long = System::currentTimeMillis,
) : SpeechSpeaker {
  private val lock = Any()
  private var currentJob: Job? = null
  private var currentClip: ManagedClip? = null
  private var cachedConfig: TtsSourceConfig? = null
  private var cachedAtMs: Long = Long.MIN_VALUE
  private var hasCachedRead = false

  override fun speak(text: String) {
    synchronized(lock) {
      currentJob?.cancel()
      closeCurrentClipLocked()
      runCatching { fallback.stop() }
      currentJob = scope.launch { run(text) }
    }
  }

  override fun stop() {
    synchronized(lock) {
      currentJob?.cancel()
      currentJob = null
      closeCurrentClipLocked()
      runCatching { fallback.stop() }
    }
  }

  /** 全停（会话终止/换代）：与 [stop] 同义,语义上留给生命周期钩子。 */
  override fun shutdown() = stop()

  private suspend fun run(text: String) {
    val config = cachedConfigOrNull()
    val played = config?.enabled == true && runCatching { speakCloud(config, text) }
      .fold(
        onSuccess = { it },
        // CancellationException 已在 speakCloud 内原样透传,这里只会是意外失败。
        onFailure = { false },
      )
    if (!played) {
      speakViaFallback(text)
    }
  }

  private suspend fun speakCloud(config: TtsSourceConfig, text: String): Boolean {
    val wav = try {
      fetcher(config, text)
    } catch (error: kotlinx.coroutines.CancellationException) {
      throw error
    } catch (error: Exception) {
      LOGGER.info("cloud tts fetch failed, falling back: ${error.message}")
      return false
    }
    val clip = try {
      clipFactory.open(wav)
    } catch (error: Exception) {
      LOGGER.info("cloud tts clip open failed, falling back: ${error.message}")
      return false
    }
    synchronized(lock) {
      closeCurrentClipLocked()
      currentClip = clip
    }
    clip.start()
    return true
  }

  private fun speakViaFallback(text: String) {
    try {
      fallback.speak(text)
    } catch (error: Exception) {
      LOGGER.info("local fallback also failed: ${error.message}")
      onSpeakError("朗读失败：${error.message ?: "未知错误"}")
    }
  }

  private fun closeCurrentClipLocked() {
    currentClip?.let { clip ->
      runCatching {
        clip.stop()
        clip.close()
      }
    }
    currentClip = null
  }

  /** 5 秒缓存：窗口内的重复点击不重读 PasswordSafe（EDT 之外的 IO 也有成本）。 */
  private suspend fun cachedConfigOrNull(): TtsSourceConfig? {
    val at = now()
    synchronized(lock) {
      if (hasCachedRead && at - cachedAtMs < CONFIG_CACHE_MS) return cachedConfig
    }
    val value = withContext(kotlinx.coroutines.Dispatchers.IO) { configReader() }
    synchronized(lock) {
      hasCachedRead = true
      cachedAtMs = at
      cachedConfig = value
    }
    return value
  }

  private companion object {
    private val LOGGER = Logger.getInstance(CloudSpeechSpeaker::class.java)
    private const val CONFIG_CACHE_MS = 5_000L
  }
}
