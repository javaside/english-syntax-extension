package dev.codetui.englishsyntax.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import dev.codetui.englishsyntax.session.PreviewSessionManager
import dev.codetui.englishsyntax.session.SessionState

/** 暂停/继续切换：文案随会话状态变化，由 update 驱动。 */
class TogglePauseSyntaxLearningAction(
  private val managerProvider: (com.intellij.openapi.project.Project) -> PreviewSessionManager? = { _ ->
      com.intellij.openapi.components.service<dev.codetui.englishsyntax.PreviewSessionManagerService>().manager
    },
) : AnAction() {

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

  override fun update(event: AnActionEvent) {
    val project = event.project
    val manager = project?.let { runCatching { managerProvider(it) }.getOrNull() }
    val session = manager?.activePreviewId?.let { manager.session(it) }
    event.presentation.isEnabled = session?.state == SessionState.RUNNING || session?.state == SessionState.PAUSED
    session?.let { event.presentation.text = PreviewActionSupport.togglePauseText(it.state) }
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
    when (manager.session(previewId)?.state) {
      SessionState.RUNNING -> manager.pause(previewId)
      SessionState.PAUSED -> manager.resume(previewId)
      else -> Unit
    }
  }
}
