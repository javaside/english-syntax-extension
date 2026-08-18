package dev.codetui.englishsyntax.settings

import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.panel
import dev.codetui.englishsyntax.EnglishSyntaxBundle

class EnglishSyntaxConfigurable : BoundConfigurable(EnglishSyntaxBundle.message("settings.display.name")) {
  private val repository = service<ProfileRepository>()
  private val state = service<ProfileState>().state

  override fun createPanel() = panel {
    val profiles = repository.list()
    var selectedId = repository.active()?.id ?: profiles.firstOrNull()?.id
    group(EnglishSyntaxBundle.message("settings.profile.group")) {
      row(EnglishSyntaxBundle.message("settings.profile.active")) {
        label(repository.active()?.name ?: EnglishSyntaxBundle.message("settings.profile.none"))
      }
      row(EnglishSyntaxBundle.message("settings.profile.name")) {
        textField().align(AlignX.FILL).comment(EnglishSyntaxBundle.message("settings.profile.name.comment"))
      }
      row(EnglishSyntaxBundle.message("settings.profile.baseUrl")) { textField().align(AlignX.FILL) }
      row(EnglishSyntaxBundle.message("settings.profile.model")) { textField().align(AlignX.FILL) }
      row(EnglishSyntaxBundle.message("settings.profile.headers")) {
        textField().align(AlignX.FILL).comment(EnglishSyntaxBundle.message("settings.profile.headers.comment"))
      }
      row(EnglishSyntaxBundle.message("settings.profile.timeout")) {
        intTextField(5_000..120_000).align(AlignX.FILL)
      }
      row(EnglishSyntaxBundle.message("settings.profile.apiKey")) { passwordField().align(AlignX.FILL) }
      row {
        button(EnglishSyntaxBundle.message("settings.profile.testConnection")) {
          // HTTP probing belongs to the model client task; this control is reserved for it.
        }
        button(EnglishSyntaxBundle.message("settings.profile.activate")) {
          selectedId?.let(repository::setActive)
        }.enabled(selectedId != null)
      }
    }
    group(EnglishSyntaxBundle.message("settings.behavior.group")) {
      row(EnglishSyntaxBundle.message("settings.cache.limit")) {
        intTextField(10..200).bindIntText(state::cacheLimitMb).align(AlignX.FILL)
      }
      row { checkBox(EnglishSyntaxBundle.message("settings.streamRendering")).bindSelected(state::streamRendering) }
      row {
        button(EnglishSyntaxBundle.message("settings.cache.import")) {}
        button(EnglishSyntaxBundle.message("settings.cache.export")) {}
      }
    }
  }
}
