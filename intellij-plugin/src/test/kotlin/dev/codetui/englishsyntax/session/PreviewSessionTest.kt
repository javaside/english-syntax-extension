package dev.codetui.englishsyntax.session

import dev.codetui.englishsyntax.analysis.AnalysisFailure
import dev.codetui.englishsyntax.analysis.AnalysisServicePort
import dev.codetui.englishsyntax.analysis.CoreBatchOutcome
import dev.codetui.englishsyntax.analysis.DetailOutcome
import dev.codetui.englishsyntax.domain.CoreAnalysis
import dev.codetui.englishsyntax.domain.CoreComponent
import dev.codetui.englishsyntax.domain.DetailAnalysis
import dev.codetui.englishsyntax.domain.DetailStructure
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.GrammarRole
import dev.codetui.englishsyntax.domain.SentenceInput
import dev.codetui.englishsyntax.domain.TokenRange
import dev.codetui.englishsyntax.scheduler.SchedulerPriority
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class PreviewSessionTest {

  private class FakeAnalysisService : AnalysisServicePort {
    var analyzeCalls = 0
    var lastPriority: SchedulerPriority? = null
    var lastSentences: List<SentenceInput> = emptyList()
    var lastBypassCache: Boolean? = null
    var cancelledDocuments = mutableListOf<String>()
    var lookupResults: MutableMap<String, CoreAnalysis> = mutableMapOf()
    var outcome: CoreBatchOutcome = CoreBatchOutcome(emptyList(), emptyList(), cacheHit = false)
    var authFailure = false
    /** 测试注入：analyzeCore 调用前触发一次流式回调（传 null 则不触发）。 */
    var onStreamOnce: ((dev.codetui.englishsyntax.analysis.StreamedComponentSink) -> Unit)? = null
    /** 测试注入：detail 结果（analyzeDetail 直接返回它）。 */
    var detailOutcome: DetailOutcome? = null
    var detailCalls = 0
    var lastDetailCore: CoreAnalysis? = null
    /** 测试注入：analyzeCore 直接抛异常（模拟模型层崩溃，验证会话兜底给终态）。 */
    var throwOnAnalyzeCore = false

    override suspend fun analyzeCore(
      profile: ModelProfile,
      documentId: String,
      sentences: List<SentenceInput>,
      priority: SchedulerPriority,
      bypassCache: Boolean,
      onStreamedComponent: dev.codetui.englishsyntax.analysis.StreamedComponentSink?,
    ): CoreBatchOutcome {
      analyzeCalls += 1
      lastPriority = priority
      lastSentences = sentences
      lastBypassCache = bypassCache
      if (throwOnAnalyzeCore) throw IllegalStateException("model crash")
      onStreamOnce?.let { it(onStreamedComponent!!) }
      onStreamOnce = null
      if (authFailure) {
        return CoreBatchOutcome(
          emptyList(),
          sentences.map { AnalysisFailure(it.sentenceId, ExtensionFailure(ErrorCode.AUTH_FAILED, "auth", false)) },
          cacheHit = false,
        )
      }
      return outcome
    }

    override suspend fun lookupCore(sentences: List<SentenceInput>): List<CoreAnalysis> {
      return sentences.mapNotNull { lookupResults[it.sentenceId] }
    }

    override suspend fun analyzeDetail(
      profile: ModelProfile,
      documentId: String,
      sentence: SentenceInput,
      core: CoreAnalysis,
      focus: TokenRange,
      onStreamedStructure: dev.codetui.englishsyntax.analysis.StreamedStructureSink?,
    ): DetailOutcome {
      detailCalls += 1
      lastDetailCore = core
      detailOutcome?.let { return it }
      val detail = DetailAnalysis(
        sentenceId = sentence.sentenceId,
        focus = focus,
        structures = emptyList(),
        grammarPoints = emptyList(),
        explanation = "ok",
        modelProfileId = profile.id,
      )
      return DetailOutcome(detail, cacheHit = false)
    }

    override suspend fun lookupDetail(sentence: SentenceInput, focus: TokenRange): DetailAnalysis? = null

    override suspend fun cancelDocument(documentId: String) {
      cancelledDocuments += documentId
    }
  }

  private class RecordingSender : HostSender {
    val sent = mutableListOf<JsonObject>()
    override fun send(json: JsonObject) {
      sent += json
    }

    fun of(type: String): List<JsonObject> = sent.filter { it["type"]?.jsonPrimitive?.contentOrNull == type }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private lateinit var service: FakeAnalysisService
  private lateinit var manager: PreviewSessionManager
  private lateinit var sender: RecordingSender
  private var scanRequests = 0

  private val profile = ModelProfile(
    id = "p1",
    name = "test",
    baseUrl = "https://api.example.com/v1",
    model = "m",
    headerNames = emptySet(),
    timeoutMs = 30_000,
    jsonSchemaSupport = JsonSchemaSupport.UNKNOWN,
  )

  @BeforeTest
  fun setUp() {
    service = FakeAnalysisService()
    manager = PreviewSessionManager(scope, service, { profile })
    sender = RecordingSender()
    scanRequests = 0
  }

  @AfterTest
  fun tearDown() {
    manager.disposeAll()
    scope.cancel()
  }

  private fun session(): PreviewSession = manager.obtain("pv1", sender) { scanRequests += 1 }

  @Test
  fun `start requests a scan`() {
    val session = session()
    session.start()
    assertEquals(1, scanRequests)
    assertEquals(SessionState.RUNNING, session.state)
  }

  @Test
  fun `start again while running still rescans so failed sentences can be retried`() {
    val session = session()
    session.start()
    assertEquals(1, scanRequests)
    // 失败句处于 RUNNING 但未全部成功：再点「开始」应重新触发扫描，让失败句可重派，
    // 而不是静默 return（此前表现为「失败后再点开始，页面不动」）。
    session.start()
    assertEquals(2, scanRequests)
    assertEquals(SessionState.RUNNING, session.state)
  }

  @Test
  fun `visible blocks are batched and dispatched once`() = runBlocking {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response. Second sentence here too."))

    // 立即 flush（测试不依赖 120ms 窗口）。
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls)
    assertTrue(service.lastSentences.size >= 1)
    assertEquals(SchedulerPriority.ACTIVE_VISIBLE_CORE, service.lastPriority)
  }

  @Test
  fun `repeated visible blocks after ready do not redispatch`() = runBlocking {
    // 防环守卫：渲染也是 DOM 变更，会再次触发 rescan → 重复的 VISIBLE_BLOCKS。
    // READY 句绝不能被重置重派——否则缓存命中 → CORE_RESULT → 再渲染 → 无限循环（CPU 狂转）。
    val session = session()
    session.start()
    val blocks = listOf("b1" to "The service validates every response carefully today.")
    // 让第一轮派发真正产出 READY 句
    service.outcome = CoreBatchOutcome(
      listOf(
        CoreAnalysis(
          sentenceId = "s-b1-0",
          components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
          modelProfileId = "p1",
        ),
      ),
      emptyList(),
      cacheHit = false,
    )
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)

    // 模拟渲染后重复上报同一批块
    session.onVisibleBlocks(blocks)
    session.onVisibleBlocks(blocks)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "READY 句重复上报不得再次派发模型请求")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
  }

  /**
   * 「停止并恢复原文」→ 再点开始 → 页面重扫上报同一批块：必须重新派发并重新回推
   * CORE_RESULT。stop() 清空了 sentences，同名 sentenceId 于是作为新句重新注册；
   * 若哪天 stop 改成保留记录，防环守卫（只放行「尚未出结果」的句子）会把它们当已
   * 完成而永不派发——真机表现是「恢复原文后再点翻译，整页不动且无报错」。
   */
  @Test
  fun `stop then start dispatches the same blocks again`() = runBlocking {
    val session = session()
    val blocks = listOf("b1" to "The service validates every response carefully today.")
    service.outcome = CoreBatchOutcome(
      listOf(
        CoreAnalysis(
          sentenceId = "s-b1-0",
          components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
          modelProfileId = "p1",
        ),
      ),
      emptyList(),
      cacheHit = false,
    )
    session.start()
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)

    session.stop()
    assertEquals(SessionState.STOPPED, session.state)

    session.start()
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(2, service.analyzeCalls)
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
    assertEquals(2, sender.of("CORE_RESULT").size)
  }

  @Test
  fun `dispatch wires the stream sink and forwards streamed components as CORE_STREAM`() = runBlocking {
    // 流式接线守卫：曾漏传 onStreamedComponent → 全程非流式，等整批返回才渲染
    // （真机症状：翻译很慢、页面不动、没有进度）。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))

    // FakeAnalysisService 在 analyzeCore 里触发流式回调
    service.onStreamOnce = { sink ->
      sink.accept(
        "s-b1-0",
        listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      )
    }
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    val streams = sender.of("CORE_STREAM")
    assertTrue(streams.isNotEmpty(), "dispatch 必须接流式 sink 并回推 CORE_STREAM")
    val payload = streams.first()["componentsJson"]?.jsonPrimitive?.contentOrNull ?: error("no payload")
    assertTrue(payload.contains("\"role\":\"SUBJECT\""), "分片要带角色枚举, got: $payload")
    assertTrue(payload.contains("\"text\":\"The service\""), "分片要回填英文原文, got: $payload")
    val tokens = streams.first()["tokensJson"]?.jsonPrimitive?.contentOrNull ?: error("no tokens")
    assertTrue(tokens.contains("\"leadingWhitespace\""), "分片要带源 Token 供标点还原, got: $tokens")
    assertEquals("b1", streams.first()["blockId"]?.jsonPrimitive?.contentOrNull)
  }

  @Test
  fun `component text is backfilled from tokens for the english row`() = runBlocking {
    // 三行对照的英文行依赖 Kotlin 回填 component.text（渲染层不自己分词）。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    val analysis = CoreAnalysis(
      sentenceId = first.sentenceId,
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "p1",
    )
    val sent = mutableListOf<JsonObject>()
    val sender = object : HostSender {
      override fun send(json: JsonObject) {
        sent += json
      }
    }
    // 直接调用 applyOutcome 需要 sender——通过反射太脆，改走内部路径：构造带 sender 的 session
    val wired = PreviewSessionManager(scope, service, { profile }).obtain("pv-en", sender) { }
    wired.start()
    wired.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    wired.applyOutcome(CoreBatchOutcome(listOf(analysis), emptyList(), cacheHit = false))

    val result = sent.firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "CORE_RESULT" }
    assertNotNull(result)
    val payload = result["analysisJson"]?.jsonPrimitive?.contentOrNull ?: error("no analysisJson")
    assertTrue(payload.contains("\"text\":\"The service\""), "成分英文原文应回填, got: $payload")
  }

  @Test
  fun `detail request reuses the verified core analysis`() = runBlocking {
    // 回归：此前点击成分时临时构造 components=[]，详解模型失去已确认的句法边界，
    // 会重新猜结构并产出与正文错位的局部译文。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    val verifiedCore = CoreAnalysis(
      sentenceId = first.sentenceId,
      components = listOf(
        CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务"),
        CoreComponent(2, 5, GrammarRole.PREDICATE, "仔细验证每个响应"),
      ),
      modelProfileId = "p1",
    )
    session.applyOutcome(CoreBatchOutcome(listOf(verifiedCore), emptyList(), cacheHit = false))

    session.onDetailRequest(first.sentenceId, 2, 5)

    assertSame(verifiedCore, service.lastDetailCore)
  }

  @Test
  fun `detail request is ignored until verified core exists`() = runBlocking {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")

    session.onDetailRequest(first.sentenceId, 0, 1)

    assertEquals(0, service.detailCalls)
  }

  @Test
  fun `detail result backfills english text and grammarPoints`() = runBlocking {
    // 详解最终结果必须回填 structure.text（英文摘录）与 grammarPoints——否则点成分后
    // 完整结果覆盖流式时英文对照与语法点消失（Chrome 端两处都有）。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    val focus = TokenRange(0, 1)
    service.detailOutcome = DetailOutcome(
      DetailAnalysis(
        sentenceId = first.sentenceId,
        focus = focus,
        structures = listOf(
          DetailStructure(startToken = 0, endToken = 1, role = "主语", explanation = "名词短语", translation = "该服务"),
        ),
        grammarPoints = listOf("一般现在时"),
        explanation = "整体说明",
        modelProfileId = "p1",
      ),
      cacheHit = false,
    )
    val sent = mutableListOf<JsonObject>()
    val sender = object : HostSender {
      override fun send(json: JsonObject) {
        sent += json
      }
    }
    val wired = PreviewSessionManager(scope, service, { profile }).obtain("pv-detail", sender) { }
    wired.start()
    wired.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    wired.applyOutcome(
      CoreBatchOutcome(
        listOf(
          CoreAnalysis(
            sentenceId = first.sentenceId,
            components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
            modelProfileId = "p1",
          ),
        ),
        emptyList(),
        cacheHit = false,
      ),
    )
    wired.launchDetailRequest(first.sentenceId, focus.startToken, focus.endToken)
    kotlinx.coroutines.delay(100)

    val result = sent.firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "DETAIL_RESULT" }
    assertNotNull(result, "必须回推 DETAIL_RESULT")
    val payload = result["analysisJson"]?.jsonPrimitive?.contentOrNull ?: error("no analysisJson")
    assertTrue(payload.contains("\"text\":\"The service\""), "详解结构应回填英文摘录, got: $payload")
    assertTrue(payload.contains("\"grammarPoints\":[\"一般现在时\"]"), "详解应带语法点, got: $payload")
  }

  @Test
  fun `pause blocks dispatch and resume replays`() = runBlocking {
    val session = session()
    session.start()
    session.pause()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    assertEquals(0, service.analyzeCalls)

    session.resume()
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
  }

  @Test
  fun `stop cancels document and sends restore all`() = runBlocking {
    val session = session()
    session.start()
    session.stop()
    kotlinx.coroutines.delay(50)
    assertTrue(service.cancelledDocuments.isNotEmpty())
    assertEquals(1, sender.of("RESTORE_ALL").size)
    assertEquals(SessionState.STOPPED, session.state)
  }

  @Test
  fun `generation change bumps and clears sentences`() = runBlocking {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.onGenerationChanged(1)
    kotlinx.coroutines.delay(50)
    assertEquals(0, session.counts.discovered)
    assertTrue(service.cancelledDocuments.isNotEmpty())
  }

  @Test
  fun `dispatch surfaces core error when analyzeCore throws`() = runBlocking {
    // 模型层崩溃（非 ExtensionFailure 异常）不能让句子永远无终态——否则 JS 侧
    // settledBlocks 凑不满、浮层永远「解析中」。会话必须兜底发 CORE_ERROR。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    service.throwOnAnalyzeCore = true
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    val errors = sender.of("CORE_ERROR")
    assertTrue(errors.isNotEmpty(), "模型崩溃时必须发送 CORE_ERROR 收尾")
    assertEquals(SentencePhase.FAILED, session.sentences.values.firstOrNull()?.phase)
  }

  @Test
  fun `core results are forwarded to the page`() = runBlocking {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val firstSentence = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    val analysis = CoreAnalysis(
      sentenceId = firstSentence.sentenceId,
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "p1",
    )
    session.applyOutcome(CoreBatchOutcome(listOf(analysis), emptyList(), cacheHit = false))

    val results = sender.of("CORE_RESULT")
    assertEquals(1, results.size)
    assertEquals(firstSentence.sentenceId, results[0]["sentenceId"]?.jsonPrimitive?.contentOrNull)
    assertEquals(SentencePhase.READY, session.sentences[firstSentence.sentenceId]?.phase)
  }

  @Test
  fun `apply outcome emits session state with ready counts`() = runBlocking {
    // 进度回推：每批结果落地后要发 SESSION_STATE（ready/discovered/failed），
    // JS 侧浮层据此显示「X/Y 句」，而不是只有「已处理 N 句」。
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val firstSentence = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    val analysis = CoreAnalysis(
      sentenceId = firstSentence.sentenceId,
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "p1",
    )
    session.applyOutcome(CoreBatchOutcome(listOf(analysis), emptyList(), cacheHit = false))

    val states = sender.of("SESSION_STATE")
    assertTrue(states.isNotEmpty(), "applyOutcome 后必须回推 SESSION_STATE")
    val state = states.last()
    assertEquals("running", state["state"]?.jsonPrimitive?.contentOrNull)
    assertEquals(1, state["ready"]?.jsonPrimitive?.content?.toInt())
    assertTrue((state["discovered"]?.jsonPrimitive?.content?.toInt() ?: 0) >= 1)
  }

  @Test
  fun `failures are forwarded as core error`() {
    val session = session()
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val firstSentence = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    session.applyOutcome(
      CoreBatchOutcome(
        emptyList(),
        listOf(
          AnalysisFailure(firstSentence.sentenceId, ExtensionFailure(ErrorCode.AUTH_FAILED, "auth", false)),
        ),
        cacheHit = false,
      ),
    )
    assertEquals(1, sender.of("CORE_ERROR").size)
    assertEquals(SentencePhase.FAILED, session.sentences[firstSentence.sentenceId]?.phase)
  }

  @Test
  fun `no profile yields cache only with skipped sentences`() = runBlocking {
    val noProfileManager = PreviewSessionManager(scope, service, { null })
    val localSender = RecordingSender()
    val session = noProfileManager.obtain("pv-none", localSender) { }
    session.start()
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(0, service.analyzeCalls)
    val states = localSender.of("SESSION_STATE")
    assertEquals(1, states.size)
    assertEquals("cacheOnly", states[0]["state"]?.jsonPrimitive?.contentOrNull)
  }

  @Test
  fun `priority maps active offscreen and inactive`() {
    val session = session()
    assertEquals(SchedulerPriority.ACTIVE_VISIBLE_CORE, session.priorityFor(active = true, offscreen = false))
    assertEquals(SchedulerPriority.OTHER_VISIBLE_CORE, session.priorityFor(active = false, offscreen = false))
    assertEquals(SchedulerPriority.ACTIVE_PREFETCH_CORE, session.priorityFor(active = true, offscreen = true))
  }

  @Test
  fun `dispose preview releases the session`() {
    manager.start("pv-x", sender) { }
    manager.disposePreview("pv-x")
    assertEquals(null, manager.session("pv-x"))
    assertEquals(null, manager.activePreviewId)
  }

  @Test
  fun `two previews run independently in parallel`() {
    // 多文件并行翻译的根基：不同 previewId 各自持有独立 session，start/pause/stop 互不影响。
    val s1 = RecordingSender()
    val s2 = RecordingSender()
    manager.obtain("pv-a", s1) { }
    manager.obtain("pv-b", s2) { }
    manager.start("pv-a", s1) { }
    manager.start("pv-b", s2) { }
    assertEquals(SessionState.RUNNING, manager.session("pv-a")?.state)
    assertEquals(SessionState.RUNNING, manager.session("pv-b")?.state)
    // 暂停 a 不影响 b
    manager.pause("pv-a")
    assertEquals(SessionState.PAUSED, manager.session("pv-a")?.state)
    assertEquals(SessionState.RUNNING, manager.session("pv-b")?.state)
    // 停止 b 不影响 a
    manager.stop("pv-b")
    assertEquals(SessionState.PAUSED, manager.session("pv-a")?.state)
    assertEquals(SessionState.STOPPED, manager.session("pv-b")?.state)
  }

  @Test
  fun `parse explicit block starts a session without scanning the whole document`() = runBlocking {
    // 快捷键可作为冷启动入口：置 RUNNING 但绝不触发全文扫描，否则「按段翻译」变成整篇翻译。
    val session = session()
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertEquals(SessionState.RUNNING, session.state)
    assertEquals(0, scanRequests, "显式按段解析不得请求扫描")
    assertEquals(1, service.analyzeCalls)
  }

  @Test
  fun `parse explicit block dispatches at visible core priority without bypassing cache`() = runBlocking {
    val session = session()
    session.start()
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls)
    assertEquals(SchedulerPriority.ACTIVE_VISIBLE_CORE, service.lastPriority)
    assertEquals(false, service.lastBypassCache, "按段解析不绕缓存（绕缓存只属于重试）")
    assertTrue(service.lastSentences.all { it.sentenceId.startsWith("s-b1-") }, "只应派发这一段")
  }
  @Test
  fun `parse explicit block punches through pause`() = runBlocking {
    // 显式手势穿透暂停：否则 JS 打上的「解析中」竖条会一直亮到用户点继续。
    val session = session()
    session.start()
    session.pause()
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "暂停中显式按段解析仍应派发")
    assertEquals(SessionState.PAUSED, session.state, "显式手势不改变会话状态")
  }

  @Test
  fun `parse explicit block is idempotent for the same block`() = runBlocking {
    // 两条快捷键通道（IDEA Action + 页面 keydown）可能同时到达，重复按键也不能翻倍请求。
    val session = session()
    session.start()
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls)
  }

  @Test
  fun `streamed components still reach the page while paused`() = runBlocking {
    // 暂停穿透的配套：分片守卫从「必须 RUNNING」放宽到「非 STOPPED」。否则显式路径
    // 在暂停时只能等整批返回，卡片突然整块冒出来、没有流式过程。
    val session = session()
    session.start()
    session.pause()
    service.onStreamOnce = { sink ->
      sink.accept("s-b1-0", listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")))
    }
    session.parseExplicitBlock("b1", "The service validates every response carefully today.")
    kotlinx.coroutines.delay(100)

    assertTrue(sender.of("CORE_STREAM").isNotEmpty(), "暂停中显式派发的分片也要回推")
  }
}
