package dev.codetui.englishsyntax.tts

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * 生产 fetcher 的请求形态契约:OpenAI 兼容 /v1/audio/speech、
 * voice 带模型前缀、response_format=wav、Authorization 头在场。
 */
class HttpTtsFetcherTest {

  private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
  private data class Hit(val path: String, val body: String, val authorization: String?)

  private val recorded = mutableListOf<Hit>()
  private var status = 200

  init {
    server.createContext("/") { exchange ->
      val body = exchange.requestBody.readBytes().decodeToString()
      synchronized(recorded) {
        recorded += Hit(exchange.requestURI.path, body, exchange.requestHeaders.getFirst("Authorization"))
      }
      // 裸 PCM(官方 pcm 格式):fetcher 负责包 wav 头。
      val payload = ByteArray(128) { (it % 251).toByte() }
      exchange.sendResponseHeaders(status, payload.size.toLong())
      exchange.responseBody.use { it.write(payload) }
      exchange.close()
    }
    server.start()
  }

  @AfterTest
  fun stop() {
    server.stop(0)
  }

  private val config = TtsSourceConfig(
    enabled = true,
    baseUrl = "http://127.0.0.1:${server.address.port}/v1",
    apiKey = "sk-tts-secret",
    model = "FunAudioLLM/CosyVoice2-0.5B",
    voice = "anna",
  )

  @Test
  fun `posts the OpenAI-compatible speech shape and returns the wav bytes`() = runBlocking {
    val wav = HttpTtsFetcher(config, "hello world")

    // 输出必须是自己包了合法 RIFF 头的 wav(javax.sound 对流式 wav 的
    // 异常长度字段会抛 Audio data < 0,Chrome 却能播——真机根因)。
    assertEquals("RIFF", wav.copyOfRange(0, 4).decodeToString())
    assertEquals("WAVE", wav.copyOfRange(8, 12).decodeToString())
    // PCM 16bit mono 44100:fmt 块的音频格式=1、声道=1、采样率=44100。
    assertEquals(1, ((wav[20].toInt() and 0xFF) or ((wav[21].toInt() and 0xFF) shl 8)))
    assertEquals(1, ((wav[22].toInt() and 0xFF) or ((wav[23].toInt() and 0xFF) shl 8)))
    val sampleRate = (wav[24].toInt() and 0xFF) or ((wav[25].toInt() and 0xFF) shl 8) or
      ((wav[26].toInt() and 0xFF) shl 16) or ((wav[27].toInt() and 0xFF) shl 24)
    assertEquals(44100, sampleRate)
    val dataSize = (wav[40].toInt() and 0xFF) or ((wav[41].toInt() and 0xFF) shl 8) or
      ((wav[42].toInt() and 0xFF) shl 16) or ((wav[43].toInt() and 0xFF) shl 24)
    assertEquals(128, dataSize)
    assertEquals(44 + 128, wav.size)
    val hit = synchronized(recorded) { recorded.single() }
    assertEquals("/v1/audio/speech", hit.path)
    assertEquals("Bearer sk-tts-secret", hit.authorization)
    assertTrue(hit.body.contains("\"model\":\"FunAudioLLM/CosyVoice2-0.5B\""), hit.body)
    assertTrue(hit.body.contains("\"voice\":\"FunAudioLLM/CosyVoice2-0.5B:anna\""), hit.body)
    assertTrue(hit.body.contains("\"input\":\"hello world\""), hit.body)
    assertTrue(hit.body.contains("\"response_format\":\"pcm\""), hit.body)
    assertTrue(hit.body.contains("\"sample_rate\":44100"), hit.body)
  }

  @Test
  fun `trims whitespace around the pasted api key`(): Unit = runBlocking {
    val dirty = config.copy(apiKey = "sk-tts-secret \n")
    val wav = HttpTtsFetcher(dirty, "hello")
    assertEquals("RIFF", wav.copyOfRange(0, 4).decodeToString())
    val hit = synchronized(recorded) { recorded.last() }
    assertEquals("Bearer sk-tts-secret", hit.authorization)
    Unit
  }

  @Test
  fun `fails loudly on http errors`(): Unit = runBlocking {
    status = 401
    val error = assertFailsWith<Exception> { HttpTtsFetcher(config, "hi") }
    assertTrue(error.message!!.contains("401"), error.message)
    Unit
  }
}
