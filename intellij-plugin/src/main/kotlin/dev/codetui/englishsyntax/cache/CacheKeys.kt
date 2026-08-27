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
  /**
   * 结果的另一半身份：同一句在不同版本的提示词下会得到不同粒度的成分。少了它，改
   * 提示词等于把旧粒度的结果永久钉在缓存里——新旧质量混着显示，谁也说不清屏幕上
   * 那一句是哪版规则的产物。core 传 CORE_PROMPT，详解传 DETAIL_PROMPT：两条提示词
   * 各自演进，不该互相作废。
   */
  val promptVersion: Int,
  val focus: TokenRange? = null,
)

/**
 * 与 Chrome 端 `analysis-cache.ts` 完全一致的缓存键：JSON 数组 UTF-8 编码后取
 * SHA-256 小写十六进制。键不含 profile/模型——同一句英文跨端、跨模型复用。
 *
 * 身份数组形状：
 * - core: ["core", normalizedSentence, schemaVersion, promptVersion, null]
 * - detail: ["core", normalizedSentence, schemaVersion, promptVersion, [startToken, endToken]]
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
      JsonPrimitive(input.promptVersion),
      focus,
    ),
  )
  val encoded = compactJson.encodeToString(JsonArray.serializer(), identity)
  return MessageDigest.getInstance("SHA-256")
    .digest(encoded.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
}

private val compactJson = kotlinx.serialization.json.Json { prettyPrint = false }
