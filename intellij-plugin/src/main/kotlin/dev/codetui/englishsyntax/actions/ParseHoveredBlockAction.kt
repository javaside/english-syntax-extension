package dev.codetui.englishsyntax.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.session.PreviewSessionConnector
import dev.codetui.englishsyntax.session.PreviewSessionManager

/**
 * 解析鼠标悬停的段落（默认 Alt+T）。会话未启动时轻量启动，只解析悬停那一段，
 * 不触发全文扫描。
 *
 * 焦点在 JCEF 预览里时这条 Action 可能收不到按键（取决于 JCEF 是否跑在离屏渲染模式），
 * 预览页自带 keydown 兼底通道（见 `web/bootstrap-entry.ts`），两条通道汇入同一个 JS 入口。
 */
class ParseHoveredBlockAction(
  private val managerProvider: (Project) -> PreviewSessionManager? = { _ ->
      com.intellij.openapi.components.service<dev.codetui.englishsyntax.PreviewSessionManagerService>().manager
    },
  private val jcefSupported: () -> Boolean = JBCefApp::isSupported,
) : AnAction() {

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun update(event: AnActionEvent) {
    val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
    val isMarkdown = event.project != null &&
      file != null &&
      file.fileType.name.equals("Markdown", ignoreCase = true)
    // 刻意不查面板：findPanel 会 wrap + 注入 JCEF，放进高频 update() 就是假翻译回归。
    event.presentation.isEnabledAndVisible =
      PreviewActionSupport.hoverParseEnabled(isMarkdown, jcefSupported())
  }

  override fun actionPerformed(event: AnActionEvent) {
    val project = event.project ?: return
    val panel = EnglishSyntaxPreviewPanel.findPanel(project)
    if (panel == null) {
      LOGGER.warn("parseHovered: no preview panel found for project")
      ActionNotifier.warn(
        project,
        "未找到 Markdown 预览面板：请先打开一个 .md 文件的 Markdown 预览（IDEA 默认 JCEF 预览即可）",
      )
      return
    }
    val manager = runCatching { managerProvider(project) }.getOrNull()
    if (manager == null) {
      LOGGER.warn("parseHovered: manager unavailable (SQLite cache init failure lands here too)")
      ActionNotifier.warn(project, "句法学习服务不可用：请检查设置页配置")
      return
    }
    PreviewSessionConnector.parseHovered(panel, manager)
  }

  private companion object {
    private val LOGGER =
      com.intellij.openapi.diagnostic.Logger.getInstance(ParseHoveredBlockAction::class.java)
  }
}
