package dev.codetui.englishsyntax.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.session.HostSender
import dev.codetui.englishsyntax.session.PreviewSessionManager

/**
 * 开始句法学习。JCEF 不支持时不可用（由 notification 提示切换运行时）。
 * 面板定位只走 FileEditorManager 的 selected editor，不做 Swing 全局扫描。
 */
class StartSyntaxLearningAction(
  private val managerProvider: (Project) -> PreviewSessionManager? = { _ ->
      com.intellij.openapi.components.service<dev.codetui.englishsyntax.PreviewSessionManagerService>().manager
    },
  private val jcefSupported: () -> Boolean = JBCefApp::isSupported,
) : AnAction() {

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun update(event: AnActionEvent) {
    val project = event.project
    val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
    val presentation = event.presentation
    presentation.isEnabledAndVisible = project != null &&
      file != null &&
      file.fileType.name.equals("Markdown", ignoreCase = true) &&
      jcefSupported()
  }

  override fun actionPerformed(event: AnActionEvent) {
    val project = event.project ?: return
    val panel = currentPanel(project)
    if (panel == null) {
      ActionNotifier.warn(
        project,
        "未找到句法预览面板：请确认当前 Markdown 预览由 English Syntax 插件的 JCEF 面板提供",
      )
      return
    }
    val manager = runCatching { managerProvider(project) }.getOrNull()
    if (manager == null) {
      ActionNotifier.warn(project, "句法学习服务不可用：请检查设置页配置（SQLite 缓存初始化失败时也会走到这里）")
      return
    }
    manager.start(panel.previewId, HostSender { panel.send(it) }) {
      // JS 侧扫描入口：setHtml 后的 initialize 脚本驱动 scanMarkdownBlocks → VISIBLE_BLOCKS。
      panel.onPageMessage("""{"version":1,"type":"PREVIEW_READY","previewId":"${panel.previewId}","generation":${panel.generation}}""")
    }
  }

  internal fun currentPanel(project: Project): EnglishSyntaxPreviewPanel? {
    val editor = FileEditorManager.getInstance(project).selectedEditor ?: return null
    return (editor as? EnglishSyntaxPreviewPanel)
  }
}
