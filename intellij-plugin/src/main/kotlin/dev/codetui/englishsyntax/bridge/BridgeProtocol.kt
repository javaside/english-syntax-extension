package dev.codetui.englishsyntax.bridge

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

/** JS → Kotlin 的封闭消息集合。 */
sealed interface PageMessage {
  val previewId: String
  val generation: Int

  data class PreviewReady(
    override val previewId: String,
    override val generation: Int,
  ) : PageMessage

  data class VisibleBlocks(
    override val previewId: String,
    override val generation: Int,
    val blocks: List<BlockText>,
  ) : PageMessage {
    data class BlockText(val blockId: String, val text: String)
  }

  data class DetailRequest(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val focusStart: Int,
    val focusEnd: Int,
  ) : PageMessage

  data class RetrySentence(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
  ) : PageMessage
}

/** Kotlin → JS 的封闭消息集合。 */
sealed interface HostMessage {
  val previewId: String
  val generation: Int

  data class SessionState(
    override val previewId: String,
    override val generation: Int,
    val state: String,
    val ready: Int,
    val discovered: Int,
  ) : HostMessage

  data class CoreStream(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val componentsJson: String,
  ) : HostMessage

  data class CoreResult(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val analysisJson: String,
  ) : HostMessage

  data class CoreError(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val code: String,
    val message: String,
  ) : HostMessage

  data class DetailStream(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val structuresJson: String,
  ) : HostMessage

  data class DetailResult(
    override val previewId: String,
    override val generation: Int,
    val sentenceId: String,
    val analysisJson: String,
  ) : HostMessage

  data class RestoreAll(
    override val previewId: String,
    override val generation: Int,
  ) : HostMessage
}

/**
 * JCEF 被视为不可信来源：每条消息按类型做键白名单 + 字段守卫，
 * 任何多余键、非法值、越界数量都拒绝（返回 null），未知 JSON 绝不透传。
 */
object BridgeProtocol {
  const val VERSION = 1
  const val MAX_BLOCKS = 50
  const val MAX_BLOCK_TEXT = 20_000

  private val forbiddenKeys = setOf("apiKey", "headers", "baseUrl")

  fun parsePageMessage(value: JsonObject): PageMessage? {
    // 公共键先做类型级白名单之外的提取；每类型的具体键白名单在各自分支里校验。
    if (value.int("version") != VERSION) return null
    val previewId = value.string("previewId")?.takeIf { it.isNotEmpty() } ?: return null
    val generation = value.int("generation") ?: return null
    if (generation < 0) return null
    if (value.keys.any { it in forbiddenKeys }) return null

    return when (value.string("type")) {
      "PREVIEW_READY" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation")) return null
        PageMessage.PreviewReady(previewId, generation)
      }

      "VISIBLE_BLOCKS" -> parseVisibleBlocks(value, previewId, generation)

      "DETAIL_REQUEST" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "focus")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        val focus = value["focus"] as? JsonObject ?: return null
        if (!hasOnlyKeys(focus, "startToken", "endToken")) return null
        val start = focus.int("startToken") ?: return null
        val end = focus.int("endToken") ?: return null
        if (start < 0 || end < start) return null
        PageMessage.DetailRequest(previewId, generation, sentenceId, start, end)
      }

      "RETRY_SENTENCE" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        PageMessage.RetrySentence(previewId, generation, sentenceId)
      }

      else -> null
    }
  }

  private fun parseVisibleBlocks(value: JsonObject, previewId: String, generation: Int): PageMessage.VisibleBlocks? {
    if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "blocks")) return null
    val blocks = value["blocks"] as? JsonArray ?: return null
    if (blocks.size > MAX_BLOCKS) return null
    val parsed = blocks.map { block ->
      val blockObject = block as? JsonObject ?: return null
      if (!hasOnlyKeys(blockObject, "blockId", "text")) return null
      val blockId = blockObject.string("blockId")?.takeIf { it.isNotEmpty() } ?: return null
      val text = blockObject.string("text") ?: return null
      if (text.length > MAX_BLOCK_TEXT) return null
      PageMessage.VisibleBlocks.BlockText(blockId, text)
    }
    return PageMessage.VisibleBlocks(previewId, generation, parsed)
  }

  /** Kotlin → JS 侧同样守卫：host 消息也可能被篡改后回注，generation 必须非负。 */
  fun parseHostMessage(value: JsonObject): HostMessage? {
    val previewId = value.string("previewId")?.takeIf { it.isNotEmpty() } ?: return null
    val generation = value.int("generation") ?: return null
    if (generation < 0) return null
    return when (value.string("type")) {
      "SESSION_STATE" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "state", "ready", "discovered")) return null
        HostMessage.SessionState(
          previewId, generation,
          value.string("state") ?: return null,
          value.int("ready") ?: return null,
          value.int("discovered") ?: return null,
        )
      }
      "CORE_STREAM", "CORE_RESULT", "DETAIL_RESULT" -> {
        val sentenceKey = if (value.keys.contains("analysisJson")) "analysisJson" else null
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", sentenceKey ?: "componentsJson")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        val payload = value.string(sentenceKey ?: "componentsJson") ?: return null
        when (value.string("type")) {
          "CORE_STREAM" -> HostMessage.CoreStream(previewId, generation, sentenceId, payload)
          else -> HostMessage.CoreResult(previewId, generation, sentenceId, payload)
        }
      }
      "DETAIL_STREAM" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "structuresJson")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.DetailStream(previewId, generation, sentenceId, value.string("structuresJson") ?: return null)
      }
      "CORE_ERROR" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation", "sentenceId", "code", "message")) return null
        val sentenceId = value.string("sentenceId")?.takeIf { it.isNotEmpty() } ?: return null
        HostMessage.CoreError(
          previewId, generation, sentenceId,
          value.string("code") ?: return null,
          value.string("message") ?: return null,
        )
      }
      "RESTORE_ALL" -> {
        if (!hasOnlyKeys(value, "version", "type", "previewId", "generation")) return null
        HostMessage.RestoreAll(previewId, generation)
      }
      else -> null
    }
  }

  private fun hasOnlyKeys(value: JsonObject, vararg allowed: String?): Boolean {
    val allowedSet = allowed.filterNotNull().toSet()
    return value.keys.all { it in allowedSet }
  }

  private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

  private fun JsonObject.int(key: String): Int? {
    val primitive = (this[key] as? JsonPrimitive) ?: return null
    if (primitive.isString) return null
    return primitive.content.toIntOrNull()
  }
}
