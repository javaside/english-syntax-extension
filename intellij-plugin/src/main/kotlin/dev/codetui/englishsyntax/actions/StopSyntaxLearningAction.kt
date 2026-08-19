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
    val manager = project?.let(managerProvider)
    val state = manager?.activePreviewId?.let { manager.session(it)?.state }
    event.presentation.isEnabled = state == SessionState.RUNNING || state == SessionState.PAUSED
  }

  override fun actionPerformed(event: AnActionEvent) {
    val project = event.project ?: return
    val manager = managerProvider(project) ?: return
    val previewId = manager.activePreviewId ?: return
    manager.stop(previewId)
  }
}
