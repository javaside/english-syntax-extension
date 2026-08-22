package dev.codetui.englishsyntax.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewPanel
import dev.codetui.englishsyntax.session.PreviewSessionManager
import dev.codetui.englishsyntax.session.SessionState

/** 停止并恢复原文：取消 document、发送 RESTORE_ALL、清空卡片。 */
class StopSyntaxLearningAction(
  private val managerProvider: (com.intellij.openapi.project.Project) -> PreviewSessionManager? = { _ ->
      com.intellij.openapi.components.service<dev.codetui.englishsyntax.PreviewSessionManagerService>().manager
    },
) : AnAction() {

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun update(event: AnActionEvent) {
    val project = event.project
    val manager = project?.let { runCatching { managerProvider(it) }.getOrNull() }
    // 只看当前文件自己的会话，不受其它文件会话影响——多文件可并行翻译。
    val session = project?.let { panel(it) }?.let { panel -> manager?.session(panel.previewId) }
    event.presentation.isEnabled = session?.state == SessionState.RUNNING || session?.state == SessionState.PAUSED
  }

  override fun actionPerformed(event: AnActionEvent) {
    val project = event.project ?: return
    val manager = runCatching { managerProvider(project) }.getOrNull()
    if (manager == null) {
      ActionNotifier.warn(project, "句法学习服务不可用：请检查设置页配置")
      return
    }
    val panel = panel(project)
    if (panel == null) {
      ActionNotifier.warn(project, "当前没有可用的 Markdown 预览面板")
      return
    }
    val previewId = panel.previewId
    val session = manager.session(previewId)
    if (session == null) {
      ActionNotifier.warn(project, "当前文件尚未开始句法学习")
      return
    }
    manager.stop(previewId)
  }

  /** 当前文件面板：与 Start 共用 findPanel 定位逻辑。 */
  private fun panel(project: com.intellij.openapi.project.Project): EnglishSyntaxPreviewPanel? =
    EnglishSyntaxPreviewPanel.findPanel(project)
}
