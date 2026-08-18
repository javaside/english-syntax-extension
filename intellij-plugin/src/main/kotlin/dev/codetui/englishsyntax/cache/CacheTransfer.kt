package dev.codetui.englishsyntax.cache

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant

data class CacheExportFile(
  val format: String,
  val formatVersion: Int,
  val schemaVersion: Int,
  val exportedAt: String,
  val core: List<TransferEntry>,
  val detail: List<TransferEntry>,
)

sealed interface ImportReport {
  data class Ok(val added: Int, val skipped: Int, val invalid: Int) : ImportReport
  data class Failure(val reason: String) : ImportReport
}

private val HEX_KEY = Regex("^[0-9a-f]{64}$")
private const val CACHE_FILE_FORMAT = "english-syntax-cache"
private const val CACHE_FILE_FORMAT_VERSION = 1
const val IMPORTED_PROFILE_ID = "imported"

/**
 * 与 Chrome 端 `cache-transfer.ts` 相同的交换文件契约：
 * 格式头 + core/detail 条目；导入前整体校验，非法格式/版本整体拒绝；
 * 逐条过滤畸形条目；本地优先合并——已有键跳过。
 */
object CacheTransfer {
  private val json = Json { prettyPrint = false }

  suspend fun exportCacheFile(cache: AnalysisCache, now: () -> Instant = Instant::now): CacheExportFile =
    CacheExportFile(
      format = CACHE_FILE_FORMAT,
      formatVersion = CACHE_FILE_FORMAT_VERSION,
      schemaVersion = AnalysisCache.SCHEMA_VERSION,
      exportedAt = now().toString(),
      core = cache.exportEntries(CacheStore.CORE),
      detail = cache.exportEntries(CacheStore.DETAIL),
    )

  suspend fun exportJson(cache: AnalysisCache, now: () -> Instant = Instant::now): String =
    json.encodeToString(CacheExportFileDto.serializer(), CacheExportFileDto.from(toDto(exportCacheFile(cache, now))))

  suspend fun importCacheFile(cache: AnalysisCache, text: String): ImportReport {
    val parsed = try {
      json.parseToJsonElement(text).jsonObject
    } catch (_: Exception) {
      return ImportReport.Failure("not-json")
    }
    if (parsed["format"]?.jsonPrimitive?.content != CACHE_FILE_FORMAT ||
      parsed["formatVersion"]?.jsonPrimitive?.content?.toIntOrNull() != CACHE_FILE_FORMAT_VERSION ||
      parsed["core"] !is JsonArray ||
      parsed["detail"] !is JsonArray
    ) {
      return ImportReport.Failure("bad-format")
    }
    if (parsed["schemaVersion"]?.jsonPrimitive?.content?.toIntOrNull() != AnalysisCache.SCHEMA_VERSION) {
      return ImportReport.Failure("schema-mismatch")
    }

    var added = 0
    var skipped = 0
    var invalid = 0
    for (store in listOf(CacheStore.CORE, CacheStore.DETAIL)) {
      val candidates = parsed[if (store == CacheStore.CORE) "core" else "detail"]!!.jsonArray
      val valid = mutableListOf<TransferEntry>()
      for (candidate in candidates) {
        val entry = candidate as? JsonObject
        val key = entry?.get("key")?.jsonPrimitive?.takeIf { it.isString }?.content
        if (key == null || !HEX_KEY.matches(key) || entry["value"] !is JsonObject) {
          invalid += 1
          continue
        }
        valid += TransferEntry(key, entry["value"] as JsonObject)
      }
      val outcome = cache.importEntries(store, valid, IMPORTED_PROFILE_ID)
      added += outcome.added
      skipped += outcome.skipped
    }
    return ImportReport.Ok(added, skipped, invalid)
  }

  private fun toDto(file: CacheExportFile) = file
}

@kotlinx.serialization.Serializable
private data class CacheExportFileDto(
  val format: String,
  val formatVersion: Int,
  val schemaVersion: Int,
  val exportedAt: String,
  val core: List<TransferEntryDto>,
  val detail: List<TransferEntryDto>,
) {
  @kotlinx.serialization.Serializable
  data class TransferEntryDto(val key: String, val value: JsonObject)

  companion object {
    fun from(file: CacheExportFile) = CacheExportFileDto(
      format = file.format,
      formatVersion = file.formatVersion,
      schemaVersion = file.schemaVersion,
      exportedAt = file.exportedAt,
      core = file.core.map { TransferEntryDto(it.key, it.value) },
      detail = file.detail.map { TransferEntryDto(it.key, it.value) },
    )
  }
}
