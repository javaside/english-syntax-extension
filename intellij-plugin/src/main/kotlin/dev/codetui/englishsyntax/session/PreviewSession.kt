package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.analysis.AnalysisFailure
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.StreamedComponentSink
import dev.codetui.englishsyntax.analysis.StreamedStructureSink
import dev.codetui.englishsyntax.analysis.StreamedTextSink
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.language.segmentBlock
import dev.codetui.englishsyntax.language.tokenize
import dev.codetui.englishsyntax.model.ChatTurn
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

/**
 * F6 暂停分支的 AUTH_FAILED 文案（与 Chrome ERROR_MESSAGES[AUTH_FAILED] 逐字一致）。
 * CORE_ERROR 的 code 字段才是 web 侧友好文案的判据，这里主要进日志与 CHAT/FEEDBACK_ERROR。
 */
private const val AUTH_FAILED_MESSAGE = "模型档案鉴权失败，更新凭据后才会恢复"

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
  /** F6 AUTH_FAILED 暂停表；默认「永不暂停」的空表（未接线时门直通，测试用）。 */
  private val pauseRegistry: ProfilePauseRegistry = ProfilePauseRegistry { null },
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

  /**
   * F3 会话级一次性绕缓存标志：[reanalyzeAll] 置位，[flushBatch] 冲批时消费（取走即
   * 复位）——onVisibleBlocks → dispatch 路径现状不带 bypass（只有 dispatchRetry 带），
   * 这里把标志插进该收口。stop/换代会把挂起的重析操作作废，标志随之复位。
   */
  private var bypassCacheOnce = false

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
    bypassCacheOnce = false
    sentences.clear()
    pendingBatch.clear()
    pausedBlocks.clear()
    scope.launch {
      analysis.cancelDocument(documentId)
      // chat 走「<documentId>:chat」独立命名空间（cancelDocument 精确匹配）：不追加这行，
      // stop 后在飞的流式回答会占住并发槽直到静默超时（Chrome 端 port onDisconnect /
      // cancelTab 追加同款取消的教训）。
      analysis.cancelDocument("${documentId}:chat")
    }
    sender.send(buildJsonObject {
      put("version", 1)
      put("type", "RESTORE_ALL")
      put("previewId", previewId)
      put("generation", generation)
    })
  }

  /**
   * F3 重新解析全部段落（绕过缓存）：Chrome `REANALYZE_VISIBLE` 的 IDE 等价物
   * （IntelliJ 无视口概念，全量扫描本就一次上报）。仅 RUNNING 可用（stopped 拒，
   * 对齐 Chrome；PAUSED 也非 RUNNING）。
   *
   * 顺序不可换（评审 B4 钉死）：
   * ① **先**升 operationVersion 并取消在飞批——[applyOutcome] 自身无版本守卫，旧批
   *   返回会把刚失效的句标回 READY，而 [registerFresh] 对 READY 不放行、重扫会跳过
   *   它们 → 静默漏译。镜像 [stop] 的取消（释放调度槽），但**不改 state、不发
   *   RESTORE_ALL**；顺带清掉 pendingBatch，别让还在 120ms 合批窗口里的句子以
   *   「不绕缓存」的旧姿态溜出去。
   * ② 全量失效：phase→STALE（registerFresh 对 STALE 放行，READY+FAILED 一并重派）、
   *   core 清空（旧成分不得被 detail/chat/纠正继续引用）。
   * ③ 置一次性 [bypassCacheOnce] 标志。
   * ④ `requestScan()` 重驱扫描（**同 generation**）：panel.requestScan →
   *   `__englishSyntaxInitialize` 重置指纹 → 页面重报 VISIBLE_BLOCKS → requesting
   *   竖条由此重闪。web 侧**无新消息**（重派走既有 CORE_RESULT/CORE_ERROR）。
   */
  fun reanalyzeAll() {
    if (state != SessionState.RUNNING) return
    operationVersion += 1
    pendingBatch.clear()
    scope.launch { analysis.cancelDocument(documentId) }
    sentences.values.forEach { record ->
      record.phase = SentencePhase.STALE
      record.core = null
    }
    bypassCacheOnce = true
    blockRequester.requestScan()
    LOGGER.info("reanalyzeAll: invalidated ${sentences.size} sentences (generation=$generation, bypass next dispatch)")
  }

  fun onGenerationChanged(newGeneration: Int) {
    if (newGeneration <= generation) return
    generation = newGeneration
    operationVersion += 1
    // 换代作废挂起的重析操作：新代次的首轮扫描不得继承 bypass 标志。
    bypassCacheOnce = false
    // 旧代次作废：取消在飞（含 chat 命名空间）、清空记录；防抖后由下一次 VISIBLE_BLOCKS 重新驱动。
    scope.launch {
      analysis.cancelDocument(documentId)
      analysis.cancelDocument("${documentId}:chat")
    }
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
    // F6 暂停门与普通 dispatch 同款：重试是绕缓存手势，但暂停优先——命中缓存照回，
    // 未命中句 AUTH_FAILED，绝不重发模型请求。
    pausedCoreOutcome(profile, listOf(input))?.let {
      applyOutcome(it)
      return
    }
    val capturedVersion = operationVersion
    // 异常兜底与 dispatch 同款（终审 F-1）：会话入口都是普通 child Job 上的 scope.launch，
    // analyzeCore 抛非取消异常一旦逸散就取消整个会话 Job——state 仍 RUNNING 而后续派发
    // 全部静默 no-op（会话假死到面板重建）。取消照常重抛（保持 stop/换代语义）；AUTH_FAILED
    // 走缓存兜底，其余折成 NETWORK_ERROR 终态。
    val outcome: CoreBatchOutcome = try {
      analysis.analyzeCore(
        profile = profile,
        documentId = documentId,
        sentences = listOf(input),
        priority = SchedulerPriority.USER_RETRY,
        bypassCache = true,
      )
    } catch (error: Throwable) {
      if (error is kotlinx.coroutines.CancellationException) throw error
      if (capturedVersion != operationVersion) return
      // F6 记账（dispatch catch 同款防御位）：抛出的 AUTH_FAILED 同样挂起 profile。
      recordAuthFailureIfAny(profile, error)
      if (error is ExtensionFailure && error.code == ErrorCode.AUTH_FAILED) {
        // Chrome 同款 cacheWithAuthError：缓存命中照回 + 未命中句 AUTH_FAILED。
        applyOutcome(cacheFallbackOutcome(listOf(input)))
        return
      }
      LOGGER.warn("dispatchRetry: analyzeCore threw, marking sentence as failed: ${error.message}")
      applyOutcome(
        CoreBatchOutcome(
          emptyList(),
          listOf(
            AnalysisFailure(
              input.sentenceId,
              ExtensionFailure(ErrorCode.NETWORK_ERROR, error.message ?: "model request failed", true),
            ),
          ),
          cacheHit = false,
        ),
      )
      return
    }
    if (capturedVersion != operationVersion) return
    // F6 记账（与批 dispatch 同款对称）：重试结果 AUTH_FAILED → 上报暂停表，后续重试
    // 走上面的暂停门，不再对死凭据白发请求（Chrome 重发 ANALYZE_CORE 经同一 handler
    // 记账）。真实 AnalysisService 把 AUTH_FAILED 折进 failures 而非抛出，故只挂 outcome 路径。
    if (outcome.failures.any { it.error.code == ErrorCode.AUTH_FAILED }) {
      recordAuthFailedSafely(profile.id)
    }
    applyOutcome(outcome)
  }

  internal fun flushBatch(offscreen: Boolean) {
    if (pendingBatch.isEmpty()) return
    val batch = pendingBatch.toList()
    pendingBatch.clear()
    batchDeadline = 0
    // F3 一次性绕缓存标志在**真正冲批**时消费（取走即复位）：手动冲批（测试）与 120ms
    // 自动冲批走同一收口，重析后的下一次普通重扫自然回落缓存路径。显式按段解析
    // （parseExplicitBlock）不经这里，保持「不绕缓存」的既有语义。
    val bypass = bypassCacheOnce
    bypassCacheOnce = false
    scope.launch { dispatch(batch, offscreen, bypassCache = bypass) }
  }

  private suspend fun dispatch(
    inputs: List<SentenceInput>,
    offscreen: Boolean,
    allowPaused: Boolean = false,
    bypassCache: Boolean = false,
  ) {
    // 普通路径行为不变（PAUSED 直接返回）；只有显式手势传 allowPaused = true 穿透。
    if (state == SessionState.STOPPED) return
    if (state == SessionState.PAUSED && !allowPaused) return
    val capturedVersion = operationVersion
    val profile = currentProfile ?: run {
      // 无 Profile：纯缓存查询。整批先置 STALE（miss 句终态——对齐 Chrome 纯缓存会话
      // 的 skipped 语义：保持原文渲染、不计 failed，且 registerFresh 对 STALE 放行，
      // 配好 profile 后的重扫能把它们重新派发；留 DISCOVERED 会永久滞留、置 FAILED 会被
      // 计成失败并渲染成失败行，都救不回来）。命中句随后经 [applyOutcome] 置 READY 并以
      // CORE_RESULT 下发渲染——对齐 Chrome 把命中 analyses 放进 CORE_RESULT 返回
      // （service-worker.ts:487-494），浮层的「缓存命中 x/y 句」才有对应译文可看。
      inputs.forEach { input -> sentences[input.sentenceId]?.phase = SentencePhase.STALE }
      val cached = analysis.lookupCore(inputs)
      applyOutcome(CoreBatchOutcome(cached, emptyList(), cacheHit = cached.isNotEmpty()))
      sender.send(buildJsonObject {
        put("version", 1)
        put("type", "SESSION_STATE")
        put("previewId", previewId)
        put("generation", generation)
        put("state", "cacheOnly")
        // 终态计数取会话累计（与 applyOutcome 同口径）：此前发本批计数，多批会话下
        // web 侧拿不到全量 ready/discovered，「缓存命中 x/y 句」的 y 永远不对。
        put("ready", counts.ready)
        put("discovered", counts.discovered)
        put("failed", counts.failed)
      })
      return
    }

    inputs.forEach { sentences[it.sentenceId]?.phase = SentencePhase.QUEUED }
    // F6 暂停门（Chrome 路由层 isProfilePaused 的会话层等价物——AnalysisService 无
    // dispatch 概念）：命中暂停表就不再发模型请求。暂停优先于绕缓存（重试/重析也要
    // 模型，暂停说明模型用不了）；bypassCache 语义到此为止。
    pausedCoreOutcome(profile, inputs)?.let {
      LOGGER.info("dispatch: profile=${profile.id} paused, serving ${inputs.size} sentences from cache")
      applyOutcome(it)
      return
    }
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
        bypassCache = bypassCache,
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
      // F6 记账：抛出的 AUTH_FAILED 同样挂起 profile（Chrome catch 分支同款）——
      // AnalysisService 正常把 AUTH_FAILED 折进 failures，这里是防御位。
      recordAuthFailureIfAny(profile, error)
      if (error is ExtensionFailure && error.code == ErrorCode.AUTH_FAILED) {
        // Chrome 同款 cacheWithAuthError：不整批报错，缓存命中照回 + 未命中句 AUTH_FAILED。
        applyOutcome(cacheFallbackOutcome(inputs))
        return
      }
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
    // F6 记账：首批请求结果 AUTH_FAILED → 上报暂停表，后续批次走上面的暂停门，
    // 不再对死凭据白发请求（Chrome outcome.failures 检查同款）。
    if (outcome.failures.any { it.error.code == ErrorCode.AUTH_FAILED }) {
      recordAuthFailedSafely(profile.id)
    }
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

  /**
   * F6 暂停门的 core 等价物（Chrome `cacheWithAuthError`）：profile 被挂起时整批回落
   * `lookupCore` 纯缓存——命中句照常产出 CORE_RESULT（缓存键与模型无关，换/修模型前
   * 译文不消失），未命中句标 AUTH_FAILED 失败（渲染层按 code 出鉴权友好文案）。
   * 未暂停返回 null（门直通）。
   */
  private suspend fun pausedCoreOutcome(profile: ModelProfile, inputs: List<SentenceInput>): CoreBatchOutcome? {
    if (!pauseRegistry.isPaused(profile.id)) return null
    return cacheFallbackOutcome(inputs)
  }

  private suspend fun cacheFallbackOutcome(inputs: List<SentenceInput>): CoreBatchOutcome {
    val cached = analysis.lookupCore(inputs)
    val cachedIds = cached.map { it.sentenceId }.toSet()
    val failures = inputs.filter { it.sentenceId !in cachedIds }.map { input ->
      AnalysisFailure(input.sentenceId, ExtensionFailure(ErrorCode.AUTH_FAILED, AUTH_FAILED_MESSAGE, false))
    }
    return CoreBatchOutcome(cached, failures, cacheHit = cached.isNotEmpty())
  }

  /**
   * F6 记账的失败隔离（终审 F-1）：recordAuthFailed 组装凭据指纹要读 PasswordSafe，
   * 读失败只影响「这次没记上」——下次真实失败还会再记，log 后继续。绝不让它传播进
   * session Job：会话入口都是普通 child Job 上的 scope.launch，非取消异常会把整个会话
   * brick 成「state 仍 RUNNING、后续派发全部静默 no-op」直到面板重建。取消照常重抛
   * （保持 stop/换代的结构化取消语义）。
   */
  private suspend fun recordAuthFailedSafely(profileId: String) {
    try {
      pauseRegistry.recordAuthFailed(profileId)
    } catch (error: Throwable) {
      if (error is kotlinx.coroutines.CancellationException) throw error
      LOGGER.warn("recordAuthFailed: failed to record auth pause for profile=$profileId: ${error.message}")
    }
  }

  /** F6 记账：抛出的失败是 AUTH_FAILED 时把 profile 记入暂停表（Chrome 各 handler 同款）。 */
  private suspend fun recordAuthFailureIfAny(profile: ModelProfile, error: Throwable) {
    val failure = error as? ExtensionFailure ?: return
    if (failure.code == ErrorCode.AUTH_FAILED) recordAuthFailedSafely(profile.id)
  }

  /** 详解点击：detail 优先级由 AnalysisService 内部固定。 */
  suspend fun onDetailRequest(sentenceId: String, focusStart: Int, focusEnd: Int) {
    val record = sentences[sentenceId] ?: return
    if (state == SessionState.STOPPED) return
    val profile = currentProfile ?: return
    val core = record.core ?: return
    // F6 暂停门（Chrome paused-detail 同款）：暂停期间详解也先查缓存——命中照回
    // DETAIL_RESULT（缓存键与模型无关），未命中才报 AUTH_FAILED；不发模型请求。
    if (pauseRegistry.isPaused(profile.id)) {
      val cached = analysis.lookupDetail(record.input, TokenRange(focusStart, focusEnd))
      if (cached != null) {
        sender.send(buildJsonObject {
          put("version", 1)
          put("type", "DETAIL_RESULT")
          put("previewId", previewId)
          put("generation", generation)
          put("sentenceId", sentenceId)
          put("analysisJson", detailJson(cached))
        })
      } else {
        sender.send(buildJsonObject {
          put("version", 1)
          put("type", "CORE_ERROR")
          put("previewId", previewId)
          put("generation", generation)
          put("sentenceId", sentenceId)
          put("blockId", record.blockId)
          put("code", ErrorCode.AUTH_FAILED.name)
          put("message", AUTH_FAILED_MESSAGE)
          put("tokensJson", tokensJson(sentenceId))
        })
      }
      return
    }
    val capturedVersion = operationVersion
    // F6 记账：detail 抛 AUTH_FAILED 时挂起 profile（Chrome ANALYZE_DETAIL catch 同款）。
    val detail = try {
      analysis.analyzeDetail(
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
    } catch (error: Throwable) {
      recordAuthFailureIfAny(profile, error)
      throw error
    }
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
            // ExtensionFailure 带真实错误码（AUTH_FAILED 等，渲染层按码出文案）；
            // 其它异常才落到笼统 DETAIL_FAILED。
            put("code", (error as? ExtensionFailure)?.code?.name ?: "DETAIL_FAILED")
            put("message", error.message ?: "detail request failed")
            put("tokensJson", tokensJson(sentenceId))
          })
        }
    }
  }

  /**
   * 桥接层入口：追问对话经 session scope 派发（onPageMessage 在 JCEF 线程回调）。
   *
   * **刻意不设 SessionState 静默门**（不照抄 [launchDetailRequest] 的
   * `if state == STOPPED return`）：面板在 stop/RESTORE_ALL 后仍然开着，静默丢弃会把
   * 输入框永久卡在禁用态；chat 是用户手势，与 Chrome 端同款只判数据可用性——
   * 记录/core 缺失或无 profile 都用 CHAT_ERROR 明示，绝不静默。
   */
  fun launchChatAsk(conversationId: String, sentenceId: String, history: List<ChatTurn>, question: String) {
    scope.launch {
      runCatching { onChatAsk(conversationId, sentenceId, history, question) }
        .onFailure { error ->
          if (error is kotlinx.coroutines.CancellationException) throw error
          // dispose 竞速下 panel.send 可能已抛错（面板关走时的在飞回答）——回收路径不得再炸 scope。
          runCatching { sendChatError(conversationId, chatFailureText(error)) }
            .onFailure { LOGGER.warn("launchChatAsk: failed to deliver CHAT_ERROR: ${it.message}") }
        }
    }
  }

  private suspend fun onChatAsk(
    conversationId: String,
    sentenceId: String,
    history: List<ChatTurn>,
    question: String,
  ) {
    val record = sentences[sentenceId]
    val core = record?.core
    if (record == null || core == null) {
      // stop()/onGenerationChanged() 都会清空 sentences——「stop 后再问」也走这条，不静默。
      sendChatError(conversationId, "原句已失效：请重新解析后再提问")
      return
    }
    val profile = currentProfile ?: run {
      sendChatError(conversationId, "尚未配置可用的模型档案，请先在设置中配置")
      return
    }
    // F6 暂停门（Chrome CHAT_ASK 同款）：chat 没有缓存兜底语义，直接 CHAT_ERROR 明示。
    if (pauseRegistry.isPaused(profile.id)) {
      sendChatError(conversationId, AUTH_FAILED_MESSAGE)
      return
    }
    val capturedVersion = operationVersion
    // F6 记账：chat 抛 AUTH_FAILED 时挂起 profile（Chrome CHAT_ASK catch 同款）。
    val answer = try {
      analysis.chat(
        profile = profile,
        documentId = documentId,
        conversationId = conversationId,
        input = record.input,
        core = core,
        history = history,
        question = question,
        onStreamedText = StreamedTextSink { textSoFar ->
          // text 是「截至目前的完整回答」（全量替换渲染，重试安全）。generation 读 send 时点，
          // 与 CORE_STREAM 同款；stop/换代升 operationVersion 压住旧会话分片，JS 侧 generation
          // 过滤 + conversationId 把关是第二、三道防线。
          if (capturedVersion == operationVersion) {
            sender.send(buildJsonObject {
              put("version", 1)
              put("type", "CHAT_STREAM")
              put("previewId", previewId)
              put("generation", generation)
              put("conversationId", conversationId)
              put("text", textSoFar)
            })
          }
        },
      )
    } catch (error: Throwable) {
      recordAuthFailureIfAny(profile, error)
      throw error
    }
    sender.send(buildJsonObject {
      put("version", 1)
      put("type", "CHAT_RESULT")
      put("previewId", previewId)
      put("generation", generation)
      put("conversationId", conversationId)
      put("answer", answer)
    })
  }

  private fun sendChatError(conversationId: String, message: String) {
    sender.send(buildJsonObject {
      put("version", 1)
      put("type", "CHAT_ERROR")
      put("previewId", previewId)
      put("generation", generation)
      put("conversationId", conversationId)
      put("message", message)
    })
  }

  /**
   * 请求失败文案：「<既有错误码名>：<脱敏 message>」。message 已在服务边界脱敏
   * （AnalysisService.chat 的流式与收尾文本都过 redactSecrets），这里不重复脱敏；
   * 未知异常兜底 NETWORK_ERROR 前缀。CHAT_ERROR 无 code 字段（ErrorCode 枚举被
   * contracts 钉死不加值），错误码只作为人类可读前缀。
   */
  private fun chatFailureText(error: Throwable): String {
    val failure = error as? ExtensionFailure
    val code = failure?.code?.name ?: ErrorCode.NETWORK_ERROR.name
    val detail = (failure?.message ?: error.message)?.takeUnless { it.isNullOrBlank() } ?: "chat request failed"
    return "$code：$detail"
  }

  /**
   * 桥接层入口：纠正反馈经 session scope 派发（onPageMessage 在 JCEF 线程回调）。
   *
   * 与 [launchChatAsk] 同款**不设 SessionState 静默门**：内联输入行在 stop 后仍开着，
   * 静默丢弃会把提交按钮永久卡在禁用态；数据可用性（记录/core/profile）用
   * FEEDBACK_ERROR 明示。成功经 [applyOutcome] 落账（record.core 更新 + READY 相位 +
   * SESSION_STATE），再按既有 CORE_RESULT 路径重画；失败回 FEEDBACK_ERROR——
   * **绝不自发 CORE_ERROR**（那会把句卡片打成失败行、抹掉已核实的划分）。
   */
  fun launchFeedback(sentenceId: String, feedback: String) {
    scope.launch {
      runCatching { onFeedback(sentenceId, feedback) }
        .onFailure { error ->
          if (error is kotlinx.coroutines.CancellationException) throw error
          // dispose 竞速下 panel.send 可能已抛错——回收路径不得再炸 scope（launchChatAsk 同款）。
          runCatching { sendFeedbackError(sentenceId, feedbackFailureText(error)) }
            .onFailure { LOGGER.warn("launchFeedback: failed to deliver FEEDBACK_ERROR: ${it.message}") }
        }
    }
  }

  private suspend fun onFeedback(sentenceId: String, feedback: String) {
    val record = sentences[sentenceId]
    val core = record?.core
    if (record == null || core == null) {
      // stop()/onGenerationChanged() 都会清空 sentences——「stop 后再纠正」也走这条，不静默。
      sendFeedbackError(sentenceId, "原句已失效：请重新解析后再纠正")
      return
    }
    val profile = currentProfile ?: run {
      sendFeedbackError(sentenceId, "尚未配置可用的模型档案，请先在设置中配置")
      return
    }
    // F6 暂停门（Chrome REANALYZE_WITH_FEEDBACK 同款）：暂停的死 key 不得继续收纠正
    // 请求——直接 FEEDBACK_ERROR，卡片保持已核实划分不动。
    if (pauseRegistry.isPaused(profile.id)) {
      sendFeedbackError(sentenceId, AUTH_FAILED_MESSAGE)
      return
    }
    val capturedVersion = operationVersion
    // F6 记账：纠正抛 AUTH_FAILED 时挂起 profile（Chrome REANALYZE_WITH_FEEDBACK catch 同款）。
    val corrected = try {
      analysis.analyzeWithFeedback(
        profile = profile,
        documentId = documentId,
        input = record.input,
        core = core,
        feedback = feedback,
      )
    } catch (error: Throwable) {
      recordAuthFailureIfAny(profile, error)
      throw error
    }
    if (capturedVersion != operationVersion) return
    // 成功经 applyOutcome 落账：record.core 更新 + READY 相位 + CORE_RESULT（blockId=句所在块）
    // + SESSION_STATE。手发消息不更新记录会让后续 detail/chat 对着过期成分讲。
    applyOutcome(CoreBatchOutcome(listOf(corrected), emptyList(), cacheHit = false))
  }

  private fun sendFeedbackError(sentenceId: String, message: String) {
    sender.send(buildJsonObject {
      put("version", 1)
      put("type", "FEEDBACK_ERROR")
      put("previewId", previewId)
      put("generation", generation)
      put("sentenceId", sentenceId)
      put("message", message)
    })
  }

  /**
   * 纠正失败文案（[chatFailureText] 同款 F1 口径）：message 已在服务边界脱敏
   * （invalidOutput），这里只加错误码前缀；未知异常兜底 NETWORK_ERROR。
   */
  private fun feedbackFailureText(error: Throwable): String {
    val failure = error as? ExtensionFailure
    val code = failure?.code?.name ?: ErrorCode.NETWORK_ERROR.name
    val detail = (failure?.message ?: error.message)?.takeUnless { it.isNullOrBlank() } ?: "correction request failed"
    return "$code：$detail"
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
