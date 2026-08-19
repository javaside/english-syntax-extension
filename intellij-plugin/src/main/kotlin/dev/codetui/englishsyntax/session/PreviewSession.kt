package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.analysis.AnalysisFailure
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.language.segmentBlock
import dev.codetui.englishsyntax.language.tokenize
import dev.codetui.englishsyntax.scheduler.SchedulerPriority
import dev.codetui.englishsyntax.settings.ModelProfile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

enum class SessionState { STOPPED, RUNNING, PAUSED }

enum class SentencePhase { DISCOVERED, CACHE_CHECK, QUEUED, REQUESTING, VALIDATING, READY, FAILED, STALE }

/** Kotlin → JS 发送端口（Panel 或假实现）。 */
fun interface HostSender {
  fun send(json: kotlinx.serialization.json.JsonObject)
}

/** 页面可见块回调。 */
fun interface BlockRequester {
  fun requestScan()
}

data class SessionCounts(
  val discovered: Int = 0,
  val ready: Int = 0,
  val failed: Int = 0,
)

/**
 * 单个预览的会话状态机：块/句注册、合批、优先级映射、generation 守卫、
 * 暂停/恢复/停止。所有对 JS 的消息经 [sender]；不含 Profile 或凭据。
 */
class PreviewSession(
  val previewId: String,
  private val scope: CoroutineScope,
  private val analysis: AnalysisServicePort,
  private val sender: HostSender,
  private val blockRequester: BlockRequester,
  private val now: () -> Long = System::currentTimeMillis,
) {
  var state: SessionState = SessionState.STOPPED
    private set

  var generation: Int = 0
    private set

  val counts: SessionCounts
    get() = SessionCounts(
      discovered = sentences.size,
      ready = sentences.values.count { it.phase == SentencePhase.READY },
      failed = sentences.values.count { it.phase == SentencePhase.FAILED },
    )

  internal val sentences = LinkedHashMap<String, SentenceRecord>()
  private val pendingBatch = mutableListOf<SentenceInput>()
  private var batchDeadline: Long = 0
  private var operationVersion = 0
  private var documentId = "$previewId-doc"
  private val pausedBlocks = mutableListOf<SentenceInput>()

  internal data class SentenceRecord(
    var phase: SentencePhase,
    val blockId: String,
    val input: SentenceInput,
  )

  fun start() {
    if (state == SessionState.RUNNING) return
    state = SessionState.RUNNING
    blockRequester.requestScan()
  }

  fun pause() {
    if (state != SessionState.RUNNING) return
    state = SessionState.PAUSED
  }

  fun resume() {
    if (state != SessionState.PAUSED) return
    state = SessionState.RUNNING
    // 重放暂停期间积累的块。
    val replay = pausedBlocks.toList()
    pausedBlocks.clear()
    replay.forEach { enqueueSentences(listOf(it), offscreen = false) }
  }

  fun stop() {
    state = SessionState.STOPPED
    operationVersion += 1
    sentences.clear()
    pendingBatch.clear()
    pausedBlocks.clear()
    scope.launch { analysis.cancelDocument(documentId) }
    sender.send(buildJsonObject {
      put("version", 1)
      put("type", "RESTORE_ALL")
      put("previewId", previewId)
      put("generation", generation)
    })
  }

  fun onGenerationChanged(newGeneration: Int) {
    if (newGeneration <= generation) return
    generation = newGeneration
    operationVersion += 1
    // 旧代次作废：取消在飞、清空记录；防抖后由下一次 VISIBLE_BLOCKS 重新驱动。
    scope.launch { analysis.cancelDocument(documentId) }
    sentences.clear()
    pendingBatch.clear()
    scope.launch {
      delay(200)
    }
  }

  /** JS 上报的可见块：分句分词并按状态合批派发。 */
  fun onVisibleBlocks(blocks: List<Pair<String, String>>, offscreen: Boolean = false) {
    if (state == SessionState.STOPPED) return
    val discovered = blocks.flatMap { (blockId, text) ->
      segmentBlock(text).mapIndexed { index, part ->
        val tokens = tokenize(part.text)
        val sentenceId = "s-${blockId}-${index}"
        SentenceInput(
          sentenceId = sentenceId,
          text = part.text,
          tokens = tokens,
        ).also {
          sentences[sentenceId] = SentenceRecord(SentencePhase.DISCOVERED, blockId, it)
        }
      }
    }
    if (discovered.isEmpty()) return
    if (state == SessionState.PAUSED) {
      pausedBlocks += discovered
      return
    }
    enqueueSentences(discovered, offscreen)
  }

  fun priorityFor(active: Boolean, offscreen: Boolean): SchedulerPriority = when {
    !offscreen && active -> SchedulerPriority.ACTIVE_VISIBLE_CORE
    !offscreen && !active -> SchedulerPriority.OTHER_VISIBLE_CORE
    else -> SchedulerPriority.ACTIVE_PREFETCH_CORE
  }

  private fun enqueueSentences(inputs: List<SentenceInput>, offscreen: Boolean) {
    pendingBatch += inputs
    val currentTime = now()
    if (batchDeadline == 0L) batchDeadline = currentTime + 120
    scope.launch {
      delay(120)
      flushBatch(offscreen)
    }
  }

  internal fun flushBatch(offscreen: Boolean) {
    if (pendingBatch.isEmpty()) return
    val batch = pendingBatch.toList()
    pendingBatch.clear()
    batchDeadline = 0
    scope.launch { dispatch(batch, offscreen) }
  }

  private suspend fun dispatch(inputs: List<SentenceInput>, offscreen: Boolean) {
    if (state != SessionState.RUNNING) return
    val capturedVersion = operationVersion
    val profile = currentProfile ?: run {
      // 无 Profile：纯缓存查询，未命中句保持原文。
      val cached = analysis.lookupCore(inputs)
      val cachedIds = cached.map { it.sentenceId }.toSet()
      inputs.forEach { input ->
        sentences[input.sentenceId]?.phase =
          if (input.sentenceId in cachedIds) SentencePhase.READY else SentencePhase.FAILED
      }
      sender.send(buildJsonObject {
        put("version", 1)
        put("type", "SESSION_STATE")
        put("previewId", previewId)
        put("generation", generation)
        put("state", "cacheOnly")
        put("ready", cached.size)
        put("discovered", inputs.size)
      })
      return
    }

    inputs.forEach { sentences[it.sentenceId]?.phase = SentencePhase.QUEUED }
    val outcome: CoreBatchOutcome = analysis.analyzeCore(
      profile = profile,
      documentId = documentId,
      sentences = inputs,
      priority = priorityFor(active = true, offscreen = offscreen),
    )
    if (capturedVersion != operationVersion) return
    applyOutcome(outcome)
  }

  internal fun applyOutcome(outcome: CoreBatchOutcome) {
    outcome.result.forEach { analysis ->
      sentences[analysis.sentenceId]?.phase = SentencePhase.READY
      sender.send(buildJsonObject {
        put("version", 1)
        put("type", "CORE_RESULT")
        put("previewId", previewId)
        put("generation", generation)
        put("sentenceId", analysis.sentenceId)
        put("blockId", sentences[analysis.sentenceId]?.blockId ?: "")
        put("analysisJson", analysisToJson(analysis))
      })
    }
    outcome.failures.forEach { failure: AnalysisFailure ->
      sentences[failure.sentenceId]?.phase = SentencePhase.FAILED
      sender.send(buildJsonObject {
        put("version", 1)
        put("type", "CORE_ERROR")
        put("previewId", previewId)
        put("generation", generation)
        put("sentenceId", failure.sentenceId)
        put("blockId", sentences[failure.sentenceId]?.blockId ?: "")
        put("code", failure.error.code.name)
        put("message", failure.error.message ?: "failed")
      })
    }
  }

  /** 详解点击：detail 优先级由 AnalysisService 内部固定。 */
  suspend fun onDetailRequest(sentenceId: String, focusStart: Int, focusEnd: Int) {
    val record = sentences[sentenceId] ?: return
    if (state == SessionState.STOPPED) return
    val profile = currentProfile ?: return
    val core = dev.codetui.englishsyntax.domain.CoreAnalysis(
      sentenceId = sentenceId,
      components = emptyList(),
      modelProfileId = profile.id,
    )
    val detail = analysis.analyzeDetail(
      profile = profile,
      documentId = documentId,
      sentence = record.input,
      core = core,
      focus = TokenRange(focusStart, focusEnd),
    )
    sender.send(buildJsonObject {
      put("version", 1)
      put("type", "DETAIL_RESULT")
      put("previewId", previewId)
      put("generation", generation)
      put("sentenceId", sentenceId)
      put("analysisJson", detailJson(detail.result))
    })
  }

  /** 当前 Profile 由 Manager 注入（会话层不持凭据）。 */
  internal var currentProfile: ModelProfile? = null

  fun dispose() {
    state = SessionState.STOPPED
    operationVersion += 1
    sentences.clear()
    pendingBatch.clear()
  }

  private fun analysisToJson(analysis: CoreAnalysis): String {
    val components = analysis.components.joinToString(",") { component ->
      """{"startToken":${component.startToken},"endToken":${component.endToken},"role":"${component.role.name}","translation":${JsonPrimitive(component.translation)}}"""
    }
    return """{"sentenceId":"${analysis.sentenceId}","components":[$components]}"""
  }

  private fun detailJson(detail: dev.codetui.englishsyntax.domain.DetailAnalysis): String {
    val structures = detail.structures.joinToString(",") { structure ->
      """{"startToken":${structure.startToken},"endToken":${structure.endToken},"role":${JsonPrimitive(structure.role)},"explanation":${JsonPrimitive(structure.explanation)}${structure.translation?.let { ",\"translation\":${JsonPrimitive(it)}" } ?: ""}}"""
    }
    return """{"sentenceId":"${detail.sentenceId}","focus":{"startToken":${detail.focus.startToken},"endToken":${detail.focus.endToken}},"structures":[$structures],"explanation":${JsonPrimitive(detail.explanation)}}"""
  }
}
