package dev.codetui.englishsyntax.cache

import dev.codetui.englishsyntax.domain.ContractVersions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.sqlite.SQLiteDataSource
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.util.concurrent.atomic.AtomicLong

data class CacheStats(
  val entries: Int,
  val estimatedBytes: Long,
  val limitBytes: Long,
)

enum class CacheStore { CORE, DETAIL }

data class TransferEntry(val key: String, val value: JsonObject)

data class ImportOutcome(val added: Int, val skipped: Int)

/**
 * SQLite 实现的分析缓存：core/detail 两个逻辑 store 共表，跨 store LRU 限额。
 * 所有 DB 操作走 Dispatchers.IO；同毫秒写入用单调时间戳保证 LRU 顺序稳定。
 */
class AnalysisCache(
  databasePath: Path,
  private val limitBytes: Long = DEFAULT_LIMIT_BYTES,
  private val now: () -> Long = System::currentTimeMillis,
) : AutoCloseable {
  private val connection: Connection
  private val mutex = Mutex()
  private val lastTimestamp = AtomicLong(Long.MIN_VALUE)

  init {
    Files.createDirectories(databasePath.toAbsolutePath().parent)
    // 不用 DriverManager:IDEA 插件 classloader 下 sqlite-jdbc 的 ServiceLoader
    // 注册不可靠,会抛 "No suitable driver found"。SQLiteDataSource 走直接实例化,
    // 不碰全局驱动注册表,动态卸载也无类加载器泄漏。
    val dataSource = SQLiteDataSource()
    dataSource.url = "jdbc:sqlite:$databasePath"
    connection = dataSource.connection
    connection.createStatement().use { statement ->
      statement.executeUpdate(DDL)
    }
  }

  suspend fun getCore(key: String): JsonObject? = get(CacheStore.CORE, key)

  suspend fun putCore(key: String, profileId: String, value: JsonObject) {
    put(CacheStore.CORE, key, profileId, value)
  }

  suspend fun getDetail(key: String): JsonObject? = get(CacheStore.DETAIL, key)

  suspend fun putDetail(key: String, profileId: String, value: JsonObject) {
    put(CacheStore.DETAIL, key, profileId, value)
  }

  suspend fun stats(): CacheStats = withContext(Dispatchers.IO) {
    mutex.withLock {
      connection.createStatement().use { statement ->
        statement.executeQuery(
          "SELECT COUNT(*), COALESCE(SUM(estimated_bytes), 0) FROM analysis_cache",
        ).use { result ->
          result.next()
          CacheStats(result.getInt(1), result.getLong(2), limitBytes)
        }
      }
    }
  }

  suspend fun clear() = withContext(Dispatchers.IO) {
    mutex.withLock {
      connection.createStatement().use { it.executeUpdate("DELETE FROM analysis_cache") }
    }
  }

  suspend fun exportEntries(store: CacheStore): List<TransferEntry> = withContext(Dispatchers.IO) {
    mutex.withLock {
      connection.prepareStatement("SELECT cache_key, value_json FROM analysis_cache WHERE store = ?").use { statement ->
        statement.setString(1, store.name.lowercase())
        statement.executeQuery().use { result ->
          buildList {
            while (result.next()) {
              add(TransferEntry(result.getString(1), json.parseToJsonElement(result.getString(2)).jsonObject))
            }
          }
        }
      }
    }
  }

  suspend fun importEntries(
    store: CacheStore,
    entries: List<TransferEntry>,
    profileId: String,
  ): ImportOutcome = withContext(Dispatchers.IO) {
    mutex.withLock {
      var added = 0
      connection.autoCommit = false
      try {
        for (entry in entries) {
          if (exists(store, entry.key)) continue
          val timestamp = nextTimestamp()
          connection.prepareStatement(
            """INSERT INTO analysis_cache (store, cache_key, profile_id, value_json, created_at, last_accessed_at, estimated_bytes)
               VALUES (?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
          ).use { statement ->
            statement.setString(1, store.name.lowercase())
            statement.setString(2, entry.key)
            statement.setString(3, profileId)
            statement.setString(4, json.encodeToString(JsonObject.serializer(), entry.value))
            statement.setLong(5, timestamp)
            statement.setLong(6, timestamp)
            statement.setLong(7, estimateBytes(entry.value))
            statement.executeUpdate()
          }
          added += 1
        }
        connection.commit()
      } catch (error: Exception) {
        connection.rollback()
        throw error
      } finally {
        connection.autoCommit = true
      }
      enforceLimitLocked()
      ImportOutcome(added, entries.size - added)
    }
  }

  override fun close() {
    connection.close()
  }

  /** 测试辅助：持锁访问底层连接以断言内部状态。 */
  suspend fun withConnection(block: (java.sql.Statement) -> Unit) {
    mutex.withLock {
      connection.createStatement().use(block)
    }
  }

  private suspend fun get(store: CacheStore, key: String): JsonObject? = withContext(Dispatchers.IO) {
    mutex.withLock {
      connection.prepareStatement(
        "SELECT value_json FROM analysis_cache WHERE store = ? AND cache_key = ?",
      ).use { statement ->
        statement.setString(1, store.name.lowercase())
        statement.setString(2, key)
        statement.executeQuery().use { result ->
          if (!result.next()) return@withContext null
          val value = json.parseToJsonElement(result.getString(1)).jsonObject
          connection.prepareStatement(
            "UPDATE analysis_cache SET last_accessed_at = ? WHERE store = ? AND cache_key = ?",
          ).use { update ->
            update.setLong(1, nextTimestamp())
            update.setString(2, store.name.lowercase())
            update.setString(3, key)
            update.executeUpdate()
          }
          value
        }
      }
    }
  }

  private suspend fun put(store: CacheStore, key: String, profileId: String, value: JsonObject) {
    withContext(Dispatchers.IO) {
      mutex.withLock {
        val timestamp = nextTimestamp()
        connection.prepareStatement(
          """INSERT INTO analysis_cache (store, cache_key, profile_id, value_json, created_at, last_accessed_at, estimated_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(store, cache_key) DO UPDATE SET
               profile_id = excluded.profile_id,
               value_json = excluded.value_json,
               last_accessed_at = excluded.last_accessed_at,
               estimated_bytes = excluded.estimated_bytes""".trimIndent(),
        ).use { statement ->
          statement.setString(1, store.name.lowercase())
          statement.setString(2, key)
          statement.setString(3, profileId)
          statement.setString(4, json.encodeToString(JsonObject.serializer(), value))
          statement.setLong(5, timestamp)
          statement.setLong(6, timestamp)
          statement.setLong(7, estimateBytes(value))
          statement.executeUpdate()
        }
        enforceLimitLocked()
      }
    }
  }

  private fun exists(store: CacheStore, key: String): Boolean =
    connection.prepareStatement(
      "SELECT 1 FROM analysis_cache WHERE store = ? AND cache_key = ?",
    ).use { statement ->
      statement.setString(1, store.name.lowercase())
      statement.setString(2, key)
      statement.executeQuery().use { it.next() }
    }

  /** 跨两个 store 按 last_accessed_at 升序淘汰到 limitBytes 以内；调用方须持锁。 */
  private fun enforceLimitLocked() {
    connection.createStatement().use { statement ->
      val total = statement.executeQuery(
        "SELECT COALESCE(SUM(estimated_bytes), 0) FROM analysis_cache",
      ).use { result ->
        result.next()
        result.getLong(1)
      }
      if (total <= limitBytes) return
      statement.executeQuery(
        "SELECT store, cache_key, estimated_bytes FROM analysis_cache ORDER BY last_accessed_at ASC",
      ).use { result ->
        var running = total
        val toDelete = mutableListOf<Triple<String, String, Long>>()
        while (result.next() && running > limitBytes) {
          val store = result.getString(1)
          val key = result.getString(2)
          val bytes = result.getLong(3)
          toDelete += Triple(store, key, bytes)
          running -= bytes
        }
        toDelete
      }.forEach { (store, key, _) ->
        connection.prepareStatement("DELETE FROM analysis_cache WHERE store = ? AND cache_key = ?").use { delete ->
          delete.setString(1, store)
          delete.setString(2, key)
          delete.executeUpdate()
        }
      }
    }
  }

  /** 单调递增：同毫秒多次写入也不会撞 LRU 顺序。 */
  private fun nextTimestamp(): Long {
    var previous = lastTimestamp.get()
    var timestamp = now()
    while (true) {
      timestamp = maxOf(timestamp, previous + 1)
      if (lastTimestamp.compareAndSet(previous, timestamp)) return timestamp
      previous = lastTimestamp.get()
    }
  }

  companion object {
    const val DEFAULT_LIMIT_BYTES: Long = 50L * 1024 * 1024
    const val SCHEMA_VERSION: Int = ContractVersions.CORE_SCHEMA

    private val json = Json { prettyPrint = false }

    private fun estimateBytes(value: JsonElement): Long =
      json.encodeToString(JsonElement.serializer(), value).toByteArray(Charsets.UTF_8).size.toLong() + 256

    private const val DDL = """
      CREATE TABLE IF NOT EXISTS analysis_cache (
        store TEXT NOT NULL CHECK(store IN ('core','detail')),
        cache_key TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        estimated_bytes INTEGER NOT NULL,
        PRIMARY KEY(store, cache_key)
      );
      CREATE INDEX IF NOT EXISTS analysis_cache_lru ON analysis_cache(last_accessed_at);
    """
  }
}
