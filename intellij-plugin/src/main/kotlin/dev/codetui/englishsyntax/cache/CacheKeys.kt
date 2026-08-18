package dev.codetui.englishsyntax.cache

import dev.codetui.englishsyntax.domain.TokenRange
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest

data class CoreCacheKeyInput(
  val normalizedSentence: String,
  val schemaVersion: Int,
  val focus: TokenRange? = null,
)

/**
 * 与 Chrome 端 `analysis-cache.ts` 完全一致的缓存键：JSON 数组 UTF-8 编码后取
 * SHA-256 小写十六进制。键不含 profile/模型——同一句英文跨端、跨模型复用。
 *
 * 身份数组形状：
 * - core: ["core", normalizedSentence, schemaVersion, null]
 * - detail: ["core", normalizedSentence, schemaVersion, [startToken, endToken]]
 */
fun createCoreCacheKey(input: CoreCacheKeyInput): String {
  val focus: JsonElement = input.focus?.let {
    JsonArray(listOf(JsonPrimitive(it.startToken), JsonPrimitive(it.endToken)))
  } ?: JsonNull
  val identity = JsonArray(
    listOf(
      JsonPrimitive("core"),
      JsonPrimitive(input.normalizedSentence),
      JsonPrimitive(input.schemaVersion),
      focus,
    ),
  )
  val encoded = compactJson.encodeToString(JsonArray.serializer(), identity)
  return MessageDigest.getInstance("SHA-256")
    .digest(encoded.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
}

private val compactJson = kotlinx.serialization.json.Json { prettyPrint = false }
