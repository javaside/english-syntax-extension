package dev.codetui.englishsyntax.settings

import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import dev.codetui.englishsyntax.EnglishSyntaxBundle
import kotlinx.coroutines.runBlocking
import java.util.UUID

class EnglishSyntaxConfigurable(
  private val repository: ProfileRepository = service(),
  private val profileState: ProfileState = service(),
) : BoundConfigurable(EnglishSyntaxBundle.message("settings.display.name")) {
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

  init {
    resetForm()
  }

  override fun createPanel() = panel {
    group(EnglishSyntaxBundle.message("settings.profile.group")) {
      row(EnglishSyntaxBundle.message("settings.profile.active")) {
        repository.list().forEach { profile ->
          button(profile.name) { selectProfile(profile.id) }
          button(EnglishSyntaxBundle.message("settings.profile.delete")) { selectProfile(profile.id); deleteForm() }
        }
        button(EnglishSyntaxBundle.message("settings.profile.new")) { newProfile() }
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
        button(EnglishSyntaxBundle.message("settings.profile.activate")) { activateForm() }.enabled(form.id.isNotBlank())
      }
    }
    group(EnglishSyntaxBundle.message("settings.behavior.group")) {
      row(EnglishSyntaxBundle.message("settings.cache.limit")) {
        intTextField(10..200).bindIntText(form::cacheLimitMb).align(AlignX.FILL)
      }
      row {
        checkBox(EnglishSyntaxBundle.message("settings.streamRendering")).bindSelected(form::streamRendering)
      }
      row {
        button(EnglishSyntaxBundle.message("settings.cache.import")) {
          actionStatus = EnglishSyntaxBundle.message("settings.status.cacheUnavailable")
        }
        button(EnglishSyntaxBundle.message("settings.cache.export")) {
          actionStatus = EnglishSyntaxBundle.message("settings.status.cacheUnavailable")
        }
      }
    }
  }

  override fun isModified(): Boolean = isFormModified()

  override fun reset() = resetForm()

  override fun apply() = applyForm()

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
  }

  fun saveForm() = applyForm()

  fun activateForm() {
    saveForm()
    repository.setActive(form.id)
    actionStatus = EnglishSyntaxBundle.message("settings.status.activated")
  }

  fun deleteForm() = runBlocking {
    repository.delete(form.id)
    resetForm()
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

  fun runConnectionAction() {
    actionStatus = EnglishSyntaxBundle.message("settings.status.connectionUnavailable")
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
