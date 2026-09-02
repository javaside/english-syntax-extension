package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.analysis.AnalysisFailure
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.StreamedComponentSink
import dev.codetui.englishsyntax.analysis.StreamedStructureSink
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
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
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

enum class SessionState { STOPPED, RUNNING, PAUSED }

private val LOGGER = com.intellij.openapi.diagnostic.Logger.getInstance(PreviewSession::class.java)

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
    var core: CoreAnalysis? = null,
  )

  fun start() {
    // 已在 RUNNING（翻译过但失败句仍在）：点「开始」仍应重新触发一次扫描上报，
    // 让失败句（phase=FAILED）有机会重派，而不是静默 return、页面无反应。
    if (state == SessionState.RUNNING) {
      blockRequester.requestScan()
      return
    }
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
    if (state == SessionState.STOPPED) {
      LOGGER.warn("onVisibleBlocks: ${blocks.size} blocks dropped, session STOPPED (start order bug?)")
      return
    }
    LOGGER.info("onVisibleBlocks: ${blocks.size} blocks, state=$state")
    val fresh = registerFresh(blocks)
    if (fresh.isEmpty()) return
    if (state == SessionState.PAUSED) {
      pausedBlocks += fresh
      return
    }
    enqueueSentences(fresh, offscreen)
  }

  /**
   * 分句分词 + 注册 [SentenceRecord]，返回「尚未出结果、需要派发」的句子。
   *
   * 关键防环：只对尚未出结果的句子注册/入队。我们的渲染也是 DOM 变更，会触发 JS 侧
   * MutationObserver → rescan → 再次 VISIBLE_BLOCKS——若这里无条件把 READY 句重置为
   * DISCOVERED，就形成「缓存命中 → 再发 CORE_RESULT → 再触发 rescan」的无限循环
   * （CPU 狂转、请求风暴）。首次到达的句子才注册记录。
   */
  private fun registerFresh(blocks: List<Pair<String, String>>): List<SentenceInput> {
    val discovered = blocks.flatMap { (blockId, text) ->
      segmentBlock(text).mapIndexed { index, part ->
        SentenceInput(
          sentenceId = "s-${blockId}-${index}",
          text = part.text,
          tokens = tokenize(part.text),
        )
      }
    }
    return discovered.filter { input ->
      when (sentences[input.sentenceId]?.phase) {
        null -> {
          sentences[input.sentenceId] =
            SentenceRecord(SentencePhase.DISCOVERED, blockIdOf(blocks, input.sentenceId), input)
          true
        }
        // 保留原记录（含 token 供成分回填），允许重新派发
        SentencePhase.FAILED, SentencePhase.STALE -> true
        else -> false
      }
    }
  }

  /**
   * 显式手势：只解析指定的一段（快捷键悬停解析）。
   *
   * 会话未启动时**轻量启动**——置 RUNNING 但不触发全文扫描（JS 侧 `autoScan = false`
   * 保证 rescan 只注册不上报）。不合批、不绕缓存、穿透暂停，与 Chrome 端
   * `queueVisibleBlock(id, force = true)` 同构。
   *
   * 刻意绕开 [enqueueSentences]：`pendingBatch` 是共享的，`offscreen`/`allowPaused`
   * 按「最后一次入队者」取值，把显式块混进合批会让同批的普通块也拿到 allowPaused；
   * 单块派发本来也没有合批收益。
   */
  fun parseExplicitBlock(blockId: String, text: String) {
    if (state == SessionState.STOPPED) state = SessionState.RUNNING
    val fresh = registerFresh(listOf(blockId to text))
    if (fresh.isEmpty()) {
      replayBlock(blockId)
      return
    }
    LOGGER.info("parseExplicitBlock: blockId=$blockId sentences=${fresh.size} state=$state")
    scope.launch { dispatch(fresh, offscreen = false, allowPaused = true) }
  }

  /**
   * 这一段没有任何需要派发的句子（整段已 READY）——**不能就这么返回**。
   *
   * 页面在按下快捷键的那一刻就已经打上「解析中」竖条 + 「正在解析 1 段…」浮层，撤掉它的
   * 唯一信号是该块的 `CORE_RESULT` / `CORE_ERROR`。静默返回的真机症状就是「同一段再按一次
   * 快捷键，从此永远停在翻译状态」。所以把已存的权威结果原样重发一遍:走的是与首次完全
   * 相同的 [applyOutcome]，页面因此既撤掉标记、又能把渲染器里被清掉的句子映射补回来
   * （JS 侧 `registerBlock` 重注册会清空旧句子，卡片还在但点不动）。
   *
   * 不构成「渲染 → rescan → 再派发」的环:重发不调模型，且 JS 侧按段路径 `autoScan=false`
   * 不上报 `VISIBLE_BLOCKS`;整篇模式下上报回来的 READY 句也会被 [registerFresh] 挡掉。
   *
   * 一句可重发的都没有（全在飞:QUEUED/REQUESTING/VALIDATING）时只记日志——在飞请求自己
   * 的结果会撤掉标记，这里再补一条反而会把同一句发两遍。
   */
  private fun replayBlock(blockId: String) {
    val stored = sentences.values
      .filter { it.blockId == blockId && it.phase == SentencePhase.READY }
      .mapNotNull { it.core }
    if (stored.isEmpty()) {
      LOGGER.info("parseExplicitBlock: blockId=$blockId nothing fresh and nothing stored (in flight?)")
      return
    }
    LOGGER.info("parseExplicitBlock: blockId=$blockId already analysed, replaying ${stored.size} sentences")
    applyOutcome(CoreBatchOutcome(stored, emptyList(), cacheHit = true))
  }

  private fun blockIdOf(blocks: List<Pair<String, String>>, sentenceId: String): String {
    // sentenceId 形如 s-{blockId}-{index}；blockId 本身含连字符，从 blocks 里反查最稳。
    val prefix = sentenceId.removePrefix("s-")
    return blocks.firstOrNull { (blockId, _) -> prefix.startsWith("$blockId-") }?.first
      ?: prefix.substringBeforeLast("-")
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

  /** 用户显式重试：不合批、直接以 USER_RETRY 最高优先级派发（与 Chrome 端约定一致）。 */
  private fun enqueueRetry(input: SentenceInput) {
    sentences[input.sentenceId]?.phase = SentencePhase.QUEUED
    scope.launch { dispatchRetry(input) }
  }

  private suspend fun dispatchRetry(input: SentenceInput) {
    if (state != SessionState.RUNNING && state != SessionState.PAUSED) return
    val profile = currentProfile ?: return
    val capturedVersion = operationVersion
    val outcome: CoreBatchOutcome = analysis.analyzeCore(
      profile = profile,
      documentId = documentId,
      sentences = listOf(input),
      priority = SchedulerPriority.USER_RETRY,
      bypassCache = true,
    )
    if (capturedVersion != operationVersion) return
    applyOutcome(outcome)
  }

  internal fun flushBatch(offscreen: Boolean) {
    if (pendingBatch.isEmpty()) return
    val batch = pendingBatch.toList()
    pendingBatch.clear()
    batchDeadline = 0
    scope.launch { dispatch(batch, offscreen) }
  }

  private suspend fun dispatch(inputs: List<SentenceInput>, offscreen: Boolean, allowPaused: Boolean = false) {
    // 普通路径行为不变（PAUSED 直接返回）；只有显式手势传 allowPaused = true 穿透。
    if (state == SessionState.STOPPED) return
    if (state == SessionState.PAUSED && !allowPaused) return
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
    LOGGER.info("dispatch: ${inputs.size} sentences, profile=${profile.id}, priority=${priorityFor(active = true, offscreen = offscreen)}")
    // 流式接线：分片一到就回推 CORE_STREAM，JS 侧立即渲染成分（Chrome 端同款）。
    // 曾漏传 onStreamedComponent → 全程走非流式 completeJson，等整批返回才渲染——
    // 表现为「翻译很慢、页面不动、没有进度」。
    val outcome: CoreBatchOutcome = try {
      analysis.analyzeCore(
        profile = profile,
        documentId = documentId,
        sentences = inputs,
        priority = priorityFor(active = true, offscreen = offscreen),
        onStreamedComponent = StreamedComponentSink { sentenceId, components ->
          // 非 STOPPED 即可回推：applyOutcome 本来就不看暂停（在飞请求的最终结果照样
          // 渲染），分片却被丢掉，表现为「暂停后卡片突然整块冒出来、没有流式过程」。
          if (state != SessionState.STOPPED && capturedVersion == operationVersion) {
            sender.send(buildJsonObject {
              put("version", 1)
              put("type", "CORE_STREAM")
              put("previewId", previewId)
              put("generation", generation)
              put("sentenceId", sentenceId)
              put("blockId", sentences[sentenceId]?.blockId ?: "")
              put("componentsJson", componentsJson(sentenceId, components))
              put("tokensJson", tokensJson(sentenceId))
            })
          }
        },
      )
    } catch (error: Throwable) {
      if (error is kotlinx.coroutines.CancellationException) throw error
      if (capturedVersion != operationVersion) return
      LOGGER.warn("dispatch: analyzeCore threw, marking batch as failed: ${error.message}")
      val failure = AnalysisFailure(
        inputs.first().sentenceId,
        ExtensionFailure(
          ErrorCode.NETWORK_ERROR,
          error.message ?: "model request failed",
          true,
        ),
      )
      applyOutcome(CoreBatchOutcome(emptyList(), inputs.map { input ->
        failure.copy(sentenceId = input.sentenceId)
      }, cacheHit = false))
      return
    }
    if (capturedVersion != operationVersion) return
    LOGGER.info("dispatch: outcome ready=${outcome.result.size} failed=${outcome.failures.size} cacheHit=${outcome.cacheHit}")
    applyOutcome(outcome)
  }

  internal fun applyOutcome(outcome: CoreBatchOutcome) {
    outcome.result.forEach { analysis ->
      sentences[analysis.sentenceId]?.let { record ->
        record.phase = SentencePhase.READY
        record.core = analysis
      }
      sender.send(buildJsonObject {
        put("version", 1)
        put("type", "CORE_RESULT")
        put("previewId", previewId)
        put("generation", generation)
        put("sentenceId", analysis.sentenceId)
        put("blockId", sentences[analysis.sentenceId]?.blockId ?: "")
        put("analysisJson", analysisToJson(analysis))
        put("tokensJson", tokensJson(analysis.sentenceId))
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
        put("tokensJson", tokensJson(failure.sentenceId))
      })
    }
    // 进度回推：每批结果落地后同步一句 SESSION_STATE，让预览页浮层能显示
    // ready/discovered（翻译到哪段）。此前只在 cacheOnly 分支发过，正常翻译路径
    // 从不发，导致 JS 侧只有「已处理 N 句」没有整体进度。
    sender.send(buildJsonObject {
      put("version", 1)
      put("type", "SESSION_STATE")
      put("previewId", previewId)
      put("generation", generation)
      put("state", state.name.lowercase())
      put("ready", counts.ready)
      put("discovered", counts.discovered)
      put("failed", counts.failed)
    })
  }

  /** 详解点击：detail 优先级由 AnalysisService 内部固定。 */
  suspend fun onDetailRequest(sentenceId: String, focusStart: Int, focusEnd: Int) {
    val record = sentences[sentenceId] ?: return
    if (state == SessionState.STOPPED) return
    val profile = currentProfile ?: return
    val core = record.core ?: return
    val capturedVersion = operationVersion
    val detail = analysis.analyzeDetail(
      profile = profile,
      documentId = documentId,
      sentence = record.input,
      core = core,
      focus = TokenRange(focusStart, focusEnd),
      onStreamedStructure = StreamedStructureSink { sentenceId, focus, structures ->
        if (state == SessionState.RUNNING && capturedVersion == operationVersion) {
          sender.send(buildJsonObject {
            put("version", 1)
            put("type", "DETAIL_STREAM")
            put("previewId", previewId)
            put("generation", generation)
            put("sentenceId", sentenceId)
            put("focusStart", focus.startToken)
            put("focusEnd", focus.endToken)
            put("structuresJson", structuresJson(sentenceId, structures))
          })
        }
      },
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

  /** 桥接层入口：详解请求经 session scope 派发（onPageMessage 在 JCEF 线程回调）。 */
  fun launchDetailRequest(sentenceId: String, focusStart: Int, focusEnd: Int) {
    if (state == SessionState.STOPPED) return
    scope.launch {
      runCatching { onDetailRequest(sentenceId, focusStart, focusEnd) }
        .onFailure { error ->
          sender.send(buildJsonObject {
            put("version", 1)
            put("type", "CORE_ERROR")
            put("previewId", previewId)
            put("generation", generation)
            put("sentenceId", sentenceId)
            put("blockId", sentences[sentenceId]?.blockId ?: "")
            put("code", "DETAIL_FAILED")
            put("message", error.message ?: "detail request failed")
            put("tokensJson", tokensJson(sentenceId))
          })
        }
    }
  }

  /** 重试：FAILED 句以 USER_RETRY 最高优先级重新请求（用户显式手势，绕过缓存）。 */
  fun retrySentence(sentenceId: String) {
    if (state != SessionState.RUNNING && state != SessionState.PAUSED) return
    val record = sentences[sentenceId] ?: return
    if (record.phase != SentencePhase.FAILED) return
    enqueueRetry(record.input)
  }

  /** 当前 Profile 由 Manager 注入（会话层不持凭据）。 */
  internal var currentProfile: ModelProfile? = null

  fun dispose() {
    state = SessionState.STOPPED
    operationVersion += 1
    sentences.clear()
    pendingBatch.clear()
  }

  /** 源 Token JSON：JCEF 按覆盖间隙恢复破折号、逗号等未覆盖标点。 */
  private fun tokensJson(sentenceId: String): String = buildJsonArray {
    sentences[sentenceId]?.input?.tokens?.forEach { token ->
      add(buildJsonObject {
        put("id", token.id)
        put("text", token.text)
        put("leadingWhitespace", token.leadingWhitespace)
        put("punctuation", token.punctuation)
      })
    }
  }.toString()

  /** 流式分片 JSON：JS 端 renderCoreStream 直接 parse 为 ComponentPayload[]。 */
  private fun componentsJson(sentenceId: String, components: List<CoreComponent>): String =
    buildJsonArray {
      components.forEach { component ->
        add(
          buildJsonObject {
            put("startToken", component.startToken)
            put("endToken", component.endToken)
            put("role", component.role.name)
            put("translation", component.translation)
            put("text", componentText(sentenceId, component.startToken, component.endToken))
          },
        )
      }
    }.toString()

  private fun analysisToJson(analysis: CoreAnalysis): String {
    val components = analysis.components.joinToString(",") { component ->
      val text = componentText(analysis.sentenceId, component.startToken, component.endToken)
      """{"startToken":${component.startToken},"endToken":${component.endToken},"role":"${component.role.name}","translation":${JsonPrimitive(component.translation)},"text":${JsonPrimitive(text)}}"""
    }
    return """{"sentenceId":"${analysis.sentenceId}","components":[$components]}"""
  }

  /** 成分英文原文：按 token 区间拼接（渲染层三行对照的英文行依赖它，缺失时卡片只剩角色+译文）。 */
  private fun componentText(sentenceId: String, startToken: Int, endToken: Int): String {
    val record = sentences[sentenceId] ?: return ""
    val tokens = record.input.tokens
    if (startToken < 0 || endToken >= tokens.size || endToken < startToken) return ""
    return tokens.subList(startToken, endToken + 1).joinToString("") { token ->
      token.leadingWhitespace + token.text
    }
  }

  /** 流式详解结构 JSON：JS 端 renderDetailStream 直接 parse。 */
  private fun structuresJson(sentenceId: String, structures: List<DetailStructure>): String =
    buildJsonArray {
      structures.forEach { structure ->
        add(
          buildJsonObject {
            put("startToken", structure.startToken)
            put("endToken", structure.endToken)
            put("role", structure.role)
            put("explanation", structure.explanation)
            structure.translation?.let { put("translation", it) }
            put("text", componentText(sentenceId, structure.startToken, structure.endToken))
          },
        )
      }
    }.toString()

  private fun detailJson(detail: dev.codetui.englishsyntax.domain.DetailAnalysis): String {
    val structures = detail.structures.joinToString(",") { structure ->
      """{"startToken":${structure.startToken},"endToken":${structure.endToken},"role":${JsonPrimitive(structure.role)},"explanation":${JsonPrimitive(structure.explanation)}${structure.translation?.let { ",\"translation\":${JsonPrimitive(it)}" } ?: ""},"text":${JsonPrimitive(componentText(detail.sentenceId, structure.startToken, structure.endToken))}}"""
    }
    val grammarPoints = detail.grammarPoints.joinToString(",") { JsonPrimitive(it).toString() }
    return """{"sentenceId":"${detail.sentenceId}","focus":{"startToken":${detail.focus.startToken},"endToken":${detail.focus.endToken}},"structures":[$structures],"grammarPoints":[$grammarPoints],"explanation":${JsonPrimitive(detail.explanation)}}"""
  }
}
