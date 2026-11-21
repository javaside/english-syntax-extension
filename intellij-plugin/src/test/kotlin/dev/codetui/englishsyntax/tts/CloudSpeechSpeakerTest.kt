package dev.codetui.englishsyntax.tts

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private class RecordingSpeaker : SpeechSpeaker {
  val spoken = mutableListOf<String>()
  var stops = 0
  var failOnSpeak = false

  override fun speak(text: String) {
    if (failOnSpeak) throw SpeechUnavailableException("平台语音命令不可用")
    spoken += text
  }

  override fun stop() {
    stops += 1
  }

  override fun shutdown() = stop()
}

private class FakeClip : ManagedClip {
  var starts = 0
  var stops = 0
  var closed = false

  override fun start() {
    starts += 1
  }

  override fun stop() {
    stops += 1
  }

  override fun close() {
    closed = true
  }
}

private class FakeClipFactory : ClipFactory {
  val clips = mutableListOf<FakeClip>()

  override fun open(wav: ByteArray): ManagedClip = FakeClip().also { clips += it }
}

class CloudSpeechSpeakerTest {
  private val config = TtsSourceConfig(
    enabled = true,
    baseUrl = "https://api.siliconflow.cn/v1",
    apiKey = "sk-tts",
    model = "FunAudioLLM/CosyVoice2-0.5B",
    voice = "anna",
  )

  private fun speaker(
    fallback: RecordingSpeaker = RecordingSpeaker(),
    configProvider: suspend () -> TtsSourceConfig? = { config },
    fetcher: suspend (TtsSourceConfig, String) -> ByteArray = { _, _ -> byteArrayOf(1, 2, 3) },
    errors: MutableList<String> = mutableListOf(),
    notices: MutableList<String> = mutableListOf(),
    clipFactory: ClipFactory = FakeClipFactory(),
    scope: CoroutineScope,
    now: () -> Long = { 0L },
  ): CloudSpeechSpeaker = CloudSpeechSpeaker(
    fallback = fallback,
    configReader = configProvider,
    fetcher = fetcher,
    onSpeakError = { message -> errors += message },
    onFallbackNotice = { reason -> notices += reason },
    scope = scope,
    clipFactory = clipFactory,
    now = now,
  )

  @Test
  fun `cloud playback fires onCloudPlayback once (source indicator)`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val played = java.util.concurrent.atomic.AtomicInteger(0)
    val subject = CloudSpeechSpeaker(
      fallback = RecordingSpeaker(),
      configReader = { config },
      fetcher = { _, _ -> byteArrayOf(1) },
      onSpeakError = { },
      scope = scope,
      clipFactory = FakeClipFactory(),
      onCloudPlayback = { played.incrementAndGet() },
    )
    subject.speak("hello")
    runBlocking { awaitUntil { played.get() == 1 } }
    scope.cancel()
  }

  @Test
  fun `speak returns immediately while the fetch is slow and plays the clip when it lands`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val clips = FakeClipFactory()
    val subject = speaker(
      clipFactory = clips,
      fetcher = { _, _ ->
        delay(300)
        byteArrayOf(9)
      },
      scope = scope,
    )
    try {
      val startedAt = System.nanoTime()
      subject.speak("hello world")
      val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
      assertTrue(elapsedMs < 100, "speak 必须即返(桥泵不能被阻塞),实测 ${elapsedMs}ms")

      runBlocking { withTimeoutAtLeastOneStart(clips) }
      assertEquals(1, clips.clips.size)
      assertEquals(1, clips.clips[0].starts)
    } finally {
      scope.cancel()
    }
  }

  @Test
  fun `null or disabled config speaks via the local fallback without any fetch`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val fallback = RecordingSpeaker()
    var fetchCalls = 0
    val subject = speaker(
      fallback = fallback,
      configProvider = { null },
      fetcher = { _, _ ->
        fetchCalls += 1
        byteArrayOf(1)
      },
      scope = scope,
    )
    subject.speak("first")
    runBlocking { awaitUntil { fallback.spoken == listOf("first") } }
    val disabled = speaker(
      fallback = fallback,
      configProvider = { config.copy(enabled = false) },
      fetcher = { _, _ ->
        fetchCalls += 1
        byteArrayOf(1)
      },
      scope = scope,
    )
    disabled.speak("second")
    runBlocking { awaitUntil { fallback.spoken.size == 2 } }

    assertEquals(listOf("first", "second"), fallback.spoken)
    assertEquals(0, fetchCalls)
    scope.cancel()
  }

  @Test
  fun `cloud failure notifies onFallbackNotice once (visible feedback, not silent local)`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val fallback = RecordingSpeaker()
    val notices = mutableListOf<String>()
    val subject = speaker(
      fallback = fallback,
      notices = notices,
      fetcher = { _, _ -> throw java.io.IOException("HTTP 401") },
      scope = scope,
    )
    subject.speak("hello")
    runBlocking { awaitUntil { fallback.spoken == listOf("hello") } }
    assertEquals(listOf("HTTP 401"), notices)
    scope.cancel()
  }

  @Test
  fun `config read failure surfaces through the notice channel (was deepest silent pit)`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val fallback = RecordingSpeaker()
    val notices = mutableListOf<String>()
    val subject = speaker(
      fallback = fallback,
      notices = notices,
      configProvider = { throw IllegalStateException("service unavailable") },
      scope = scope,
    )
    subject.speak("hello")
    runBlocking { awaitUntil { fallback.spoken.isNotEmpty() } }
    assertEquals(1, notices.size)
    assertTrue(notices.single().contains("配置读取失败"), notices.single())
    scope.cancel()
  }

  @Test
  fun `disabled config stays silent on the notice channel (no harassment)`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val fallback = RecordingSpeaker()
    val notices = mutableListOf<String>()
    val subject = speaker(
      fallback = fallback,
      notices = notices,
      configProvider = { config.copy(enabled = false) },
      scope = scope,
    )
    subject.speak("hello")
    runBlocking { awaitUntil { fallback.spoken == listOf("hello") } }
    assertEquals(emptyList<String>(), notices)
    scope.cancel()
  }

  @Test
  fun `fetch failure falls back locally and does not report onSpeakError`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val fallback = RecordingSpeaker()
    val errors = mutableListOf<String>()
    val subject = speaker(
      fallback = fallback,
      errors = errors,
      fetcher = { _, _ -> throw java.io.IOException("connection reset") },
      scope = scope,
    )
    subject.speak("hello")

    runBlocking { awaitUntil { fallback.spoken == listOf("hello") } }
    assertTrue(errors.isEmpty(), "回落成功就不该报错: $errors")
    scope.cancel()
  }

  @Test
  fun `both cloud and local failing reports onSpeakError once`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val fallback = RecordingSpeaker().apply { failOnSpeak = true }
    val errors = mutableListOf<String>()
    val subject = speaker(
      fallback = fallback,
      errors = errors,
      fetcher = { _, _ -> throw java.io.IOException("offline") },
      scope = scope,
    )
    subject.speak("hello")

    runBlocking { awaitUntil { errors.size == 1 } }
    assertTrue(errors[0].contains("朗读失败"))
    scope.cancel()
  }

  @Test
  fun `config reader failure falls back locally instead of dying silently`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val fallback = RecordingSpeaker()
    val subject = speaker(
      fallback = fallback,
      configProvider = { throw java.io.IOException("password safe unavailable") },
      scope = scope,
    )
    subject.speak("hello")

    runBlocking { awaitUntil { fallback.spoken == listOf("hello") } }
    scope.cancel()
  }

  @Test
  fun `stop cancels the in-flight fetch and nothing plays`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val clips = FakeClipFactory()
    val fallback = RecordingSpeaker()
    val fetchStarted = java.util.concurrent.atomic.AtomicBoolean(false)
    val fetchCancelled = java.util.concurrent.atomic.AtomicBoolean(false)
    val subject = speaker(
      fallback = fallback,
      clipFactory = clips,
      fetcher = { _, _ ->
        fetchStarted.set(true)
        try {
          delay(5_000)
          byteArrayOf(1)
        } catch (error: kotlinx.coroutines.CancellationException) {
          fetchCancelled.set(true)
          throw error
        }
      },
      scope = scope,
    )
    subject.speak("slow sentence")
    // 等 fetch 真的在途再停(否则 cancel 抢在 fetcher 启动前,测的不是同一件事)。
    val deadline = System.currentTimeMillis() + 5_000
    while (!fetchStarted.get() && System.currentTimeMillis() < deadline) Thread.sleep(10)
    assertTrue(fetchStarted.get(), "fetch 应已启动")

    subject.stop()

    Thread.sleep(200)
    assertEquals(0, clips.clips.size, "在途请求被取消,不应有任何 clip")
    assertTrue(fetchCancelled.get(), "fetch 协程应被取消")
    // 红线:被取消的朗读绝不能回落本地出声(取消≠失败)。
    assertEquals(0, fallback.spoken.size, "取消不得触发本地回落: ${fallback.spoken}")
    scope.cancel()
  }

  @Test
  fun `stop during clip open suppresses playback and the fallback`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val clips = object : ClipFactory {
      val opened = java.util.concurrent.atomic.AtomicInteger(0)

      override fun open(wav: ByteArray): ManagedClip {
        opened.incrementAndGet()
        Thread.sleep(300) // fetch 已返回,停顿落在 open 与 start 之间
        return FakeClip().also { clipsList += it }
      }

      val clipsList = mutableListOf<FakeClip>()
    }
    val fallback = RecordingSpeaker()
    val subject = speaker(
      fallback = fallback,
      clipFactory = clips,
      scope = scope,
    )
    subject.speak("race sentence")
    // 等 fetch 返回并进入 open 阻塞,再停。
    val deadline = System.currentTimeMillis() + 5_000
    while (clips.opened.get() == 0 && System.currentTimeMillis() < deadline) Thread.sleep(10)
    subject.stop()
    Thread.sleep(500)

    assertEquals(0, clips.clipsList.count { it.starts > 0 }, "停止后到达的音频不得播放")
    assertEquals(0, fallback.spoken.size, "竞态取消不得触发本地回落: ${fallback.spoken}")
    scope.cancel()
  }

  @Test
  fun `a new speak takes over the pending job and only the new clip plays`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val clips = FakeClipFactory()
    val subject = speaker(
      clipFactory = clips,
      fetcher = { _, text ->
        if (text == "slow") delay(300)
        byteArrayOf(text.length.toByte())
      },
      scope = scope,
    )
    subject.speak("slow")
    subject.speak("fast")

    runBlocking { awaitUntil { clips.clips.size == 1 } }
    Thread.sleep(400)
    assertEquals(1, clips.clips.size, "被接管的慢请求不得晚到播放")
    assertEquals(1, clips.clips[0].starts)
    scope.cancel()
  }

  @Test
  fun `config is read at most once per five-second window`() {
    val scope = CoroutineScope(Dispatchers.Default + Job())
    val fallback = RecordingSpeaker()
    var reads = 0
    var clock = 0L
    val subject = speaker(
      fallback = fallback,
      configProvider = {
        reads += 1
        null
      },
      scope = scope,
      now = { clock },
    )
    subject.speak("one")
    runBlocking { awaitUntil { fallback.spoken == listOf("one") } }
    subject.speak("two")
    runBlocking { awaitUntil { fallback.spoken == listOf("one", "two") } }
    assertEquals(1, reads, "5 秒窗口内配置只读一次(PasswordSafe 是 IO,别每次点击都读)")

    clock = 5_001
    subject.speak("three")
    runBlocking { awaitUntil { fallback.spoken.size == 3 } }
    assertEquals(2, reads, "窗口过期后要重读,设置改动在 5 秒后生效")
    scope.cancel()
  }
}

/** 等待条件为真(有界轮询),供协程外断言异步路径。 */
internal suspend fun awaitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
  val deadline = System.currentTimeMillis() + timeoutMs
  while (!condition()) {
    if (System.currentTimeMillis() > deadline) throw AssertionError("await 条件超时")
    delay(20)
  }
}

private suspend fun withTimeoutAtLeastOneStart(clips: FakeClipFactory) {
  awaitUntil { clips.clips.isNotEmpty() && clips.clips[0].starts > 0 }
}
