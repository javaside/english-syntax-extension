package dev.codetui.englishsyntax.markdown

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.jcef.JBCefApp
import org.intellij.plugins.markdown.ui.preview.MarkdownHtmlPanel
import org.intellij.plugins.markdown.ui.preview.MarkdownHtmlPanelProvider

/**
 * 注册到 `org.intellij.markdown.html.panel.provider` 的自定义预览 Provider。
 * JCEF 不可用时 UNAVAILABLE（首版不做 Swing 回退，由 UI 提示切换运行时）。
 */
class EnglishSyntaxPreviewProvider(
  private val jcefSupported: () -> Boolean = JBCefApp::isSupported,
  private val panelFactory: (Project?, VirtualFile?) -> EnglishSyntaxPreviewPanel = { project, file ->
    EnglishSyntaxPreviewPanel(project, file)
  },
) : MarkdownHtmlPanelProvider() {

  override fun createHtmlPanel(): MarkdownHtmlPanel = panelFactory(null, null)

  override fun createHtmlPanel(project: Project, virtualFile: VirtualFile): MarkdownHtmlPanel =
    panelFactory(project, virtualFile)

  override fun isAvailable(): AvailabilityInfo =
    if (jcefSupported()) AvailabilityInfo.AVAILABLE else AvailabilityInfo.UNAVAILABLE

  override fun getProviderInfo(): ProviderInfo = ProviderInfo(PROVIDER_NAME, javaClass.name)

  companion object {
    const val PROVIDER_NAME = "English Syntax Chromium Preview"
  }
}
