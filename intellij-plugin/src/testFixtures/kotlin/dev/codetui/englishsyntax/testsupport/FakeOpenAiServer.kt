package dev.codetui.englishsyntax.testsupport

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch

data class RecordedRequest(
  val path: String,
  val headers: Map<String, List<String>>,
  val body: JsonObject,
)

/**
 * 本地假 OpenAI 兼容端点。按队列返回脚本化 JSON / SSE 响应，记录每次请求供探针断言。
 */
class FakeOpenAiServer : AutoCloseable {
  private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
  private val responseQueue = ArrayDeque<QueuedResponse>()
  private val recorded = mutableListOf<RecordedRequest>()
  private val json = Json { prettyPrint = false }
  private val firstRequestLatch = CountDownLatch(1)

  val baseUrl: String

  init {
    server.createContext("/") { exchange ->
      val bodyText = exchange.requestBody.readAllBytes().toString(Charsets.UTF_8)
      val body = try {
        json.parseToJsonElement(bodyText).jsonObject
      } catch (_: Exception) {
        JsonObject(emptyMap())
      }
      synchronized(this) {
        recorded += RecordedRequest(
          path = exchange.requestURI.path,
          headers = exchange.requestHeaders.mapValues { (_, values) -> values.toList() },
          body = body,
        )
      }
      firstRequestLatch.countDown()
      val response = synchronized(this) { responseQueue.removeFirstOrNull() ?: JsonResponse("{}", 500, emptyMap()) }
      response.write(exchange) { clientDisconnected = true }
    }
    server.start()
    baseUrl = "http://127.0.0.1:${server.address.port}/v1"
  }

  val requests: List<RecordedRequest> get() = synchronized(this) { recorded.toList() }

  @Volatile
  var clientDisconnected = false
    private set

  fun awaitFirstRequest() {
    firstRequestLatch.await()
  }

  fun enqueueJson(content: String, status: Int = 200, headers: Map<String, String> = emptyMap()) {
    synchronized(this) { responseQueue.addLast(JsonResponse(content, status, headers)) }
  }

  fun enqueueSse(deltas: List<String>, includeDone: Boolean = true) {
    synchronized(this) { responseQueue.addLast(SseResponse(deltas, includeDone, gapMillis = 0, tailGapMillis = 0)) }
  }

  fun enqueueSlowSse(
    deltas: List<String>,
    gapMillis: Long,
    tailGapMillis: Long = 0,
    includeDone: Boolean = true,
  ) {
    synchronized(this) { responseQueue.addLast(SseResponse(deltas, includeDone, gapMillis, tailGapMillis)) }
  }

  fun clearRequests() {
    synchronized(this) { recorded.clear() }
  }

  override fun close() {
    server.stop(0)
  }

  private sealed interface QueuedResponse {
    fun write(exchange: HttpExchange, onDisconnect: () -> Unit)
  }

  private data class JsonResponse(
    val content: String,
    val status: Int,
    val headers: Map<String, String>,
  ) : QueuedResponse {
    override fun write(exchange: HttpExchange, onDisconnect: () -> Unit) {
      val payload = """{"choices":[{"message":{"content":${jsonString(content)}}}]}"""
      val bytes = payload.toByteArray(Charsets.UTF_8)
      exchange.responseHeaders.add("Content-Type", "application/json")
      headers.forEach { (name, value) -> exchange.responseHeaders.add(name, value) }
      exchange.sendResponseHeaders(status, bytes.size.toLong())
      try {
        exchange.responseBody.use { it.write(bytes) }
      } catch (_: java.io.IOException) {
        onDisconnect()
      }
    }
  }

  private data class SseResponse(
    val deltas: List<String>,
    val includeDone: Boolean,
    val gapMillis: Long,
    val tailGapMillis: Long,
  ) : QueuedResponse {
    override fun write(exchange: HttpExchange, onDisconnect: () -> Unit) {
      exchange.responseHeaders.add("Content-Type", "text/event-stream")
      exchange.sendResponseHeaders(200, 0)
      try {
        exchange.responseBody.use { out ->
          for ((index, delta) in deltas.withIndex()) {
            out.write(sseFrame(delta).toByteArray(Charsets.UTF_8))
            out.flush()
            if (index < deltas.lastIndex && gapMillis > 0) Thread.sleep(gapMillis)
          }
          if (tailGapMillis > 0) Thread.sleep(tailGapMillis)
          if (includeDone) {
            out.write("data: [DONE]\n\n".toByteArray(Charsets.UTF_8))
            out.flush()
          }
        }
      } catch (_: java.io.IOException) {
        onDisconnect()
      }
    }

    private fun sseFrame(delta: String): String =
      "data: " + """{"choices":[{"delta":{"content":${jsonString(delta)}}}]}""" + "\n\n"
  }

  companion object {
    private fun jsonString(value: String): String = Json.encodeToString(value)
  }
}
