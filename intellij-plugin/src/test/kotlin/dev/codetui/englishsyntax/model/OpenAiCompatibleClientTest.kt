package dev.codetui.englishsyntax.model

import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.FailureDetail
import dev.codetui.englishsyntax.settings.CapabilityState
import dev.codetui.englishsyntax.settings.CredentialStore
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import dev.codetui.englishsyntax.testsupport.FakeOpenAiServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class OpenAiCompatibleClientTest {
  private class FakeCredentialStore : CredentialStore {
    private val values = mutableMapOf<Pair<String, String>, String>()

    override suspend fun get(profileId: String, field: String): String? = values[profileId to field]
    override suspend fun put(profileId: String, field: String, value: String) {
      values[profileId to field] = value
    }

    override suspend fun delete(profileId: String, field: String) {
      values.remove(profileId to field)
    }
  }

  private class FakeCapabilityWriter : CapabilityWriter {
    var jsonSchema = 0
    var stream = 0
    var reasoning = 0

    override suspend fun markJsonSchemaUnsupported(profileId: String) {
      jsonSchema += 1
    }

    override suspend fun markStreamUnsupported(profileId: String) {
      stream += 1
    }

    override suspend fun markReasoningUnsupported(profileId: String) {
      reasoning += 1
    }
  }

  private val credentials = FakeCredentialStore()
  private val writer = FakeCapabilityWriter()
  private val schema = JsonSchemaSpec("core_analysis", buildJsonObject { put("type", "object") })
  private val messages = listOf(ChatMessage("user", "Analyze."))
  private val json = Json { prettyPrint = false }

  private fun profile(baseUrl: String, timeoutMs: Int = 30_000) = ModelProfile(
    id = "profile-1",
    name = "Test",
    baseUrl = baseUrl,
    model = "test-model",
    headerNames = emptySet(),
    timeoutMs = timeoutMs,
    jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
  )

  private fun client() = OpenAiCompatibleClient(credentials, writer)

  private fun bodyField(server: FakeOpenAiServer, index: Int, field: String): String? =
    server.requests[index].body[field]?.jsonPrimitive?.contentOrNull

  @Test
  fun `buffered request sends schema reasoning none and authorization`() = runBlocking {
    FakeOpenAiServer().use { server ->
      credentials.put("profile-1", CredentialStore.API_KEY_FIELD, "test-key")
      server.enqueueJson("""{"ok":true}""")

      val result = client().completeJson(profile(server.baseUrl), messages, schema)

      assertEquals("""{"ok":true}""", json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), result))
      assertEquals(1, server.requests.size)
      assertFalse(server.requests[0].body["stream"]?.jsonPrimitive?.booleanOrNull ?: true)
      assertEquals("none", bodyField(server, 0, "reasoning_effort"))
      assertNotNull(server.requests[0].body["response_format"])
      assertEquals("Bearer test-key", server.requests[0].headers["Authorization"]?.firstOrNull())
    }
  }

  @Test
  fun `401 maps to non retryable auth failure`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueJson("unauthorized", status = 401)
      val error = runCatching { client().completeJson(profile(server.baseUrl), messages, schema) }
        .exceptionOrNull() as ExtensionFailure
      assertEquals(ErrorCode.AUTH_FAILED, error.code)
      assertFalse(error.retryable)
    }
  }

  @Test
  fun `429 parses Retry After seconds`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueJson("rate limited", status = 429, headers = mapOf("Retry-After" to "2"))
      val error = runCatching { client().completeJson(profile(server.baseUrl), messages, schema) }
        .exceptionOrNull() as ExtensionFailure
      assertEquals(ErrorCode.RATE_LIMITED, error.code)
      assertTrue(error.retryable)
      assertEquals(2000L, (error.details["retryAfterMs"] as FailureDetail.NumberValue).value)
    }
  }

  @Test
  fun `400 model not exist maps to model not found`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueJson("Model Not Exist", status = 400)
      val error = runCatching { client().completeJson(profile(server.baseUrl), messages, schema) }
        .exceptionOrNull() as ExtensionFailure
      assertEquals(ErrorCode.MODEL_NOT_FOUND, error.code)
    }
  }

  @Test
  fun `schema rejection persists negative state and retries without response format`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueJson("response_format not supported", status = 400)
      server.enqueueJson("""{"ok":true}""")
      client().completeJson(profile(server.baseUrl), messages, schema)
      assertEquals(2, server.requests.size)
      assertNull(server.requests[1].body["response_format"])
      assertEquals(1, writer.jsonSchema)
    }
  }

  @Test
  fun `reasoning rejection persists negative state and retries without field`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueJson("reasoning_effort not supported", status = 422)
      server.enqueueJson("""{"ok":true}""")
      client().completeJson(profile(server.baseUrl), messages, schema)
      assertEquals(2, server.requests.size)
      assertNull(server.requests[1].body["reasoning_effort"])
      assertEquals(1, writer.reasoning)
    }
  }

  @Test
  fun `stream rejection persists negative state and falls back to buffered request`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueJson("stream not supported", status = 400)
      server.enqueueJson("""{"ok":true}""")
      client().completeCoreStreaming(profile(server.baseUrl), messages, schema) {}
      assertEquals(2, server.requests.size)
      assertTrue(server.requests[0].body["stream"]?.jsonPrimitive?.booleanOrNull ?: false)
      assertFalse(server.requests[1].body["stream"]?.jsonPrimitive?.booleanOrNull ?: true)
      assertEquals(1, writer.stream)
    }
  }

  @Test
  fun `empty stream falls back once`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueSse(emptyList(), includeDone = true)
      server.enqueueJson("""{"ok":true}""")
      val result = client().completeCoreStreaming(profile(server.baseUrl), messages, schema) {}
      assertEquals(2, server.requests.size)
      assertEquals(1, writer.stream)
      assertEquals("""{"ok":true}""", json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), result))
    }
  }

  @Test
  fun `stream silent timeout resets after each data chunk`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueSlowSse(
        listOf(
          """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":0,"role":"SUBJECT","translation":"它"}""",
          """,{"startToken":1,"endToken":1,"role":"PREDICATE","translation":"工作"}""",
          "]}]}",
        ),
        gapMillis = 20,
        tailGapMillis = 200,
        includeDone = true,
      )
      var components = 0
      val error = runCatching {
        client().completeCoreStreaming(profile(server.baseUrl, timeoutMs = 50), messages, schema) {
          components += 1
        }
      }.exceptionOrNull() as ExtensionFailure
      assertEquals(ErrorCode.REQUEST_TIMEOUT, error.code)
      assertEquals(2, components)
    }
  }

  @Test
  fun `caller cancellation interrupts body reading`() = runBlocking {
    FakeOpenAiServer().use { server ->
      server.enqueueSlowSse(
        listOf(
          """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":0,"role":"SUBJECT","translation":"它"}]}""",
          "]}",
        ),
        gapMillis = 1_500,
      )
      val componentSeen = CompletableFuture<Void>()
      val errorSeen = CompletableFuture<Throwable>()
      val job = Job()
      val scope = CoroutineScope(Dispatchers.Default + job)
      scope.launch {
        try {
          client().completeCoreStreaming(profile(server.baseUrl, timeoutMs = 60_000), messages, schema) {
            componentSeen.complete(null)
          }
        } catch (error: Throwable) {
          errorSeen.complete(error)
        }
      }
      componentSeen.get(5, TimeUnit.SECONDS)
      job.cancel()
      val error = errorSeen.get(5, TimeUnit.SECONDS)
      assertTrue(error is ExtensionFailure)
      assertEquals(ErrorCode.REQUEST_CANCELLED, (error as ExtensionFailure).code)
    }
  }

  @Test
  fun `provider error never leaks api key in exception message`() = runBlocking {
    FakeOpenAiServer().use { server ->
      credentials.put("profile-1", CredentialStore.API_KEY_FIELD, "secret-integration-key")
      server.enqueueJson("error secret-integration-key", status = 500)
      val error = runCatching { client().completeJson(profile(server.baseUrl), messages, schema) }
        .exceptionOrNull() as ExtensionFailure
      assertEquals(ErrorCode.NETWORK_ERROR, error.code)
      assertTrue(error.message.contains("[redacted]"))
      assertFalse(error.message.contains("secret-integration-key"))
      assertFalse(error.details.toString().contains("secret-integration-key"))
    }
  }
}
