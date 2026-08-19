package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * 项目级会话管理：每个 preview 一个 PreviewSession（child Job 随 preview 消亡）。
 * activePreview 决定优先级映射；Profile 快照在 start 时下发。
 */
class PreviewSessionManager(
  private val scope: CoroutineScope,
  private val analysis: AnalysisServicePort,
  private val profileProvider: () -> dev.codetui.englishsyntax.settings.ModelProfile?,
) {
  private val sessions = LinkedHashMap<String, PreviewSession>()
  private val sessionJobs = LinkedHashMap<String, Job>()

  @Volatile
  var activePreviewId: String? = null

  fun obtain(
    previewId: String,
    sender: HostSender,
    blockRequester: BlockRequester,
  ): PreviewSession = sessions.getOrPut(previewId) {
    val job = Job(scope.coroutineContext[Job])
    sessionJobs[previewId] = job
    val sessionScope = CoroutineScope(scope.coroutineContext + job)
    PreviewSession(previewId, sessionScope, analysis, sender, blockRequester).also { session ->
      session.currentProfile = profileProvider()
    }
  }

  fun setActive(previewId: String) {
    activePreviewId = previewId
  }

  fun isActive(previewId: String): Boolean = activePreviewId == previewId

  fun start(previewId: String, sender: HostSender, blockRequester: BlockRequester) {
    setActive(previewId)
    obtain(previewId, sender, blockRequester).start()
  }

  fun pause(previewId: String) {
    sessions[previewId]?.pause()
  }

  fun resume(previewId: String) {
    sessions[previewId]?.resume()
  }

  fun stop(previewId: String) {
    sessions[previewId]?.stop()
  }

  fun onGenerationChanged(previewId: String, generation: Int) {
    sessions[previewId]?.onGenerationChanged(generation)
  }

  fun disposePreview(previewId: String) {
    sessions.remove(previewId)?.dispose()
    sessionJobs.remove(previewId)?.cancel()
    if (activePreviewId == previewId) activePreviewId = null
  }

  fun disposeAll() {
    sessions.keys.toList().forEach { disposePreview(it) }
  }

  fun session(previewId: String): PreviewSession? = sessions[previewId]

  /** 刷新 Profile 快照（设置变更后由调用方触发）。 */
  fun refreshProfile() {
    val profile = profileProvider()
    sessions.values.forEach { it.currentProfile = profile }
  }

  fun launchInScope(block: suspend () -> Unit) {
    scope.launch { block() }
  }
}
