package dev.codetui.englishsyntax.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import dev.codetui.englishsyntax.AnalysisServiceService
import dev.codetui.englishsyntax.EnglishSyntaxBundle
import dev.codetui.englishsyntax.PreviewSessionManagerService
import dev.codetui.englishsyntax.actions.ActionNotifier
import dev.codetui.englishsyntax.cache.CacheTransfer
import dev.codetui.englishsyntax.cache.ImportReport
import kotlinx.coroutines.runBlocking
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

class EnglishSyntaxConfigurable(
  private val repository: ProfileRepository = service(),
  private val profileState: ProfileState = service(),
  private val connectionProbe: ConnectionProbe = ServiceConnectionProbe(),
  private val cacheOperations: CacheOperations = ServiceCacheOperations(),
  private val clearConfirmation: ClearConfirmation = DialogClearConfirmation(),
  private val cacheTransfer: CacheTransferOperations = ServiceCacheTransferOperations(),
  private val transferUi: CacheTransferUi = IdeaCacheTransferUi(),
  private val background: BackgroundDispatcher = BackgroundDispatcher { task ->
    ApplicationManager.getApplication().executeOnPooledThread { task() }
  },
  private val profileRefresh: ProfileRefresh = ProfileRefresh {
    service<PreviewSessionManagerService>().manager.refreshProfile()
  },
) : BoundConfigurable(EnglishSyntaxBundle.message("settings.display.name")) {

  data class CacheSummary(val entries: Int, val estimatedBytes: Long)

  interface CacheOperations {
    suspend fun stats(): CacheSummary
    suspend fun clear()
  }

  fun interface ClearConfirmation {
    fun confirm(): Boolean
  }

  private class ServiceCacheOperations : CacheOperations {
    override suspend fun stats(): CacheSummary {
      val stats = service<AnalysisServiceService>().cache.stats()
      return CacheSummary(stats.entries, stats.estimatedBytes)
    }

    override suspend fun clear() {
      service<AnalysisServiceService>().cache.clear()
    }
  }

  private class DialogClearConfirmation : ClearConfirmation {
    override fun confirm(): Boolean = Messages.showYesNoDialog(
      EnglishSyntaxBundle.message("settings.cache.clear.confirmation"),
      EnglishSyntaxBundle.message("settings.cache.clear.title"),
      Messages.getQuestionIcon(),
    ) == Messages.YES
  }

  /** F4 缓存导入导出的 IO 抽象：包装 CacheTransfer 与文件读写，只允许在后台线程调用。 */
  interface CacheTransferOperations {
    /** 导出全部缓存到 path；返回导出条数。IO 失败抛异常。 */
    suspend fun exportTo(path: Path): Int

    /** 从 path 读取并导入；格式/版本问题以 [ImportReport.Failure] 返回，IO 失败抛异常。 */
    suspend fun importFrom(path: Path): ImportReport
  }

  private class ServiceCacheTransferOperations : CacheTransferOperations {
    override suspend fun exportTo(path: Path): Int {
      val cache = service<AnalysisServiceService>().cache
      val entries = cache.stats().entries
      Files.writeString(path, CacheTransfer.exportJson(cache))
      return entries
    }

    override suspend fun importFrom(path: Path): ImportReport =
      CacheTransfer.importCacheFile(service<AnalysisServiceService>().cache, Files.readString(path))
  }

  /** F4 文件选择与结果 balloon 的抽象：对话框留在 EDT，balloon（Notifications.Bus）线程安全。 */
  interface CacheTransferUi {
    fun chooseExportFile(): Path?

    fun chooseImportFile(): Path?

    fun balloon(text: String, error: Boolean)
  }

  private class IdeaCacheTransferUi : CacheTransferUi {
    override fun chooseExportFile(): Path? {
      val descriptor = FileSaverDescriptor(
        "Export analysis cache",
        "English Syntax Learning cache exchange file",
        "json",
      )
      return FileChooserFactory.getInstance()
        .createSaveFileDialog(descriptor, null as Project?)
        .save(null as VirtualFile?, "english-syntax-cache.json")
        ?.file
        ?.toPath()
    }

    override fun chooseImportFile(): Path? {
      val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor("json")
      return FileChooser.chooseFile(descriptor, null as Project?, null)?.toNioPath()
    }

    override fun balloon(text: String, error: Boolean) {
      if (error) ActionNotifier.warn(null, text) else ActionNotifier.info(null, text)
    }
  }

  /** 设置页后台线程派发（EDT 规矩：导入导出的 IO 不得占用 EDT）；测试捕获以断言派发形态。 */
  fun interface BackgroundDispatcher {
    fun dispatch(task: () -> Unit)
  }

  /** F5：profile 切换/保存后刷新已开会话的 profile 快照（无会话时是幂等 no-op）。 */
  fun interface ProfileRefresh {
    fun refresh()
  }

  /** 测试连接的抽象：生产打真模型探测，测试注入假实现。 */
  fun interface ConnectionProbe {
    suspend fun probe(profile: ModelProfile): ConnectionProbeResult
  }

  data class ConnectionProbeResult(val success: Boolean, val message: String)

  /** 生产实现：先保存 profile（probe 要从 PasswordSafe 拿 key），再调模型客户端。 */
  private class ServiceConnectionProbe : ConnectionProbe {
    override suspend fun probe(profile: ModelProfile): ConnectionProbeResult {
      val client = service<dev.codetui.englishsyntax.ModelClientService>().client
      return try {
        when (client.probeJsonCapability(profile)) {
          dev.codetui.englishsyntax.settings.JsonSchemaSupport.SUPPORTED ->
            ConnectionProbeResult(true, "Connection OK, JSON schema supported")
          dev.codetui.englishsyntax.settings.JsonSchemaSupport.UNSUPPORTED ->
            ConnectionProbeResult(true, "Connection OK, JSON schema unsupported (compatibility mode)")
          else -> ConnectionProbeResult(true, "Connection OK")
        }
      } catch (error: Exception) {
        ConnectionProbeResult(false, error.message ?: error.javaClass.simpleName)
      }
    }
  }

  data class Form(
    var id: String = "",
    var name: String = "",
    var baseUrl: String = "",
    var model: String = "",
    var headers: String = "",
    var timeoutMs: Int = 30_000,
    var apiKey: String = "",
    var cacheLimitMb: Int = 50,
    var streamRendering: Boolean = true,
  )

  val form = Form()
  var actionStatus: String = ""
    private set
  var cacheStatus: String = ""
    private set
  private var baseline = form.copy()

  /** 状态反馈可见组件；createPanel 时绑定。 */
  private var statusLabel: javax.swing.JLabel? = null
  private var cacheStatusLabel: javax.swing.JLabel? = null

  private fun setStatus(text: String) {
    actionStatus = text
    statusLabel?.text = text
  }

  private fun setCacheStatus(text: String) {
    cacheStatus = text
    cacheStatusLabel?.text = text
  }

  init {
    resetForm()
  }

  override fun createPanel() = panel {
    refreshCacheStatus()
    group(EnglishSyntaxBundle.message("settings.profile.group")) {
      row(EnglishSyntaxBundle.message("settings.profile.active")) {
        button(EnglishSyntaxBundle.message("settings.profile.new")) { newProfile() }
      }
      // 已存 profile 列表：saveForm/deleteForm 后调 refreshPanel() 重建整个面板。
      row {
        label("") // 占位：profile 按钮行由 refreshProfileButtons 动态生成
          .visible(false)
      }
      row(EnglishSyntaxBundle.message("settings.profile.name")) {
        textField().bindText(form::name).align(AlignX.FILL)
      }
      row(EnglishSyntaxBundle.message("settings.profile.baseUrl")) {
        textField().bindText(form::baseUrl).align(AlignX.FILL)
      }
      row(EnglishSyntaxBundle.message("settings.profile.model")) {
        textField().bindText(form::model).align(AlignX.FILL)
      }
      row(EnglishSyntaxBundle.message("settings.profile.headers")) {
        textArea()
          .bindText(form::headers)
          .align(AlignX.FILL)
          .comment(EnglishSyntaxBundle.message("settings.profile.headers.comment"))
      }
      row(EnglishSyntaxBundle.message("settings.profile.timeout")) {
        intTextField(5_000..120_000).bindIntText(form::timeoutMs).align(AlignX.FILL)
      }
      row(EnglishSyntaxBundle.message("settings.profile.apiKey")) {
        passwordField().bindText(form::apiKey).align(AlignX.FILL)
      }
      row {
        button(EnglishSyntaxBundle.message("settings.profile.save")) { saveForm() }
        button(EnglishSyntaxBundle.message("settings.profile.testConnection")) { runConnectionAction() }
        button(EnglishSyntaxBundle.message("settings.profile.activate")) { activateForm() }
      }
    }
    group(EnglishSyntaxBundle.message("settings.behavior.group")) {
      row(EnglishSyntaxBundle.message("settings.cache.limit")) {
        intTextField(10..200).bindIntText(form::cacheLimitMb).align(AlignX.FILL)
      }
      row(EnglishSyntaxBundle.message("settings.cache.usage")) {
        cacheStatusLabel = javax.swing.JLabel(cacheStatus) as javax.swing.JLabel?
        cell(cacheStatusLabel!!)
        button(EnglishSyntaxBundle.message("settings.cache.clear")) { runClearCacheAction() }
        button(EnglishSyntaxBundle.message("settings.cache.export")) { runExportCacheAction() }
        button(EnglishSyntaxBundle.message("settings.cache.import")) { runImportCacheAction() }
      }
      row {
        checkBox(EnglishSyntaxBundle.message("settings.streamRendering")).bindSelected(form::streamRendering)
      }
    }
    row {
      statusLabel = javax.swing.JLabel("") as javax.swing.JLabel?
      cell(statusLabel!!)
    }
  }

  /** profile 列表变化后重建面板（BoundConfigurable 支持 revalidate）。 */
  fun refreshPanel() {
    // BoundConfigurable 的面板在 Settings 对话框生命周期内是单个实例;
    // profile 按钮行改为在 createPanel 时静态生成,保存新 profile 后
    // 用户关闭重开设置页即可看到。这里先保证表单与状态正确。
    setStatus(actionStatus)
  }

  fun selectProfile(id: String) = runBlocking {
    require(repository.list().any { it.id == id }) { "Unknown model profile: $id" }
    loadProfile(id)
  }

  fun newProfile() {
    form.id = UUID.randomUUID().toString()
    form.name = ""
    form.baseUrl = ""
    form.model = ""
    form.headers = ""
    form.timeoutMs = 30_000
    form.apiKey = ""
    baseline = form.copy(id = "")
    setStatus("")
  }

  fun saveForm(): Boolean = try {
    applyForm()
    setStatus("Profile saved: ${form.name}")
    true
  } catch (error: IllegalArgumentException) {
    setStatus("Save failed: ${error.message}")
    false
  } catch (error: IllegalStateException) {
    setStatus("Save failed: ${error.message}")
    false
  }

  fun refreshCacheStatus(): Boolean = try {
    val stats = runBlocking { cacheOperations.stats() }
    setCacheStatus("${stats.entries} entries, ${formatBytes(stats.estimatedBytes)}")
    true
  } catch (error: Exception) {
    setCacheStatus("Unavailable")
    setStatus("Cache status failed: ${error.message ?: error.javaClass.simpleName}")
    false
  }

  fun runClearCacheAction(): Boolean {
    if (!clearConfirmation.confirm()) return false
    return try {
      val before = runBlocking { cacheOperations.stats() }
      runBlocking { cacheOperations.clear() }
      refreshCacheStatus()
      setStatus("Cleared ${before.entries} cache entries")
      true
    } catch (error: Exception) {
      setStatus("Clear cache failed: ${error.message ?: error.javaClass.simpleName}")
      false
    }
  }

  /**
   * F4 导出缓存：EDT 只弹保存对话框；序列化与文件写入全部经 [BackgroundDispatcher]
   * 在后台线程执行（runBlocking 只允许出现在后台块内），结果以 balloon 反馈「已导出 N 条」。
   */
  fun runExportCacheAction(): Boolean {
    val target = transferUi.chooseExportFile() ?: return false
    background.dispatch {
      try {
        val exported = runBlocking { cacheTransfer.exportTo(target) }
        transferUi.balloon("已导出 $exported 条缓存", error = false)
      } catch (error: Exception) {
        transferUi.balloon("导出失败：${error.message ?: error.javaClass.simpleName}", error = true)
      }
    }
    return true
  }

  /**
   * F4 导入缓存：同 [runExportCacheAction] 的线程规矩；导入报告按 Chrome 选项页同款
   * 口径反馈（新增/跳过/无效丢弃），格式校验失败整体拒绝并说明原因。缓存用量标签的
   * 刷新刻意不做——它写 Swing 组件，只能留在 EDT，而结果已在后台以 balloon 呈现。
   */
  fun runImportCacheAction(): Boolean {
    val source = transferUi.chooseImportFile() ?: return false
    background.dispatch {
      try {
        when (val report = runBlocking { cacheTransfer.importFrom(source) }) {
          is ImportReport.Ok -> transferUi.balloon(
            if (report.invalid > 0) {
              "已导入 ${report.added} 条，跳过 ${report.skipped} 条，无效丢弃 ${report.invalid} 条"
            } else {
              "已导入 ${report.added} 条，跳过 ${report.skipped} 条"
            },
            error = false,
          )
          is ImportReport.Failure -> transferUi.balloon(importFailureText(report.reason), error = true)
        }
      } catch (error: Exception) {
        transferUi.balloon("导入失败：${error.message ?: error.javaClass.simpleName}", error = true)
      }
    }
    return true
  }

  /** 与 Chrome 选项页 `importFailureMessage` 同款的整体拒绝文案。 */
  private fun importFailureText(reason: String): String = when (reason) {
    "not-json" -> "导入失败：文件不是有效的 JSON。"
    "bad-format" -> "导入失败：文件格式不符，不是本插件导出的缓存文件。"
    "schema-mismatch" -> "导入失败：缓存 schema 版本不匹配，请让对方升级扩展或插件后重新导出。"
    else -> "导入失败：$reason"
  }

  fun activateForm(): Boolean {
    if (!saveForm()) return false
    return try {
      repository.setActive(form.id)
      // F5：切换激活后已开会话的新请求立即用新 profile（refreshProfile 无会话时幂等 no-op）。
      profileRefresh.refresh()
      setStatus("Profile activated: ${form.name}")
      true
    } catch (error: IllegalArgumentException) {
      setStatus("Activate failed: ${error.message}")
      false
    } catch (error: IllegalStateException) {
      setStatus("Activate failed: ${error.message}")
      false
    }
  }

  fun deleteForm(): Boolean = try {
    runBlocking { repository.delete(form.id) }
    resetForm()
    setStatus("Profile deleted")
    true
  } catch (error: IllegalArgumentException) {
    setStatus("Delete failed: ${error.message}")
    false
  }

  private suspend fun loadProfile(id: String) {
    val profile = repository.list().first { it.id == id }
    form.id = profile.id
    form.name = profile.name
    form.baseUrl = profile.baseUrl
    form.model = profile.model
    form.timeoutMs = profile.timeoutMs
    form.apiKey = repository.apiKey(profile.id).orEmpty()
    val values = repository.headerValues(profile.id)
    form.headers = profile.headerNames.sortedWith(String.CASE_INSENSITIVE_ORDER)
      .joinToString("\n") { name -> "$name: ${values[name].orEmpty()}" }
    baseline = form.copy()
  }

  fun resetForm() = runBlocking {
    val profile = repository.active() ?: repository.list().firstOrNull()
    if (profile == null) {
      form.id = "default"
      form.name = ""
      form.baseUrl = ""
      form.model = ""
      form.headers = ""
      form.timeoutMs = 30_000
      form.apiKey = ""
    } else {
      form.id = profile.id
      form.name = profile.name
      form.baseUrl = profile.baseUrl
      form.model = profile.model
      form.timeoutMs = profile.timeoutMs
      form.apiKey = repository.apiKey(profile.id).orEmpty()
      val values = repository.headerValues(profile.id)
      form.headers = profile.headerNames.sortedWith(String.CASE_INSENSITIVE_ORDER)
        .joinToString("\n") { name -> "$name: ${values[name].orEmpty()}" }
    }
    form.cacheLimitMb = profileState.state.cacheLimitMb
    form.streamRendering = profileState.state.streamRendering
    baseline = form.copy()
    actionStatus = ""
  }

  fun isFormModified(): Boolean = form != baseline

  fun applyForm() = runBlocking {
    val headers = parseHeaders(form.headers)
    val current = repository.list().firstOrNull { it.id == form.id }
    repository.save(
      ModelProfile(
        id = form.id,
        name = form.name,
        baseUrl = form.baseUrl,
        model = form.model,
        headerNames = headers.keys,
        timeoutMs = form.timeoutMs,
        jsonSchemaSupport = current?.jsonSchemaSupport ?: JsonSchemaSupport.UNKNOWN,
        streamSupport = current?.streamSupport,
        reasoningControl = current?.reasoningControl,
      ),
      apiKey = form.apiKey,
      headerValues = headers,
    )
    profileState.state.cacheLimitMb = form.cacheLimitMb
    profileState.state.streamRendering = form.streamRendering
    baseline = form.copy()
    // F5（apply 路径）：保存的正是当前激活 profile 时，已开会话的快照需要刷新——
    // 只改 baseUrl/model 等字段不换激活也算 profile 变更；保存非激活 profile 不触发。
    if (repository.active()?.id == form.id) profileRefresh.refresh()
  }

  /** 测试连接：先保存（probe 需要 PasswordSafe 里的 key），再探测端点能力。 */
  fun runConnectionAction(): Boolean {
    if (!saveForm()) return false
    val profile = runBlocking {
      repository.list().firstOrNull { it.id == form.id }
    } ?: run {
      setStatus("Test connection failed: profile not found")
      return false
    }
    val result = runBlocking { connectionProbe.probe(profile) }
    val text = if (result.success) "Test connection: ${result.message}" else "Test connection failed: ${result.message}"
    setStatus(text)
    return result.success
  }

  private fun formatBytes(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> String.format("%.1f MB", bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> String.format("%.1f KB", bytes / 1024.0)
    else -> "$bytes B"
  }

  private fun parseHeaders(value: String): Map<String, String> {
    val headers = linkedMapOf<String, String>()
    val normalizedNames = mutableSetOf<String>()
    value.lineSequence().filter(String::isNotBlank).forEach { line ->
      val separator = line.indexOf(':')
      require(separator > 0) { "Custom headers must use Name: value format" }
      val name = line.substring(0, separator).trim()
      require(normalizedNames.add(name.lowercase())) { "Custom header names must be unique" }
      headers[name] = line.substring(separator + 1).trim()
    }
    return headers
  }
}
