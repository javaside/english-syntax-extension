package dev.codetui.englishsyntax.settings

import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import dev.codetui.englishsyntax.EnglishSyntaxBundle
import dev.codetui.englishsyntax.PreviewSessionManagerService
import kotlinx.coroutines.runBlocking
import java.util.UUID

class EnglishSyntaxConfigurable(
  private val repository: ProfileRepository = service(),
  private val profileState: ProfileState = service(),
  private val connectionProbe: ConnectionProbe = ServiceConnectionProbe(),
) : BoundConfigurable(EnglishSyntaxBundle.message("settings.display.name")) {

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
  private var baseline = form.copy()

  /** 状态反馈可见组件；createPanel 时绑定。 */
  private var statusLabel: javax.swing.JLabel? = null

  private fun setStatus(text: String) {
    actionStatus = text
    statusLabel?.text = text
  }

  init {
    resetForm()
  }

  override fun createPanel() = panel {
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

  fun activateForm(): Boolean {
    if (!saveForm()) return false
    return try {
      repository.setActive(form.id)
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
