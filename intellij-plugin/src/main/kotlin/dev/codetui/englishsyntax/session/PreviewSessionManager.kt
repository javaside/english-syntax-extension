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

  /** F3 绕缓存整屏重析：仅会话 RUNNING 时生效（会话内部自判，非 RUNNING 静默拒）。 */
  fun reanalyzeAll(previewId: String) {
    sessions[previewId]?.reanalyzeAll()
  }

  fun onGenerationChanged(previewId: String, generation: Int) {
    sessions[previewId]?.onGenerationChanged(generation)
  }

  fun disposePreview(previewId: String) {
    // chat 命名空间的取消必须走 **manager 自己的长命 scope**：若在 session scope 里 launch，
    // 会与紧随其后的 session job.cancel() 竞速（launch 尚未执行就被取消 → 静默 no-op），
    // 面板关走后在飞的流式回答就会占住并发槽直到静默超时。documentId = "$previewId-doc"
    // 是确定性派生（PreviewSession 构造处同款），先于 session job cancel 发出。
    // core 命名空间在 dispose 路径上的既有缺口不在追问对话范围（观察项）。
    scope.launch { analysis.cancelDocument("$previewId-doc:chat") }
    sessions.remove(previewId)?.dispose()
    sessionJobs.remove(previewId)?.cancel()
    if (activePreviewId == previewId) activePreviewId = null
  }

  /** 测试可见：preview 会话的 Job（钉住 disposePreview「先取消 chat 命名空间、后取消 job」的顺序）。 */
  internal fun sessionJobForTest(previewId: String): Job? = sessionJobs[previewId]

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
