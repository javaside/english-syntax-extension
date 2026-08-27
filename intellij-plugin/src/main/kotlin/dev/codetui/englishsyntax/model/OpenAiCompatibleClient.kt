package dev.codetui.englishsyntax.model

import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.FailureDetail
import dev.codetui.englishsyntax.settings.CapabilityState
import dev.codetui.englishsyntax.settings.CredentialStore
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class ChatMessage(val role: String, val content: String)

data class JsonSchemaSpec(
  val name: String,
  val schema: JsonObject,
  val strict: Boolean = true,
)

interface CapabilityWriter {
  suspend fun markJsonSchemaUnsupported(profileId: String)
  suspend fun markStreamUnsupported(profileId: String)
  suspend fun markReasoningUnsupported(profileId: String)
}

object NoopCapabilityWriter : CapabilityWriter {
  override suspend fun markJsonSchemaUnsupported(profileId: String) = Unit
  override suspend fun markStreamUnsupported(profileId: String) = Unit
  override suspend fun markReasoningUnsupported(profileId: String) = Unit
}

private object UnavailableCredentialStore : CredentialStore {
  override suspend fun get(profileId: String, field: String): String? = null
  override suspend fun put(profileId: String, field: String, value: String) = Unit
  override suspend fun delete(profileId: String, field: String) = Unit
}

fun redactSecrets(text: String, secrets: Collection<String>): String =
  secrets.filter { it.isNotEmpty() }.fold(text) { value, secret -> value.replace(secret, "[redacted]") }

private class UnsupportedResponseFormatException : Exception()
private class UnsupportedStreamException : Exception()
private class UnsupportedReasoningControlException : Exception()
private class SilentTimeoutException : CancellationException("silent timeout")

private val json = Json { prettyPrint = false }

/**
 * OpenAI-compatible Chat Completions 客户端。只调用配置层提供的 URL，负责缓冲/流式、
 * 三种能力降级、错误映射、静默超时和密钥脱敏。领域 JSON 由调用方校验。
 */
class OpenAiCompatibleClient(
  private val credentials: CredentialStore = UnavailableCredentialStore,
  private val capabilityWriter: CapabilityWriter = NoopCapabilityWriter,
  private val httpClient: HttpClient = defaultHttpClient(),
) {
  suspend fun completeJson(
    profile: ModelProfile,
    messages: List<ChatMessage>,
    schema: JsonSchemaSpec,
  ): JsonElement = mapCancellation {
    completeJsonInternal(profile, messages, schema, profile.jsonSchemaSupport != JsonSchemaSupport.UNSUPPORTED)
  }

  suspend fun completeCoreStreaming(
    profile: ModelProfile,
    messages: List<ChatMessage>,
    schema: JsonSchemaSpec,
    onComponent: (StreamedComponent) -> Unit,
  ): JsonElement = mapCancellation {
    streamWithExtractor(profile, messages, schema) {
      val parser = CoreStreamParser()
      fun consume(delta: String) {
        parser.push(delta).forEach(onComponent)
      }
      ::consume
    }
  }

  suspend fun completeDetailStreaming(
    profile: ModelProfile,
    messages: List<ChatMessage>,
    schema: JsonSchemaSpec,
    onStructure: (JsonObject) -> Unit,
  ): JsonElement = mapCancellation {
    streamWithExtractor(profile, messages, schema) {
      val parser = DetailStreamParser()
      fun consume(delta: String) {
        parser.push(delta).forEach(onStructure)
      }
      ::consume
    }
  }

  suspend fun probeJsonCapability(profile: ModelProfile): JsonSchemaSupport = mapCancellation {
    val messages = listOf(
      ChatMessage("system", "Return only the requested JSON object."),
      ChatMessage("user", """Return exactly {"ok":true}."""),
    )
    val schema = JsonSchemaSpec(
      name = "connection_probe",
      strict = true,
      schema = buildJsonObject {
        put("type", "object")
        putJsonArray("required") { add("ok") }
        put("additionalProperties", false)
        put("properties", buildJsonObject {
          put("ok", buildJsonObject { put("const", true) })
        })
      },
    )
    var support = JsonSchemaSupport.SUPPORTED
    val value = try {
      singleJsonRequest(profile, messages, schema, useSchema = true)
    } catch (error: UnsupportedResponseFormatException) {
      support = JsonSchemaSupport.UNSUPPORTED
      capabilityWriter.markJsonSchemaUnsupported(profile.id)
      singleJsonRequest(profile, messages, schema, useSchema = false)
    }
    val objectValue = value as? JsonObject
      ?: throw ExtensionFailure(ErrorCode.INVALID_MODEL_OUTPUT, "Model did not follow the connection probe JSON instruction", false)
    if (objectValue.size != 1 || objectValue["ok"]?.jsonPrimitive?.content != "true") {
      throw ExtensionFailure(ErrorCode.INVALID_MODEL_OUTPUT, "Model did not follow the connection probe JSON instruction", false)
    }
    support
  }

  /** 单发、不做任何降级的原始缓冲请求；连接探测需要自己观察拒绝异常。 */
  private suspend fun singleJsonRequest(
    profile: ModelProfile,
    messages: List<ChatMessage>,
    schema: JsonSchemaSpec,
    useSchema: Boolean,
  ): JsonElement {
    val body = requestBody(profile, messages, schema, stream = false, useSchema = useSchema)
    val text = bufferedRequest(profile, body, useSchema)
    return parseEnvelopeContent(text)
  }

  private suspend fun completeJsonInternal(
    profile: ModelProfile,
    messages: List<ChatMessage>,
    schema: JsonSchemaSpec,
    useSchema: Boolean,
  ): JsonElement {
    var current = profile
    var schemaOn = useSchema
    while (true) {
      try {
        val body = requestBody(current, messages, schema, stream = false, useSchema = schemaOn)
        val text = bufferedRequest(current, body, schemaOn)
        return parseEnvelopeContent(text)
      } catch (error: UnsupportedResponseFormatException) {
        if (!schemaOn) throw error
        capabilityWriter.markJsonSchemaUnsupported(current.id)
        schemaOn = false
      } catch (error: UnsupportedReasoningControlException) {
        capabilityWriter.markReasoningUnsupported(current.id)
        current = current.copy(reasoningControl = CapabilityState.UNSUPPORTED)
      }
    }
  }

  private suspend fun streamWithExtractor(
    profile: ModelProfile,
    messages: List<ChatMessage>,
    schema: JsonSchemaSpec,
    createExtractor: () -> (String) -> Unit,
  ): JsonElement {
    if (profile.streamSupport == CapabilityState.UNSUPPORTED) {
      return completeJsonInternal(profile, messages, schema, profile.jsonSchemaSupport != JsonSchemaSupport.UNSUPPORTED)
    }
    var current = profile
    var schemaOn = current.jsonSchemaSupport != JsonSchemaSupport.UNSUPPORTED
    while (true) {
      try {
        val body = requestBody(current, messages, schema, stream = true, useSchema = schemaOn)
        return streamRequest(current, body, schemaOn, createExtractor())
      } catch (error: UnsupportedResponseFormatException) {
        if (!schemaOn) throw error
        capabilityWriter.markJsonSchemaUnsupported(current.id)
        schemaOn = false
      } catch (error: UnsupportedStreamException) {
        capabilityWriter.markStreamUnsupported(current.id)
        current = current.copy(streamSupport = CapabilityState.UNSUPPORTED)
        return completeJsonInternal(current, messages, schema, schemaOn)
      } catch (error: UnsupportedReasoningControlException) {
        capabilityWriter.markReasoningUnsupported(current.id)
        current = current.copy(reasoningControl = CapabilityState.UNSUPPORTED)
      }
    }
  }

  private fun requestBody(
    profile: ModelProfile,
    messages: List<ChatMessage>,
    schema: JsonSchemaSpec,
    stream: Boolean,
    useSchema: Boolean,
  ): JsonObject = buildJsonObject {
    put("model", profile.model)
    putJsonArray("messages") {
      messages.forEach { message ->
        add(buildJsonObject {
          put("role", message.role)
          put("content", message.content)
        })
      }
    }
    put("temperature", 0)
    put("stream", stream)
    if (profile.reasoningControl != CapabilityState.UNSUPPORTED) put("reasoning_effort", "none")
    if (useSchema) {
      put("response_format", buildJsonObject {
        put("type", "json_schema")
        put("json_schema", buildJsonObject {
          put("name", schema.name)
          put("strict", schema.strict)
          put("schema", schema.schema)
        })
      })
    }
  }

  private suspend fun bufferedRequest(profile: ModelProfile, body: JsonObject, useSchema: Boolean): String {
    val request = httpRequest(profile, body)
    val response = try {
      withTimeout(profile.timeoutMs.toLong()) {
        httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString()).awaitCancellable()
      }
    } catch (_: TimeoutCancellationException) {
      throw ExtensionFailure(ErrorCode.REQUEST_TIMEOUT, "Model request timed out", true)
    } catch (error: Exception) {
      if (error is CancellationException) throw error
      throw ExtensionFailure(ErrorCode.NETWORK_ERROR, error.message ?: "Model network request failed", true)
    }
    val text = response.body()
    if (response.statusCode() !in 200..299) {
      val validationRejection = response.statusCode() == 400 || response.statusCode() == 422
      if (useSchema && validationRejection && Regex("response[_ ]?format|json[_ ]?schema", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
        throw UnsupportedResponseFormatException()
      }
      if (profile.reasoningControl != CapabilityState.UNSUPPORTED &&
        validationRejection && Regex("reasoning[_ ]?effort", RegexOption.IGNORE_CASE).containsMatchIn(text)
      ) {
        throw UnsupportedReasoningControlException()
      }
      throw mapHttpError(response, text, secretsFor(profile))
    }
    return text
  }

  private suspend fun streamRequest(
    profile: ModelProfile,
    body: JsonObject,
    useSchema: Boolean,
    consume: (String) -> Unit,
  ): JsonElement {
    val request = httpRequest(profile, body)
    val response = try {
      withTimeout(profile.timeoutMs.toLong()) {
        httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream()).awaitCancellable()
      }
    } catch (_: TimeoutCancellationException) {
      throw ExtensionFailure(ErrorCode.REQUEST_TIMEOUT, "Model request timed out", true)
    } catch (error: Exception) {
      if (error is CancellationException) throw error
      throw ExtensionFailure(ErrorCode.NETWORK_ERROR, error.message ?: "Model network request failed", true)
    }
    val input = response.body()
    if (response.statusCode() !in 200..299) {
      val text = try {
        input.readAllBytes().toString(Charsets.UTF_8)
      } finally {
        runCatching { input.close() }
      }
      val validationRejection = response.statusCode() == 400 || response.statusCode() == 422
      if (useSchema && validationRejection && Regex("response[_ ]?format|json[_ ]?schema", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
        throw UnsupportedResponseFormatException()
      }
      if (validationRejection && Regex("stream", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
        throw UnsupportedStreamException()
      }
      if (profile.reasoningControl != CapabilityState.UNSUPPORTED &&
        validationRejection && Regex("reasoning[_ ]?effort", RegexOption.IGNORE_CASE).containsMatchIn(text)
      ) {
        throw UnsupportedReasoningControlException()
      }
      throw mapHttpError(response, text, secretsFor(profile))
    }

    val lastActivityNanos = AtomicLong(System.nanoTime())
    val content = try {
      coroutineScope {
        val readJob = async(Dispatchers.IO) {
          val decoder = SseDecoder()
          val content = StringBuilder()
          var finished = false
          val buffer = ByteArray(8192)
          while (!finished) {
            val read = try {
              runInterruptible(Dispatchers.IO) { input.read(buffer) }
            } catch (error: Exception) {
              // 取消/超时会中断阻塞的 read；JDK 把 InterruptedException 包成 IOException，
              // 这里把中断恢复成协程取消语义，让 cancel cause 正确传播。
              coroutineContext.ensureActive()
              throw error
            }
            if (read == -1) break
            if (read > 0) {
              lastActivityNanos.set(System.nanoTime())
              val chunk = String(buffer, 0, read, Charsets.UTF_8)
              for (payload in decoder.push(chunk)) {
                if (payload == SSE_DONE) {
                  finished = true
                  break
                }
                val delta = deltaContent(payload) ?: continue
                content.append(delta)
                consume(delta)
              }
            }
          }
          content.toString()
        }
        val watchdog = launch {
          while (isActive) {
            delay(profile.timeoutMs.toLong())
            if (System.nanoTime() - lastActivityNanos.get() > profile.timeoutMs * 1_000_000L) {
              readJob.cancel(SilentTimeoutException())
            }
          }
        }
        try {
          readJob.await()
        } finally {
          watchdog.cancel()
        }
      }
    } catch (_: SilentTimeoutException) {
      throw ExtensionFailure(ErrorCode.REQUEST_TIMEOUT, "Model request timed out", true)
    } catch (error: Exception) {
      if (error is CancellationException) throw error
      throw ExtensionFailure(ErrorCode.NETWORK_ERROR, error.message ?: "Model stream failed", true)
    } finally {
      runCatching { input.close() }
    }

    if (content.isEmpty()) throw UnsupportedStreamException()
    return parseContent(content)
  }

  private suspend fun httpRequest(profile: ModelProfile, body: JsonObject): HttpRequest {
    val apiKey = credentials.get(profile.id, CredentialStore.API_KEY_FIELD).orEmpty()
    return HttpRequest.newBuilder(URI(chatCompletionsUrl(profile.baseUrl)))
      .header("Content-Type", "application/json")
      .header("Authorization", "Bearer $apiKey")
      .apply {
        for (name in profile.headerNames.sorted()) {
          credentials.get(profile.id, "header:$name")?.let { header(name, it) }
        }
      }
      .POST(HttpRequest.BodyPublishers.ofString(json.encodeToString(JsonObject.serializer(), body)))
      .build()
  }

  private suspend fun secretsFor(profile: ModelProfile): List<String> {
    val secrets = mutableListOf(credentials.get(profile.id, CredentialStore.API_KEY_FIELD).orEmpty())
    for (name in profile.headerNames) {
      credentials.get(profile.id, "header:$name")?.let(secrets::add)
    }
    return secrets
  }

  private fun mapHttpError(response: HttpResponse<*>, rawBody: String, secrets: List<String>): ExtensionFailure {
    val body = redactSecrets(rawBody, secrets)
    val message = body.trim().ifEmpty { "Model endpoint returned HTTP ${response.statusCode()}" }
    val status = response.statusCode()
    val retryAfter = response.headers().firstValue("Retry-After").orElse(null)
    return when {
      status == 401 || status == 403 ->
        ExtensionFailure(ErrorCode.AUTH_FAILED, message, false, mapOf("status" to FailureDetail.NumberValue(status)))
      status == 404 || (status == 400 && Regex("model[\\s\\S]{0,40}?(?:not exist|not found)", RegexOption.IGNORE_CASE).containsMatchIn(body)) ->
        ExtensionFailure(ErrorCode.MODEL_NOT_FOUND, message, false, mapOf("status" to FailureDetail.NumberValue(status)))
      status == 429 -> {
        val details = mutableMapOf<String, FailureDetail>("status" to FailureDetail.NumberValue(status))
        retryAfterMilliseconds(retryAfter)?.let { details["retryAfterMs"] = FailureDetail.NumberValue(it) }
        ExtensionFailure(ErrorCode.RATE_LIMITED, message, true, details)
      }
      else -> ExtensionFailure(ErrorCode.NETWORK_ERROR, message, status >= 500, mapOf("status" to FailureDetail.NumberValue(status)))
    }
  }

  private suspend fun <T> mapCancellation(block: suspend () -> T): T {
    return try {
      block()
    } catch (_: SilentTimeoutException) {
      throw ExtensionFailure(ErrorCode.REQUEST_TIMEOUT, "Model request timed out", true)
    } catch (_: TimeoutCancellationException) {
      throw ExtensionFailure(ErrorCode.REQUEST_TIMEOUT, "Model request timed out", true)
    } catch (_: CancellationException) {
      throw ExtensionFailure(ErrorCode.REQUEST_CANCELLED, "Model request was cancelled", false)
    }
  }

  companion object {
    fun defaultHttpClient(): HttpClient = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(30))
      .build()
  }
}

private fun deltaContent(payload: String): String? {
  return try {
    val chunk = json.parseToJsonElement(payload).jsonObject
    val content = chunk["choices"]?.jsonArray?.firstOrNull()?.jsonObject?.get("delta")?.jsonObject?.get("content")
    content?.jsonPrimitive?.takeIf { it.isString && it.content.isNotEmpty() }?.content
  } catch (_: Exception) {
    null
  }
}

private fun stripSingleJsonFence(content: String): String {
  val trimmed = content.trim()
  val match = Regex("^```json[\\t ]*\\r?\\n([\\s\\S]*?)\\r?\\n```$", RegexOption.IGNORE_CASE).find(trimmed)
  return match?.groupValues?.get(1) ?: trimmed
}

private fun parseEnvelopeContent(text: String): JsonElement {
  val envelope = try {
    json.parseToJsonElement(text).jsonObject
  } catch (_: Exception) {
    throw ExtensionFailure(ErrorCode.INVALID_MODEL_OUTPUT, "Model response envelope is not valid JSON", false)
  }
  val content = envelope["choices"]?.jsonArray?.firstOrNull()?.jsonObject?.get("message")?.jsonObject?.get("content")
  val string = content?.jsonPrimitive?.takeIf { it.isString }?.content
    ?: throw ExtensionFailure(ErrorCode.INVALID_MODEL_OUTPUT, "Model response is missing choices[0].message.content", false)
  return parseContent(string)
}

/**
 * 解析模型吐出来的 JSON 正文。少吐收尾括号、或撞上 max_tokens 断在半句上是常态,
 * 此时先按截断救一遍(见 [repairTruncatedJson]):救回来的对象若缺字段，由上层逐句校验
 * 判无效并进修复轮——那远好过整块判死。
 */
private fun parseContent(content: String): JsonElement {
  val text = stripSingleJsonFence(content)
  return try {
    json.parseToJsonElement(text)
  } catch (_: Exception) {
    val salvaged = repairTruncatedJson(text)
      ?: throw ExtensionFailure(ErrorCode.INVALID_MODEL_OUTPUT, "Model message content is not valid JSON", false)
    json.parseToJsonElement(salvaged)
  }
}

private fun retryAfterMilliseconds(value: String?): Long? {
  if (value == null) return null
  val seconds = value.toLongOrNull()
  if (seconds != null && seconds >= 0) return seconds * 1_000
  return try {
    val epoch = ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
    maxOf(0, epoch - System.currentTimeMillis())
  } catch (_: Exception) {
    null
  }
}

private suspend fun <T> CompletableFuture<T>.awaitCancellable(): T =
  suspendCancellableCoroutine { continuation ->
    whenComplete { value, error ->
      if (error != null) continuation.resumeWithException(error)
      else continuation.resume(value as T)
    }
    continuation.invokeOnCancellation { cancel(true) }
  }
