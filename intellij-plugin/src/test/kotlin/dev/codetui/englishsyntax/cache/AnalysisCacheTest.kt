package dev.codetui.englishsyntax.cache

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.io.path.createTempDirectory

class AnalysisCacheTest {
  private lateinit var tempDir: java.nio.file.Path

  @BeforeTest
  fun setUp() {
    tempDir = createTempDirectory("english-syntax-cache")
  }

  @AfterTest
  fun tearDown() {
    tempDir.toFile().deleteRecursively()
  }

  private fun cache(limitBytes: Long = 50L * 1024 * 1024, now: () -> Long = { 0L }) =
    AnalysisCache(tempDir.resolve("cache.sqlite"), limitBytes, now)

  private fun value(marker: String): JsonObject = buildJsonObject { put("marker", marker) }

  private fun JsonObject.marker(): String? = get("marker")?.jsonPrimitive?.content

  @Test
  fun `put and get round trips values`() = runBlocking {
    cache().use { cache ->
      cache.putCore("a".repeat(64), "profile-1", value("core"))
      cache.putDetail("b".repeat(64), "profile-1", value("detail"))

      assertEquals("core", cache.getCore("a".repeat(64))?.marker())
      assertEquals("detail", cache.getDetail("b".repeat(64))?.marker())
      assertNull(cache.getCore("missing"))
    }
  }

  @Test
  fun `same-millisecond writes get monotonic timestamps`() = runBlocking {
    cache(now = { 1_000L }).use { cache ->
      cache.putCore("a".repeat(64), "p", value("1"))
      cache.putCore("b".repeat(64), "p", value("2"))
      cache.putCore("c".repeat(64), "p", value("3"))

      cache.withConnection { statement ->
        val timestamps = statement.executeQuery(
          "SELECT last_accessed_at FROM analysis_cache ORDER BY last_accessed_at ASC",
        ).use { result ->
          buildList { while (result.next()) add(result.getLong(1)) }
        }
        assertEquals(listOf(1_000L, 1_001L, 1_002L), timestamps)
      }
    }
  }

  @Test
  fun `reading a value refreshes last accessed`() = runBlocking {
    var clock = 1_000L
    cache(now = { clock }).use { cache ->
      cache.putCore("a".repeat(64), "p", value("1"))
      clock = 2_000L
      cache.putCore("b".repeat(64), "p", value("2"))

      clock = 3_000L
      assertNotNull(cache.getCore("a".repeat(64)))

      cache.withConnection { statement ->
        val order = statement.executeQuery(
          "SELECT cache_key FROM analysis_cache ORDER BY last_accessed_at ASC",
        ).use { result ->
          buildList { while (result.next()) add(result.getString(1)) }
        }
        assertEquals("b".repeat(64), order.first())
        assertEquals("a".repeat(64), order.last())
      }
    }
  }

  @Test
  fun `evicts across core and detail stores by lru`() = runBlocking {
    var clock = 1_000L
    // 每条 estimateBytes = pad 编码长度 + 256；上限 1200 放得下两条、放不下三条，
    // 第三条写入时按 last_accessed_at 淘汰最旧的 a（跨 core/detail store）。
    cache(limitBytes = 1_200, now = { clock }).use { cache ->
      cache.putCore("a".repeat(64), "p", buildJsonObject { put("pad", "x".repeat(300)) })
      clock += 1
      cache.putCore("b".repeat(64), "p", buildJsonObject { put("pad", "x".repeat(300)) })
      clock += 1
      cache.putDetail("c".repeat(64), "p", buildJsonObject { put("pad", "x".repeat(300)) })

      assertNull(cache.getCore("a".repeat(64)))
      assertNotNull(cache.getCore("b".repeat(64)))
      assertNotNull(cache.getDetail("c".repeat(64)))
    }
    Unit
  }

  @Test
  fun `import skips existing keys and reports counts`() = runBlocking {
    cache().use { cache ->
      cache.putCore("a".repeat(64), "profile-1", value("local"))
      val outcome = cache.importEntries(
        CacheStore.CORE,
        listOf(
          TransferEntry("a".repeat(64), value("imported")),
          TransferEntry("d".repeat(64), value("new")),
        ),
        "imported",
      )
      assertEquals(1, outcome.added)
      assertEquals(1, outcome.skipped)
      assertEquals("local", cache.getCore("a".repeat(64))?.marker())
      assertEquals("new", cache.getCore("d".repeat(64))?.marker())
    }
  }

  @Test
  fun `clear empties the cache`() = runBlocking {
    cache().use { cache ->
      cache.putCore("a".repeat(64), "p", value("1"))
      cache.putDetail("b".repeat(64), "p", value("2"))

      cache.clear()

      val stats = cache.stats()
      assertEquals(0, stats.entries)
      assertEquals(0L, stats.estimatedBytes)
    }
  }

  @Test
  fun `export contains no profile credentials`() = runBlocking {
    cache().use { cache ->
      val stored = buildJsonObject { put("data", "value") }
      cache.putCore("a".repeat(64), "secret-profile", stored)

      val entries = cache.exportEntries(CacheStore.CORE)
      // 导出条目恰好是 {key, value}：不携带 profile_id、时间戳、字节估算等簿记字段。
      assertEquals(listOf(TransferEntry("a".repeat(64), stored)), entries)
    }
    Unit
  }
}
