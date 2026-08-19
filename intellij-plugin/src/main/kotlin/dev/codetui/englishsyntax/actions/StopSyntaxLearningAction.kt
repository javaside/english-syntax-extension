package dev.codetui.englishsyntax.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
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
    val state = manager?.activePreviewId?.let { manager.session(it)?.state }
    event.presentation.isEnabled = state == SessionState.RUNNING || state == SessionState.PAUSED
  }

  override fun actionPerformed(event: AnActionEvent) {
    val project = event.project ?: return
    val manager = runCatching { managerProvider(project) }.getOrNull()
    if (manager == null) {
      ActionNotifier.warn(project, "句法学习服务不可用：请检查设置页配置")
      return
    }
    val previewId = manager.activePreviewId
    if (previewId == null) {
      ActionNotifier.warn(project, "当前没有进行中的句法学习会话")
      return
    }
    manager.stop(previewId)
  }
}
