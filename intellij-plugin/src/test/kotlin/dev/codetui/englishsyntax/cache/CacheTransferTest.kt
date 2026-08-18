package dev.codetui.englishsyntax.cache

import dev.codetui.englishsyntax.contract.FixtureLoader
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.io.path.createTempDirectory

class CacheTransferTest {
  private lateinit var tempDir: java.nio.file.Path

  @BeforeTest
  fun setUp() {
    tempDir = createTempDirectory("english-syntax-transfer")
  }

  @AfterTest
  fun tearDown() {
    tempDir.toFile().deleteRecursively()
  }

  @Test
  fun `imports the shared fixture and round trips its entries`() = runBlocking {
    AnalysisCache(tempDir.resolve("cache.sqlite")).use { cache ->
      val report = CacheTransfer.importCacheFile(cache, FixtureLoader.text("cache-transfer-v1.json"))
      assertTrue(report is ImportReport.Ok, report.toString())
      assertEquals(2, (report as ImportReport.Ok).added)
      assertEquals(0, report.skipped)
      assertEquals(0, report.invalid)

      val shared = Json.parseToJsonElement(FixtureLoader.text("cache-transfer-v1.json")).jsonObject
      val coreEntry = shared.getValue("core").jsonArray.single().jsonObject
      val detailEntry = shared.getValue("detail").jsonArray.single().jsonObject

      assertEquals(
        coreEntry.getValue("value").jsonObject,
        cache.getCore(coreEntry.getValue("key").jsonPrimitive.content),
      )
      assertEquals(
        detailEntry.getValue("value").jsonObject,
        cache.getDetail(detailEntry.getValue("key").jsonPrimitive.content),
      )

      // 导入同一文件第二次：已有键全部跳过。
      val second = CacheTransfer.importCacheFile(cache, FixtureLoader.text("cache-transfer-v1.json"))
      assertEquals(ImportReport.Ok(added = 0, skipped = 2, invalid = 0), second)

      // 导出后键与值与共享 fixture 一致（exportedAt 由两边各自生成，不参与比较）。
      val exported = CacheTransfer.exportCacheFile(cache)
      assertEquals(listOf(coreEntry.getValue("key").jsonPrimitive.content), exported.core.map { it.key })
      assertEquals(listOf(detailEntry.getValue("key").jsonPrimitive.content), exported.detail.map { it.key })
    }
  }

  @Test
  fun `rejects invalid files without partial writes`() = runBlocking {
    AnalysisCache(tempDir.resolve("cache.sqlite")).use { cache ->
      assertEquals(ImportReport.Failure("not-json"), CacheTransfer.importCacheFile(cache, "{oops"))
      assertEquals(ImportReport.Failure("bad-format"), CacheTransfer.importCacheFile(cache, """{"format":"other"}"""))
      // format 字段是数组 / 对象而不是 string primitive：整体拒绝而不是抛异常。
      assertEquals(ImportReport.Failure("bad-format"), CacheTransfer.importCacheFile(cache, """{"format":[]}"""))
      assertEquals(ImportReport.Failure("bad-format"), CacheTransfer.importCacheFile(cache, """{"format":{}}"""))
      // 合法 JSON 顶层非对象：bad-format，与 TS 分类一致。
      assertEquals(ImportReport.Failure("bad-format"), CacheTransfer.importCacheFile(cache, "[1,2]"))
      assertEquals(
        ImportReport.Failure("schema-mismatch"),
        CacheTransfer.importCacheFile(
          cache,
          """{"format":"english-syntax-cache","formatVersion":1,"schemaVersion":2,"core":[],"detail":[]}""",
        ),
      )
      assertEquals(0, cache.stats().entries)
    }
    Unit
  }

  @Test
  fun `counts invalid entries but imports valid ones`() = runBlocking {
    AnalysisCache(tempDir.resolve("cache.sqlite")).use { cache ->
      val file = """
        {"format":"english-syntax-cache","formatVersion":1,"schemaVersion":1,
         "exportedAt":"2026-08-18T00:00:00Z",
         "core":[
           {"key":"not-hex","value":{}},
           {"key":"${"e".repeat(64)}","value":{"ok":true}},
           {"key":"${"f".repeat(64)}","value":"not-an-object"}
         ],
         "detail":[]}
      """.trimIndent()
      val report = CacheTransfer.importCacheFile(cache, file)
      assertEquals(ImportReport.Ok(added = 1, skipped = 0, invalid = 2), report)
    }
  }
}
