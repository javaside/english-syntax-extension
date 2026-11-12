package dev.codetui.englishsyntax.settings

import dev.codetui.englishsyntax.cache.ImportReport
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/**
 * F4 缓存导入/导出入口 + F5 profile 切换即时生效 + F6 AUTH_FAILED 暂停解除路径的设置页测试。
 *
 * - IO 不在 EDT：由 BackgroundDispatcher seam 钉住——action 只把 IO 块派发给 seam，
 *   测试先断言「派发前 transfer 未被调用」，再手动执行捕获的块（对应生产的 pooled 线程）。
 * - F5：ProfileRefresh seam 记录 refreshProfile 被调次数。
 * - F6：PauseControl seam 记录解除路径（保存后指纹比较在后台块内、测试连接成功无条件解除、
 *   profile 删除清理）。
 */
class EnglishSyntaxConfigurableCacheTransferTest {

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

  private class FakeCacheTransferOperations : EnglishSyntaxConfigurable.CacheTransferOperations {
    val exportPaths = mutableListOf<Path>()
    val importPaths = mutableListOf<Path>()
    var exportCount = 5
    var importReport: ImportReport = ImportReport.Ok(3, 2, 0)
    var exportError: Exception? = null
    var importError: Exception? = null

    override suspend fun exportTo(path: Path): Int {
      exportPaths.add(path)
      exportError?.let { throw it }
      return exportCount
    }

    override suspend fun importFrom(path: Path): ImportReport {
      importPaths.add(path)
      importError?.let { throw it }
      return importReport
    }
  }

  private class FakeCacheTransferUi(
    var exportPath: Path? = Path.of("/tmp/english-syntax-cache.json"),
    var importPath: Path? = Path.of("/tmp/imported-cache.json"),
  ) : EnglishSyntaxConfigurable.CacheTransferUi {
    val balloons = mutableListOf<Pair<String, Boolean>>()

    override fun chooseExportFile(): Path? = exportPath

    override fun chooseImportFile(): Path? = importPath

    override fun balloon(text: String, error: Boolean) {
      balloons.add(text to error)
    }
  }

  /** 捕获派发的 IO 块而不执行：对应生产的 executeOnPooledThread，测试手动触发。 */
  private class CapturingDispatcher : EnglishSyntaxConfigurable.BackgroundDispatcher {
    val tasks = mutableListOf<() -> Unit>()

    override fun dispatch(task: () -> Unit) {
      tasks.add(task)
    }
  }

  private class RecordingProfileRefresh : EnglishSyntaxConfigurable.ProfileRefresh {
    var calls = 0

    override fun refresh() {
      calls += 1
    }
  }

  /** F6：暂停表解除路径的记录桩（保存后指纹比较 / 测试连接成功 / profile 删除）。 */
  private class RecordingPauseControl : EnglishSyntaxConfigurable.PauseControl {
    val fingerprintReleases = mutableListOf<String>()
    val releases = mutableListOf<String>()
    var fingerprintChanged = false

    override suspend fun releaseIfFingerprintChanged(profileId: String): Boolean {
      fingerprintReleases += profileId
      return fingerprintChanged
    }

    override fun release(profileId: String) {
      releases += profileId
    }
  }

  private fun profile(
    id: String = "profile-1",
    name: String = "Example",
  ) = ModelProfile(
    id = id,
    name = name,
    baseUrl = "https://api.example.com/v1/",
    model = "example-model",
    headerNames = emptySet(),
    timeoutMs = 30_000,
    jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
  )

  private fun configurable(
    repository: ProfileRepository,
    transfer: FakeCacheTransferOperations = FakeCacheTransferOperations(),
    ui: FakeCacheTransferUi = FakeCacheTransferUi(),
    dispatcher: CapturingDispatcher = CapturingDispatcher(),
    refresh: RecordingProfileRefresh = RecordingProfileRefresh(),
    probe: EnglishSyntaxConfigurable.ConnectionProbe = EnglishSyntaxConfigurable.ConnectionProbe {
      EnglishSyntaxConfigurable.ConnectionProbeResult(true, "stub")
    },
    pause: RecordingPauseControl = RecordingPauseControl(),
  ): EnglishSyntaxConfigurable {
    return EnglishSyntaxConfigurable(
      repository,
      ProfileState(),
      probe,
      cacheTransfer = transfer,
      transferUi = ui,
      background = dispatcher,
      profileRefresh = refresh,
      pauseControl = pause,
    )
  }

  @Test
  fun `export dispatches io off the caller thread and balloons the exported count`() {
    val transfer = FakeCacheTransferOperations()
    val ui = FakeCacheTransferUi()
    val dispatcher = CapturingDispatcher()
    val configurable = configurable(repositoryWithTwoProfiles(), transfer, ui, dispatcher)

    assertTrue(configurable.runExportCacheAction())
    // EDT 上只允许对话框：派发前不得有任何 IO 或结果反馈。
    assertEquals(0, transfer.exportPaths.size)
    assertEquals(0, ui.balloons.size)

    dispatcher.tasks.single().invoke()

    assertEquals(listOf(Path.of("/tmp/english-syntax-cache.json")), transfer.exportPaths)
    val (text, error) = ui.balloons.single()
    assertFalse(error)
    assertTrue(text.contains("已导出"), "expected exported count text, got: $text")
    assertTrue(text.contains("5"), "expected exported count in text, got: $text")
  }

  @Test
  fun `import reports added and skipped counts through the background dispatch`() {
    val transfer = FakeCacheTransferOperations()
    transfer.importReport = ImportReport.Ok(added = 3, skipped = 2, invalid = 0)
    val ui = FakeCacheTransferUi()
    val dispatcher = CapturingDispatcher()
    val configurable = configurable(repositoryWithTwoProfiles(), transfer, ui, dispatcher)

    assertTrue(configurable.runImportCacheAction())
    assertEquals(0, transfer.importPaths.size)
    assertEquals(0, ui.balloons.size)

    dispatcher.tasks.single().invoke()

    assertEquals(listOf(Path.of("/tmp/imported-cache.json")), transfer.importPaths)
    val (text, error) = ui.balloons.single()
    assertFalse(error)
    assertTrue(text.contains("已导入 3 条，跳过 2 条"), "expected import counts text, got: $text")
  }

  @Test
  fun `import failure report surfaces as a warning balloon`() {
    val transfer = FakeCacheTransferOperations()
    transfer.importReport = ImportReport.Failure("schema-mismatch")
    val ui = FakeCacheTransferUi()
    val dispatcher = CapturingDispatcher()
    val configurable = configurable(repositoryWithTwoProfiles(), transfer, ui, dispatcher)

    assertTrue(configurable.runImportCacheAction())
    dispatcher.tasks.single().invoke()

    val (text, error) = ui.balloons.single()
    assertTrue(error)
    assertTrue(text.contains("schema"), "expected schema-mismatch explanation, got: $text")
  }

  @Test
  fun `io errors surface as warning balloons with the failure message`() {
    val exportTransfer = FakeCacheTransferOperations()
    exportTransfer.exportError = RuntimeException("disk full")
    val exportUi = FakeCacheTransferUi()
    val exportDispatcher = CapturingDispatcher()
    val exportConfigurable = configurable(repositoryWithTwoProfiles(), exportTransfer, exportUi, exportDispatcher)
    exportConfigurable.runExportCacheAction()
    exportDispatcher.tasks.single().invoke()
    val (exportText, exportError) = exportUi.balloons.single()
    assertTrue(exportError)
    assertTrue(exportText.contains("disk full"), "expected error message, got: $exportText")

    val importTransfer = FakeCacheTransferOperations()
    importTransfer.importError = RuntimeException("locked file")
    val importUi = FakeCacheTransferUi()
    val importDispatcher = CapturingDispatcher()
    val importConfigurable = configurable(repositoryWithTwoProfiles(), importTransfer, importUi, importDispatcher)
    importConfigurable.runImportCacheAction()
    importDispatcher.tasks.single().invoke()
    val (importText, importError) = importUi.balloons.single()
    assertTrue(importError)
    assertTrue(importText.contains("locked file"), "expected error message, got: $importText")
  }

  @Test
  fun `declining the file chooser dispatches nothing`() {
    val transfer = FakeCacheTransferOperations()
    val ui = FakeCacheTransferUi(exportPath = null, importPath = null)
    val dispatcher = CapturingDispatcher()
    val configurable = configurable(repositoryWithTwoProfiles(), transfer, ui, dispatcher)

    assertFalse(configurable.runExportCacheAction())
    assertFalse(configurable.runImportCacheAction())
    assertEquals(0, dispatcher.tasks.size)
    assertEquals(0, transfer.exportPaths.size)
    assertEquals(0, transfer.importPaths.size)
    assertEquals(0, ui.balloons.size)
  }

  @Test
  fun `activating another profile refreshes the session profile snapshot exactly once`() = runBlocking {
    val repository = repositoryWithTwoProfiles()
    val refresh = RecordingProfileRefresh()
    val configurable = configurable(repository, refresh = refresh)

    configurable.selectProfile("profile-2")
    assertTrue(configurable.activateForm())

    assertEquals("profile-2", repository.active()?.id)
    assertEquals(1, refresh.calls)
  }

  @Test
  fun `saving the active profile refreshes and saving an inactive profile does not`() = runBlocking {
    val repository = repositoryWithTwoProfiles()
    val refresh = RecordingProfileRefresh()
    val configurable = configurable(repository, refresh = refresh)

    // 非激活 profile 的保存不影响任何会话快照。
    configurable.selectProfile("profile-2")
    assertTrue(configurable.saveForm())
    assertEquals(0, refresh.calls)

    // 激活 profile 的字段编辑（apply 路径）必须让已开会话用上新 profile。
    configurable.selectProfile("profile-1")
    configurable.form.model = "replacement-model"
    assertTrue(configurable.saveForm())
    assertEquals(1, refresh.calls)
    assertEquals("replacement-model", repository.active()?.model)
  }

  @Test
  fun `re-activating the active profile stays idempotent`() = runBlocking {
    val repository = repositoryWithTwoProfiles()
    val refresh = RecordingProfileRefresh()
    val configurable = configurable(repository, refresh = refresh)

    configurable.selectProfile("profile-1")
    assertTrue(configurable.activateForm())
    assertTrue(configurable.actionStatus.contains("activated"))
    assertTrue(refresh.calls >= 1)

    // 幂等场景：对当前 active 重复「启用」不炸，repository 状态不变。
    assertTrue(configurable.activateForm())
    assertEquals("profile-1", repository.active()?.id)
  }

  // ---- F6 AUTH_FAILED 暂停的解除路径（保存指纹比较 / 测试连接成功 / 删除清理）----

  /**
   * ② 改凭据保存后解除：指纹比较（要读 PasswordSafe）派发到后台线程，EDT 上不得发生；
   * 后台块以保存的 profile id 调 releaseIfFingerprintChanged。
   */
  @Test
  fun `saving a profile dispatches the pause fingerprint release off the caller thread`() {
    val repository = repositoryWithTwoProfiles()
    val pause = RecordingPauseControl()
    val dispatcher = CapturingDispatcher()
    val configurable = configurable(repository, dispatcher = dispatcher, pause = pause)

    configurable.selectProfile("profile-2")
    configurable.form.apiKey = "sk-replaced"
    assertTrue(configurable.saveForm())

    assertEquals(0, pause.fingerprintReleases.size, "EDT 上不得做指纹组装（PasswordSafe 读取）")
    dispatcher.tasks.single().invoke()
    assertEquals(listOf("profile-2"), pause.fingerprintReleases, "保存后必须按该 profile 比较指纹解除")
  }

  /** ③ 测试连接成功解除（对齐 Chrome TEST_PROFILE 的 resumeProfile）；失败不解除。 */
  @Test
  fun `a successful connection test releases the pause and a failed one does not`() {
    val repository = repositoryWithTwoProfiles()
    val okPause = RecordingPauseControl()
    val okConfigurable = configurable(repository, pause = okPause)
    okConfigurable.selectProfile("profile-1")
    assertTrue(okConfigurable.runConnectionAction())
    assertEquals(listOf("profile-1"), okPause.releases, "连接成功必须无条件解除暂停")

    val failingProbe = EnglishSyntaxConfigurable.ConnectionProbe {
      EnglishSyntaxConfigurable.ConnectionProbeResult(false, "401 Unauthorized")
    }
    val failedPause = RecordingPauseControl()
    val failedConfigurable = configurable(repositoryWithTwoProfiles(), probe = failingProbe, pause = failedPause)
    failedConfigurable.selectProfile("profile-1")
    assertFalse(failedConfigurable.runConnectionAction())
    assertEquals(0, failedPause.releases.size, "连接失败不得解除暂停")
  }

  /** profile 删除时清掉暂停条目（防死 key：同 id 重建的新 profile 不继承旧暂停）。 */
  @Test
  fun `deleting a profile clears its pause entry`() {
    val repository = repositoryWithTwoProfiles()
    val pause = RecordingPauseControl()
    val configurable = configurable(repository, pause = pause)

    configurable.selectProfile("profile-2")
    assertTrue(configurable.deleteForm())
    assertEquals(listOf("profile-2"), pause.releases)
  }

  private fun repositoryWithTwoProfiles(): ProfileRepository {
    val repository = ProfileRepository(ProfileState(), FakeCredentialStore())
    return runBlocking {
      repository.save(profile())
      repository.save(profile(id = "profile-2", name = "Second"))
      repository
    }
  }
}
