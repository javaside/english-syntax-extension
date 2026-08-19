package dev.codetui.englishsyntax.actions

import dev.codetui.englishsyntax.session.PreviewSession
import dev.codetui.englishsyntax.session.PreviewSessionManager
import dev.codetui.englishsyntax.session.SessionState

/**
 * Action 与面板共用的会话状态判定与文案。纯函数，便于单测。
 */
object PreviewActionSupport {

  data class ActionAvailability(
    val startEnabled: Boolean,
    val pauseEnabled: Boolean,
    val stopEnabled: Boolean,
  )

  fun availability(session: PreviewSession?): ActionAvailability {
    val state = session?.state
    return ActionAvailability(
      startEnabled = state == null || state == SessionState.STOPPED,
      pauseEnabled = state == SessionState.RUNNING || state == SessionState.PAUSED,
      stopEnabled = state == SessionState.RUNNING || state == SessionState.PAUSED,
    )
  }

  /** Toggle 按钮文案：running → 暂停；paused → 继续；否则 → 暂停（不可用）。 */
  fun togglePauseText(state: SessionState): String = when (state) {
    SessionState.PAUSED -> "继续"
    else -> "暂停"
  }

  /** 进度文案：句法学习 ready/discovered；暂停时带“已暂停”。 */
  fun progressText(manager: PreviewSessionManager, previewId: String): String {
    val session = manager.session(previewId) ?: return ""
    val counts = session.counts
    val base = "句法学习：${counts.ready}/${counts.discovered}"
    return when (session.state) {
      SessionState.PAUSED -> "$base（已暂停）"
      else -> base
    }
  }
}
