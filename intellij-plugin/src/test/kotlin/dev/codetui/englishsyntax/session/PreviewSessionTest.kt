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
import dev.codetui.englishsyntax.bridge.BridgeProtocol
import dev.codetui.englishsyntax.model.ChatTurn
import dev.codetui.englishsyntax.scheduler.SchedulerPriority
import dev.codetui.englishsyntax.settings.JsonSchemaSupport
import dev.codetui.englishsyntax.settings.ModelProfile
import kotlinx.coroutines.CompletableDeferred
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
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
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
    /** 测试注入（F6）：analyzeCore 抛指定异常（AUTH_FAILED 兜底分支断言）。 */
    var analyzeCoreThrowable: Throwable? = null
    // ---- F6 AUTH_FAILED 暂停接线断言用 ----
    /** 测试注入：lookupDetail 的缓存表（暂停期 detail 回落断言）。 */
    var detailLookupResults: MutableMap<String, DetailAnalysis> = mutableMapOf()
    /** 测试注入：analyzeDetail 直接抛异常（detail 的 AUTH_FAILED 记账断言）。 */
    var detailError: Throwable? = null
    /**
     * 测试注入（F3 在飞批竞速）：analyzeCore 挂起直至 gate 完成的一次性门。
     * 置位后**下一次**调用在返回前挂起（消费后自清），此后调用不再挂起。
     */
    var analyzeGate: CompletableDeferred<Unit>? = null
    // ---- 追问对话（chat）接线断言用 ----
    var chatCalls = 0
    var lastChatConversationId: String? = null
    var lastChatDocumentId: String? = null
    var lastChatQuestion: String? = null
    var lastChatHistory: List<ChatTurn>? = null
    var lastChatInput: SentenceInput? = null
    var lastChatCore: CoreAnalysis? = null
    /** chat 返回前依次推送的「截至目前完整回答」分片。 */
    var chatPushes: List<String> = emptyList()
    var chatAnswer = ""
    /** 测试注入：chat 直接抛异常（模拟请求失败 / 取消）。 */
    var chatError: Throwable? = null
    // ---- 纠正反馈（feedback）接线断言用 ----
    var feedbackCalls = 0
    var lastFeedbackDocumentId: String? = null
    var lastFeedbackSentenceId: String? = null
    var lastFeedbackText: String? = null
    var lastFeedbackInput: SentenceInput? = null
    var lastFeedbackCore: CoreAnalysis? = null
    /** 测试注入：analyzeWithFeedback 返回的纠正结果（null 时返回默认单成分结果）。 */
    var feedbackResult: CoreAnalysis? = null
    /** 测试注入：analyzeWithFeedback 直接抛异常（模拟两轮仍非法 / 网络 / 取消）。 */
    var feedbackError: Throwable? = null

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
      analyzeGate?.let { gate ->
        analyzeGate = null
        gate.await()
      }
      if (throwOnAnalyzeCore) throw IllegalStateException("model crash")
      analyzeCoreThrowable?.let { throw it }
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
      detailError?.let { throw it }
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

    override suspend fun lookupDetail(sentence: SentenceInput, focus: TokenRange): DetailAnalysis? =
      detailLookupResults[sentence.sentenceId]

    override suspend fun chat(
      profile: ModelProfile,
      documentId: String,
      conversationId: String,
      input: SentenceInput,
      core: CoreAnalysis,
      history: List<dev.codetui.englishsyntax.model.ChatTurn>,
      question: String,
      onStreamedText: dev.codetui.englishsyntax.analysis.StreamedTextSink?,
    ): String {
      chatCalls += 1
      lastChatConversationId = conversationId
      lastChatDocumentId = documentId
      lastChatQuestion = question
      lastChatHistory = history
      lastChatInput = input
      lastChatCore = core
      chatError?.let { throw it }
      onStreamedText?.let { sink -> chatPushes.forEach { sink.onText(it) } }
      return chatAnswer
    }

    override suspend fun cancelDocument(documentId: String) {
      cancelledDocuments += documentId
    }

    override suspend fun analyzeWithFeedback(
      profile: ModelProfile,
      documentId: String,
      input: SentenceInput,
      core: CoreAnalysis,
      feedback: String,
    ): CoreAnalysis {
      feedbackCalls += 1
      lastFeedbackDocumentId = documentId
      lastFeedbackSentenceId = input.sentenceId
      lastFeedbackText = feedback
      lastFeedbackInput = input
      lastFeedbackCore = core
      feedbackError?.let { throw it }
      return feedbackResult ?: CoreAnalysis(
        sentenceId = input.sentenceId,
        components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "纠正后的主语")),
        modelProfileId = "p1",
      )
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
    val error = sender.of("CORE_ERROR").single()
    assertTrue(error["tokensJson"]?.jsonPrimitive?.content?.contains("The") == true)
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

  /**
   * F7：cacheOnly 多批会话。① 终态 SESSION_STATE 必须发**会话累计**计数（此前发本批
   * 计数，多批下 web 的 `ready+failed>=discovered` 永不满足、浮层卡死）；② 未命中句置
   * STALE——不计 failed、不滞留 DISCOVERED/FAILED，registerFresh 对 STALE 放行，配好
   * profile 后的重扫能把它们重新派发（对齐 Chrome skipped 语义：保持原文、无失败样式）。
   */
  @Test
  fun `cache only multi batch settles cumulative counts and leaves misses stale for redispatch`() = runBlocking {
    var currentProfile: ModelProfile? = null
    val mutableManager = PreviewSessionManager(scope, service, { currentProfile })
    val localSender = RecordingSender()
    val session = mutableManager.obtain("pv-cache", localSender) { }
    session.start()
    // 预置缓存命中：只有 s-b1-0 查得到，其余全部 miss。
    service.lookupResults["s-b1-0"] = CoreAnalysis(
      sentenceId = "s-b1-0",
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "cached",
    )
    val blockOne = "The service validates every response. Second sentence here too."
    val blockTwo = "Another english block arrives. It also holds two sentences."
    session.onVisibleBlocks(listOf("b1" to blockOne))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(50)
    session.onVisibleBlocks(listOf("b2" to blockTwo))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(0, service.analyzeCalls, "无 profile 绝不调模型")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
    assertEquals(SentencePhase.STALE, session.sentences["s-b1-1"]?.phase)
    assertEquals(SentencePhase.STALE, session.sentences["s-b2-0"]?.phase)
    assertEquals(SentencePhase.STALE, session.sentences["s-b2-1"]?.phase)
    assertEquals(0, session.counts.failed, "cacheOnly 未命中句不计 failed")

    val states = localSender.of("SESSION_STATE")
    assertTrue(states.isNotEmpty())
    val terminal = states.last()
    assertEquals("cacheOnly", terminal["state"]?.jsonPrimitive?.contentOrNull)
    // 累计口径：4 句已发现、1 句命中——本批计数会是 ready=0/discovered=2（第二批全 miss）。
    assertEquals(1, terminal["ready"]?.jsonPrimitive?.content?.toInt())
    assertEquals(4, terminal["discovered"]?.jsonPrimitive?.content?.toInt())

    // 配好 profile 后重扫：STALE 句重新派发（READY 命中句不动）。
    currentProfile = profile
    session.currentProfile = profile
    session.onVisibleBlocks(listOf("b1" to blockOne))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "重扫应把 STALE 句重新派发")
    assertEquals(listOf("s-b1-1"), service.lastSentences.map { it.sentenceId })
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
  fun `parse explicit block replays the stored result instead of going silent`() = runBlocking {
    // 用户 bug：「同一段已经按快捷键翻译好，再按一次就一直显示在翻译状态。」
    // 页面在按下的那一刻就打上「解析中」竖条 + 「正在解析 1 段…」浮层，撤掉它的**唯一**信号
    // 是该块的 CORE_RESULT / CORE_ERROR。所以 registerFresh 一句都不返回（整段已 READY）时
    // 绝不能静默 return——那就是永久「解析中」的成因。改成把已存结果原样重发一遍：
    // 既撤掉标记，又顺手把 JS 渲染器的句子映射补回来（重发走的是与首次完全相同的 applyOutcome）。
    val session = session()
    val text = "The service validates every response carefully today."
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
    session.parseExplicitBlock("b1", text)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
    assertEquals(1, sender.of("CORE_RESULT").size)

    session.parseExplicitBlock("b1", text)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "已解析的段落不得再调一次模型")
    val results = sender.of("CORE_RESULT")
    assertEquals(2, results.size, "必须重发已存结果，否则页面永远停在「解析中」")
    assertEquals("s-b1-0", results.last()["sentenceId"]?.jsonPrimitive?.contentOrNull)
    assertEquals("b1", results.last()["blockId"]?.jsonPrimitive?.contentOrNull)
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

  // ---- 追问对话（CHAT_ASK）：接线 + 取消闭环 ----

  /** 注册一个块并置为 READY（带已核实 core），返回该句输入。 */
  private fun seedReadySentence(session: PreviewSession): SentenceInput {
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    session.applyOutcome(
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
    return first
  }

  @Test
  fun `chat ask streams progress then settles as result for a verified sentence`() = runBlocking {
    val session = session()
    session.start()
    val first = seedReadySentence(session)
    val core = session.sentences[first.sentenceId]!!.core!!
    service.chatPushes = listOf("回答的第", "一部分")
    service.chatAnswer = "完整回答"

    session.launchChatAsk(
      "pv1:chat:1", first.sentenceId,
      listOf(ChatTurn("user", "上一轮问题")), "这个短语修饰谁?",
    )
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.chatCalls)
    assertEquals("pv1-doc", service.lastChatDocumentId, "chat 必须走页面 documentId（服务内部再派生 :chat 命名空间）")
    assertEquals("pv1:chat:1", service.lastChatConversationId)
    assertEquals("这个短语修饰谁?", service.lastChatQuestion)
    assertEquals(listOf(ChatTurn("user", "上一轮问题")), service.lastChatHistory)
    assertEquals(first.sentenceId, service.lastChatInput?.sentenceId)
    assertSame(core, service.lastChatCore, "上下文必须是 Kotlin 侧 SentenceRecord 里已核实的 core")

    // 流式分片：每次都是「截至目前完整回答」，带 generation 与 conversationId。
    val streams = sender.of("CHAT_STREAM")
    assertEquals(listOf("回答的第", "一部分"), streams.map { it["text"]?.jsonPrimitive?.contentOrNull })
    assertEquals(listOf("pv1:chat:1", "pv1:chat:1"), streams.map { it["conversationId"]?.jsonPrimitive?.contentOrNull })
    streams.forEach { assertEquals(session.generation, it["generation"]?.jsonPrimitive?.content?.toInt()) }

    val result = sender.of("CHAT_RESULT").single()
    assertEquals("完整回答", result["answer"]?.jsonPrimitive?.contentOrNull)
    assertEquals("pv1:chat:1", result["conversationId"]?.jsonPrimitive?.contentOrNull)

    // 回环钉形状：发出的 JSON 必须能被 BridgeProtocol.parseHostMessage 收下
    //（白名单与 Task 4 的 JS 侧 parseHostMessage 同构，漏信封字段会被对端静默丢弃）。
    (streams + result).forEach { assertNotNull(BridgeProtocol.parseHostMessage(it), "CHAT_* 消息未过 host 白名单: $it") }
  }

  @Test
  fun `chat ask without a record or verified core answers chat error, not silence`() = runBlocking {
    val session = session()
    session.start()

    // ① 记录不存在（stop/onGenerationChanged 清空后的常态）。
    session.launchChatAsk("c-missing", "s-b1-0", emptyList(), "问?")
    // ② 记录在、core 还没核实（phase != READY）。
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    session.launchChatAsk("c-nocore", first.sentenceId, emptyList(), "问?")
    kotlinx.coroutines.delay(100)

    assertEquals(0, service.chatCalls, "数据不可用绝不调模型")
    val errors = sender.of("CHAT_ERROR")
    assertEquals(
      listOf("原句已失效：请重新解析后再提问", "原句已失效：请重新解析后再提问"),
      errors.map { it["message"]?.jsonPrimitive?.contentOrNull },
    )
    assertEquals(
      listOf("c-missing", "c-nocore"),
      errors.map { it["conversationId"]?.jsonPrimitive?.contentOrNull },
      "错误必须回带到发起会话的 conversationId，否则面板撤销不了悬空的 user 轮",
    )
  }

  @Test
  fun `chat ask after stop still answers invalid sentence instead of going silent`() = runBlocking {
    // 「无 SessionState 静默门」的钉子：面板在 stop/RESTORE_ALL 后仍然开着，照抄
    // launchDetailRequest 的 `if state == STOPPED return` 会把输入框永久卡在禁用态。
    val session = session()
    session.start()
    val first = seedReadySentence(session)
    session.stop()
    kotlinx.coroutines.delay(50)

    session.launchChatAsk("c-after-stop", first.sentenceId, emptyList(), "问?")
    kotlinx.coroutines.delay(100)

    assertEquals(0, service.chatCalls)
    assertEquals(
      "原句已失效：请重新解析后再提问",
      sender.of("CHAT_ERROR").single()["message"]?.jsonPrimitive?.contentOrNull,
    )
  }

  @Test
  fun `chat ask without a profile answers a configuration error`() = runBlocking {
    val noProfileManager = PreviewSessionManager(scope, service, { null })
    val localSender = RecordingSender()
    val session = noProfileManager.obtain("pv-np", localSender) { }
    session.start()
    val first = seedReadySentence(session)

    session.launchChatAsk("c-np", first.sentenceId, emptyList(), "问?")
    kotlinx.coroutines.delay(100)

    assertEquals(0, service.chatCalls)
    assertEquals(
      "尚未配置可用的模型档案，请先在设置中配置",
      localSender.of("CHAT_ERROR").single()["message"]?.jsonPrimitive?.contentOrNull,
    )
  }

  @Test
  fun `chat ask failure surfaces the error code in a readable chat error`() = runBlocking {
    val session = session()
    session.start()
    val first = seedReadySentence(session)

    // ExtensionFailure：复用既有 ErrorCode 做前缀，message 已在服务边界脱敏（不重复脱敏）。
    service.chatError = ExtensionFailure(ErrorCode.REQUEST_TIMEOUT, "Model request timed out", true)
    session.launchChatAsk("c-timeout", first.sentenceId, emptyList(), "问?")
    kotlinx.coroutines.delay(100)
    // 未知异常：兜底 NETWORK_ERROR 前缀 + 原始 message。（先等第一次 launch 读完 chatError
    // 再切换——两次 launch 都在 Default 调度器上异步跑。）
    service.chatError = IllegalStateException("boom")
    session.launchChatAsk("c-crash", first.sentenceId, emptyList(), "问?")
    kotlinx.coroutines.delay(100)

    val errors = sender.of("CHAT_ERROR")
    assertEquals(
      listOf("REQUEST_TIMEOUT：Model request timed out", "NETWORK_ERROR：boom"),
      errors.map { it["message"]?.jsonPrimitive?.contentOrNull },
    )
    errors.forEach { assertNotNull(BridgeProtocol.parseHostMessage(it)) }
  }

  @Test
  fun `stop and generation change cancel the chat namespace`() = runBlocking {
    val session = session()
    session.start()
    session.stop()
    kotlinx.coroutines.delay(50)
    assertTrue("pv1-doc:chat" in service.cancelledDocuments, "stop 必须取消 \${documentId}:chat（否则在飞流式回答占槽到静默超时）")

    session.start()
    session.onGenerationChanged(1)
    kotlinx.coroutines.delay(50)
    assertEquals(
      2,
      service.cancelledDocuments.count { it == "pv1-doc:chat" },
      "stop 与 onGenerationChanged 各取消一次 chat 命名空间",
    )
  }

  @Test
  fun `dispose preview cancels the chat namespace before cancelling the session job`() = runBlocking {
    // 经 manager 长命 scope 取消 chat（session scope 的 launch 会与紧随的 job.cancel 竞速
    // 静默 no-op）；顺序必须是「先 chat 取消、后 session job 取消」。
    val events = mutableListOf<String>()
    val port = object : AnalysisServicePort by service {
      override suspend fun cancelDocument(documentId: String) {
        events += "cancel:$documentId"
      }
    }
    val unconfined = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    try {
      val disposalManager = PreviewSessionManager(unconfined, port, { profile })
      disposalManager.start("pv-d", sender) { }
      val job = disposalManager.sessionJobForTest("pv-d") ?: error("no session job")
      job.invokeOnCompletion { events += "job-cancelled" }

      disposalManager.disposePreview("pv-d")

      assertEquals(listOf("cancel:pv-d-doc:chat", "job-cancelled"), events)
      assertEquals(null, disposalManager.session("pv-d"))
    } finally {
      unconfined.cancel()
    }
  }

  // ---- 纠正反馈（FEEDBACK_REQUEST → launchFeedback → FEEDBACK_ERROR / CORE_RESULT）----

  @Test
  fun `feedback updates the record through apply outcome and sends core result`() = runBlocking {
    val session = session()
    session.start()
    val first = seedReadySentence(session)
    val seededCore = session.sentences[first.sentenceId]!!.core!!
    val corrected = CoreAnalysis(
      sentenceId = first.sentenceId,
      components = listOf(CoreComponent(0, 5, GrammarRole.SUBJECT, "纠正后的整句划分")),
      modelProfileId = "p1",
    )
    service.feedbackResult = corrected

    session.launchFeedback(first.sentenceId, "这个 of 短语应该是定语")
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.feedbackCalls)
    assertEquals("pv1-doc", service.lastFeedbackDocumentId, "纠正走页面 documentId（Chrome correction 同款，无独立命名空间）")
    assertEquals(first.sentenceId, service.lastFeedbackSentenceId)
    assertEquals("这个 of 短语应该是定语", service.lastFeedbackText)
    assertSame(seededCore, service.lastFeedbackCore, "纠正上下文必须是 Kotlin 侧 SentenceRecord 里已核实的 core")

    // 成功必须经 applyOutcome 落账：record.core 更新 + READY 相位 + SESSION_STATE。
    val record = session.sentences[first.sentenceId]!!
    assertEquals(SentencePhase.READY, record.phase)
    assertSame(corrected, record.core, "手发结果不经 applyOutcome 会让后续 detail/chat 对着过期成分讲")

    // 成功复用既有 CORE_RESULT 路径（blockId=句所在块）；seedReadySentence 已发过一条，这里是第二条。
    val results = sender.of("CORE_RESULT")
    assertEquals(2, results.size)
    assertEquals(first.sentenceId, results.last()["sentenceId"]?.jsonPrimitive?.contentOrNull)
    assertEquals("b1", results.last()["blockId"]?.jsonPrimitive?.contentOrNull)
    assertTrue(
      (results.last()["analysisJson"]?.jsonPrimitive?.contentOrNull ?: "").contains("纠正后的整句划分"),
    )
    assertTrue(sender.of("FEEDBACK_ERROR").isEmpty())
    assertTrue(sender.of("CORE_ERROR").isEmpty())
    assertNotNull(BridgeProtocol.parseHostMessage(results.last()), "CORE_RESULT 必须能过 host 白名单回环")
    assertTrue(sender.of("SESSION_STATE").isNotEmpty(), "applyOutcome 落账后回推 SESSION_STATE")
  }

  @Test
  fun `feedback without a record or verified core answers feedback error, not silence`() = runBlocking {
    val session = session()
    session.start()

    // ① 记录不存在（stop/onGenerationChanged 清空后的常态）。
    session.launchFeedback("s-missing", "反馈")
    // ② 记录在、core 还没核实（phase != READY）。
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    val first = session.sentences.values.firstOrNull()?.input ?: error("no sentence")
    session.launchFeedback(first.sentenceId, "反馈")
    kotlinx.coroutines.delay(100)

    assertEquals(0, service.feedbackCalls, "原句失效绝不调模型")
    val errors = sender.of("FEEDBACK_ERROR")
    assertEquals(2, errors.size)
    assertEquals(
      listOf("s-missing", first.sentenceId),
      errors.map { it["sentenceId"]?.jsonPrimitive?.contentOrNull },
      "错误必须按 sentenceId 关联（与 CHAT_ERROR 的 conversationId 把关平行）",
    )
    errors.forEach { error ->
      assertEquals("原句已失效：请重新解析后再纠正", error["message"]?.jsonPrimitive?.contentOrNull)
      assertNotNull(BridgeProtocol.parseHostMessage(error), "FEEDBACK_ERROR 未过 host 白名单: $error")
    }
  }

  /**
   * 失败绝不走 CORE_ERROR（那会把句卡片打成失败行、抹掉已核实的划分——Chrome 的纠正失败
   * 也不动卡片）：错误回内联输入行（FEEDBACK_ERROR），message 按 F1 口径带真实错误码前缀。
   */
  @Test
  fun `feedback failure answers feedback error and keeps the verified card intact`() = runBlocking {
    val session = session()
    session.start()
    val first = seedReadySentence(session)
    val seededCore = session.sentences[first.sentenceId]!!.core!!
    // 服务边界（invalidOutput）已脱敏的真实校验 summary：会话层只加错误码前缀，不重复脱敏。
    service.feedbackError = ExtensionFailure(
      ErrorCode.INVALID_MODEL_OUTPUT,
      "Model output remained invalid after two repairs: sentences[0].components: coverage is incomplete",
      false,
    )

    session.launchFeedback(first.sentenceId, "反馈")
    kotlinx.coroutines.delay(100)

    assertTrue(sender.of("CORE_ERROR").isEmpty(), "纠正失败不得发 CORE_ERROR（会摧毁合法卡片）")
    val error = sender.of("FEEDBACK_ERROR").single()
    assertEquals(first.sentenceId, error["sentenceId"]?.jsonPrimitive?.contentOrNull)
    assertEquals(
      "INVALID_MODEL_OUTPUT：Model output remained invalid after two repairs: sentences[0].components: coverage is incomplete",
      error["message"]?.jsonPrimitive?.contentOrNull,
    )
    // 卡片不动：record.core 保持已核实划分、相位仍 READY。
    assertSame(seededCore, session.sentences[first.sentenceId]!!.core)
    assertEquals(SentencePhase.READY, session.sentences[first.sentenceId]!!.phase)
    assertNotNull(BridgeProtocol.parseHostMessage(error))
  }

  @Test
  fun `feedback without a profile answers a configuration error`() = runBlocking {
    val noProfileManager = PreviewSessionManager(scope, service, { null })
    val localSender = RecordingSender()
    val session = noProfileManager.obtain("pv-np-fb", localSender) { }
    session.start()
    val first = seedReadySentence(session)

    session.launchFeedback(first.sentenceId, "反馈")
    kotlinx.coroutines.delay(100)

    assertEquals(0, service.feedbackCalls)
    assertEquals(
      "尚未配置可用的模型档案，请先在设置中配置",
      localSender.of("FEEDBACK_ERROR").single()["message"]?.jsonPrimitive?.contentOrNull,
    )
  }

  // ---- F3 重新解析全部段落（绕缓存）：reanalyzeAll ----

  /** 「缓存命中 start」开局：首轮结果直接落账（cacheHit=true），句 READY。 */
  private fun seedCacheHitStart(session: PreviewSession, blocks: List<Pair<String, String>>) {
    service.outcome = CoreBatchOutcome(
      listOf(
        CoreAnalysis(
          sentenceId = "s-b1-0",
          components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
          modelProfileId = "p1",
        ),
      ),
      emptyList(),
      cacheHit = true,
    )
    session.start()
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
  }

  /**
   * ① 缓存命中 start 后 reanalyzeAll：失效句必须绕过缓存重新派发（模型再次被调——
   * 否则 registerFresh 的 READY 门 + 缓存短路会让「重析」变成空操作）且结果重画。
   */
  @Test
  fun `reanalyze all after a cache hit start bypasses the cache and re-renders sentences`() = runBlocking {
    val session = session()
    val blocks = listOf("b1" to "The service validates every response carefully today.")
    seedCacheHitStart(session, blocks)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
    assertEquals(1, sender.of("CORE_RESULT").size)
    val generationBefore = session.generation

    session.reanalyzeAll()

    // 同 generation 重驱扫描（不新增 Kotlin→JS 消息；指纹重置由 initialize 自己做）。
    assertEquals(2, scanRequests, "reanalyzeAll 必须经 requestScan 重驱页面重扫")
    assertEquals(generationBefore, session.generation, "重析不换代")
    assertEquals(SentencePhase.STALE, session.sentences["s-b1-0"]?.phase)
    assertNull(session.sentences["s-b1-0"]?.core, "旧 core 必须清空，防 detail/chat 继续引用过期成分")

    // 页面重报同一批块（initialize 重置指纹 → VISIBLE_BLOCKS 重新上报 → 竖条重闪）。
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(2, service.analyzeCalls, "失效句必须重新派发模型请求（不再被 READY 门挡住）")
    assertEquals(true, service.lastBypassCache, "重析轮必须绕过缓存")
    assertEquals(2, sender.of("CORE_RESULT").size, "新结果必须重画（第二条 CORE_RESULT）")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
  }

  /** ② 非 RUNNING（STOPPED/PAUSED）一律静默拒：不重驱扫描、不取消、不失效。 */
  @Test
  fun `reanalyze all is rejected unless the session is running`() = runBlocking {
    // 从未 start（STOPPED）。
    val stopped = manager.obtain("pv-stopped", sender) { scanRequests += 1 }
    stopped.reanalyzeAll()
    assertEquals(0, scanRequests)
    kotlinx.coroutines.delay(50)
    assertTrue(service.cancelledDocuments.isEmpty(), "STOPPED 拒绝不触发取消")

    // start 后 stop（STOPPED；对齐 Chrome stopped 拒）。
    val stoppedAfterRun = manager.obtain("pv-stopped2", sender) { scanRequests += 1 }
    stoppedAfterRun.start()
    stoppedAfterRun.stop()
    kotlinx.coroutines.delay(50)
    service.cancelledDocuments.clear()
    stoppedAfterRun.reanalyzeAll()
    assertEquals(1, scanRequests, "只有 start 那一次扫描，reanalyzeAll 不得再触发")
    assertTrue(service.cancelledDocuments.isEmpty())

    // PAUSED 同样非 RUNNING，拒。
    val paused = manager.obtain("pv-paused", sender) { scanRequests += 1 }
    paused.start()
    paused.pause()
    paused.reanalyzeAll()
    assertEquals(2, scanRequests, "PAUSED 的 reanalyzeAll 不得触发第三次扫描")
    assertEquals(SessionState.PAUSED, paused.state, "被拒的 reanalyzeAll 不得改会话状态")
  }

  /**
   * ③ bypass 标志一次性：重析轮绕缓存落账后，下一次普通重扫（失败句重派）不得再绕缓存。
   */
  @Test
  fun `bypass flag is one-shot so the next ordinary rescan does not bypass the cache`() = runBlocking {
    val session = session()
    val blocks = listOf("b1" to "The service validates every response. Second sentence here too.")
    // 首轮两句全成（bypass 与否无所谓，先造出可失效的 READY 记录）。
    service.outcome = CoreBatchOutcome(
      listOf(
        CoreAnalysis(sentenceId = "s-b1-0", components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")), modelProfileId = "p1"),
        CoreAnalysis(sentenceId = "s-b1-1", components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "第二句")), modelProfileId = "p1"),
      ),
      emptyList(),
      cacheHit = false,
    )
    session.start()
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)

    // 重析轮：一成一败——失败句是后续普通重扫的天然重派入口。
    session.reanalyzeAll()
    service.outcome = CoreBatchOutcome(
      listOf(
        CoreAnalysis(sentenceId = "s-b1-0", components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")), modelProfileId = "p1"),
      ),
      listOf(
        AnalysisFailure("s-b1-1", ExtensionFailure(ErrorCode.INVALID_MODEL_OUTPUT, "invalid", false)),
      ),
      cacheHit = false,
    )
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(2, service.analyzeCalls)
    assertEquals(true, service.lastBypassCache, "重析轮必须绕缓存")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-1"]?.phase)

    // 普通重扫：RUNNING 中再点「开始」→ requestScan → 重报 VISIBLE_BLOCKS，失败句重派。
    session.start()
    assertEquals(3, scanRequests)
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(3, service.analyzeCalls)
    assertEquals(listOf("s-b1-1"), service.lastSentences.map { it.sentenceId }, "普通重扫只重派失败句")
    assertEquals(false, service.lastBypassCache, "bypass 标志一次性：重析后的普通重扫不得再绕缓存")
  }

  /**
   * ④ 在飞批竞速（评审 B4 钉死的顺序）：reanalyzeAll **先**升版本 + 取消在飞，
   * 旧 outcome 必须被版本守卫丢弃——applyOutcome 自身无守卫，若不先掐掉，旧批会把
   * 已失效句标回 READY，而重扫的 registerFresh 对 READY 不放行 → 静默漏译。
   */
  @Test
  fun `reanalyze all kills in-flight batches and the stale outcome cannot mark invalidated sentences ready`() = runBlocking {
    val session = session()
    val blocks = listOf("b1" to "The service validates every response carefully today.")
    seedCacheHitStart(session, blocks)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)

    // 第二批在飞：analyzeCore 挂起在一次性门上。
    val gate = CompletableDeferred<Unit>()
    service.analyzeGate = gate
    session.reanalyzeAll()
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(SentencePhase.QUEUED, session.sentences["s-b1-0"]?.phase, "一批应在飞（挂起在 analyzeCore 内）")
    assertEquals(2, service.analyzeCalls)

    // 此刻再触发一次 reanalyzeAll：掐掉在飞批（升版本 + cancelDocument，镜像 stop 但不发 RESTORE_ALL）。
    val sessionStatesBeforeDrop = sender.of("SESSION_STATE").size
    session.reanalyzeAll()
    kotlinx.coroutines.delay(50)
    assertTrue("pv1-doc" in service.cancelledDocuments, "reanalyzeAll 必须取消在飞批（镜像 stop 的取消）")
    assertEquals(SessionState.RUNNING, session.state, "重析不改会话状态")
    assertEquals(0, sender.of("RESTORE_ALL").size, "重析不发 RESTORE_ALL")
    assertEquals(SentencePhase.STALE, session.sentences["s-b1-0"]?.phase)

    // 旧批此刻返回：必须被版本守卫丢弃。
    gate.complete(Unit)
    kotlinx.coroutines.delay(100)
    assertEquals(
      SentencePhase.STALE,
      session.sentences["s-b1-0"]?.phase,
      "旧 outcome 不得把已失效句标回 READY（否则重扫跳过它们 → 静默漏译）",
    )
    assertEquals(1, sender.of("CORE_RESULT").size, "旧 outcome 不得重画（只有首轮那一条 CORE_RESULT）")
    assertEquals(
      sessionStatesBeforeDrop,
      sender.of("SESSION_STATE").size,
      "applyOutcome 未被调用（SESSION_STATE 只随它发出）",
    )

    // 重扫回来后正常走绕缓存路径并落账。
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(3, service.analyzeCalls)
    assertEquals(true, service.lastBypassCache)
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
  }

  /** ⑤ 停止/换代守卫照常：重析后 stop 丢弃迟到上报；换代清记录且不继承 bypass 标志。 */
  @Test
  fun `stop and generation guards still apply after reanalyze all`() = runBlocking {
    // ① 重析后立即 stop：RESTORE_ALL 照发、记录清空；迟到的重扫上报被 STOPPED 门丢弃。
    val session = session()
    val blocks = listOf("b1" to "The service validates every response carefully today.")
    seedCacheHitStart(session, blocks)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)

    session.reanalyzeAll()
    session.stop()
    kotlinx.coroutines.delay(50)
    assertEquals(SessionState.STOPPED, session.state)
    assertEquals(1, sender.of("RESTORE_ALL").size)
    assertEquals(0, session.counts.discovered)
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls, "stop 后迟到的重扫上报不得派发")

    // ② 重析后换代：记录清空、在飞再取消一次；换代后的新扫描不继承 bypass 标志。
    val session2 = manager.obtain("pv-gen", sender) { }
    session2.start()
    session2.onVisibleBlocks(blocks)
    session2.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(2, service.analyzeCalls)

    session2.reanalyzeAll()
    session2.onGenerationChanged(1)
    kotlinx.coroutines.delay(50)
    assertEquals(0, session2.counts.discovered)
    assertTrue(
      service.cancelledDocuments.count { it == "pv-gen-doc" } >= 2,
      "reanalyzeAll 与换代各取消一次在飞批",
    )
    session2.onVisibleBlocks(blocks)
    session2.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(3, service.analyzeCalls, "换代后的新代次扫描照常派发")
    assertEquals(false, service.lastBypassCache, "重析操作已被换代取代，新代次首轮不得继承 bypass 标志")
  }

  // ---- F6 AUTH_FAILED 暂停 + 缓存兜底 ----

  /** F6 共用：挂真实暂停表的 manager/session/sender（凭据指纹可变，供解除路径断言）。 */
  private fun sessionWithPauseRegistry(
    previewId: String,
    fingerprintProvider: () -> String?,
  ): Triple<PreviewSession, ProfilePauseRegistry, RecordingSender> {
    val registry = ProfilePauseRegistry({ fingerprintProvider() })
    val pausedManager = PreviewSessionManager(scope, service, { profile }, pauseRegistry = registry)
    val localSender = RecordingSender()
    val session = pausedManager.obtain(previewId, localSender) { }
    return Triple(session, registry, localSender)
  }

  /**
   * ① 首批 AUTH_FAILED：结果上报暂停表；第二批**不再发模型请求**（analyzeCalls 探针），
   * 命中缓存句照常产出 CORE_RESULT（缓存键与模型无关，换/修模型前译文不消失），
   * 未命中句标 AUTH_FAILED 失败（对齐 Chrome cacheWithAuthError）。
   */
  @Test
  fun `auth failed outcome pauses the profile and the next batch serves cache without model requests`() = runBlocking {
    val (session, registry, localSender) = sessionWithPauseRegistry("pv-auth") { "fp-1" }
    session.start()

    // 首批：两句全部鉴权失败。
    service.authFailure = true
    session.onVisibleBlocks(listOf("b1" to "The service validates every response. Second sentence here too."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertTrue(registry.isPaused("p1"), "首批 AUTH_FAILED 结果必须上报暂停表")

    // 第二批：命中缓存句照常 CORE_RESULT，miss 句 AUTH_FAILED，且绝不发模型请求。
    service.authFailure = false
    service.lookupResults["s-b2-0"] = CoreAnalysis(
      sentenceId = "s-b2-0",
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "另一个块的主语")),
      modelProfileId = "cached",
    )
    session.onVisibleBlocks(listOf("b2" to "Another english block arrives. It also holds two sentences."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "暂停期间后续批次不得再发模型请求")
    assertEquals(SentencePhase.READY, session.sentences["s-b2-0"]?.phase, "缓存命中句照常落账")
    assertEquals(SentencePhase.FAILED, session.sentences["s-b2-1"]?.phase, "未命中句标失败")
    assertEquals(1, localSender.of("CORE_RESULT").count { it["sentenceId"]?.jsonPrimitive?.contentOrNull == "s-b2-0" })
    val error = localSender.of("CORE_ERROR").single { it["sentenceId"]?.jsonPrimitive?.contentOrNull == "s-b2-1" }
    assertEquals("AUTH_FAILED", error["code"]?.jsonPrimitive?.contentOrNull, "未命中句必须带 AUTH_FAILED 错误码")
    assertNotNull(BridgeProtocol.parseHostMessage(error), "CORE_ERROR 必须能过 host 白名单回环")
  }

  /** ①-补充：用户重试同受暂停门管——回落缓存，不再发模型请求。 */
  @Test
  fun `retry during pause falls back to cache instead of hitting the model`() = runBlocking {
    val (session, registry, _) = sessionWithPauseRegistry("pv-auth-retry") { "fp-1" }
    session.start()
    service.authFailure = true
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertTrue(registry.isPaused("p1"))
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase)

    // 失败句用户重试：暂停优先于 bypass——查缓存命中则落账，绝不重发模型请求。
    service.authFailure = false
    service.lookupResults["s-b1-0"] = CoreAnalysis(
      sentenceId = "s-b1-0",
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "cached",
    )
    session.retrySentence("s-b1-0")
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "暂停期间重试不得发模型请求（暂停优先于绕缓存）")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
  }

  /**
   * ①-补充：未暂停时重试遇 AUTH_FAILED outcome → 同样上报暂停表（与批 dispatch 的
   * 记账对称）。持久场景：暂停被凭据变更解除 → 新凭据仍是坏的 → 全部块已处终态
   * （无新批可记账），只剩用户反复重试同一句——每次重试都要把 profile 重新挂起，
   * 后续重试不再对死凭据白发模型请求。
   */
  @Test
  fun `retry auth failure outcome records the pause so later retries stop hitting the model`() = runBlocking {
    val (session, registry, _) = sessionWithPauseRegistry("pv-auth-retry-rec") { "fp-1" }
    session.start()

    // 首批 NETWORK_ERROR（非 AUTH）：句落 FAILED，但 profile 不进暂停表。
    service.outcome = CoreBatchOutcome(
      emptyList(),
      listOf(AnalysisFailure("s-b1-0", ExtensionFailure(ErrorCode.NETWORK_ERROR, "net", true))),
      cacheHit = false,
    )
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase)
    assertFalse(registry.isPaused("p1"), "非 AUTH 失败不得记账")

    // 未暂停时的用户重试：outcome 携带 AUTH_FAILED → dispatchRetry 必须记账。
    service.authFailure = true
    session.retrySentence("s-b1-0")
    kotlinx.coroutines.delay(100)
    assertEquals(2, service.analyzeCalls, "未暂停时重试照发模型请求")
    assertTrue(registry.isPaused("p1"), "重试结果的 AUTH_FAILED 必须上报暂停表")
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase)

    // 记账生效：再次重试同一句走暂停门回落缓存，不再发模型请求。
    service.authFailure = false
    service.lookupResults["s-b1-0"] = CoreAnalysis(
      sentenceId = "s-b1-0",
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "cached",
    )
    session.retrySentence("s-b1-0")
    kotlinx.coroutines.delay(100)

    assertEquals(2, service.analyzeCalls, "记账后的重试不得再发模型请求")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase, "缓存命中句照常落账")
  }

  // ---- 终审 F-1：dispatchRetry 异常兜底 + F6 记账失败隔离 ----

  /**
   * dispatchRetry 的异常兜底。会话入口都是普通 child Job 上的 scope.launch，
   * analyzeCore 抛非取消异常若逸散，会话 Job 被取消——state 仍 RUNNING 而后续派发
   * 全部静默 no-op（会话假死到面板重建）。必须折成 CORE_ERROR(NETWORK_ERROR) 终态。
   */
  @Test
  fun `retry model crash folds to network error and keeps the session dispatching`() = runBlocking {
    val session = session()
    session.start()
    // 首轮失败（INVALID_MODEL_OUTPUT，与兜底码区分开）：句落 FAILED，成为可重试句。
    service.outcome = CoreBatchOutcome(
      emptyList(),
      listOf(AnalysisFailure("s-b1-0", ExtensionFailure(ErrorCode.INVALID_MODEL_OUTPUT, "invalid", false))),
      cacheHit = false,
    )
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase)

    // 重试时模型层直接崩溃（非取消异常）：句要有 NETWORK_ERROR 终态，会话 Job 不得死。
    service.throwOnAnalyzeCore = true
    session.retrySentence("s-b1-0")
    kotlinx.coroutines.delay(100)

    val retryError = sender.of("CORE_ERROR").last { it["sentenceId"]?.jsonPrimitive?.contentOrNull == "s-b1-0" }
    assertEquals("NETWORK_ERROR", retryError["code"]?.jsonPrimitive?.contentOrNull, "重试崩溃必须折成 NETWORK_ERROR 终态")
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase)
    assertTrue(manager.sessionJobForTest("pv1")!!.isActive, "重试的非取消异常不得取消会话 Job（brick 整个会话）")

    // 会话未被 brick 的行为证明：新块照常派发（崩溃的重试也计一次 analyzeCalls）。
    service.throwOnAnalyzeCore = false
    session.onVisibleBlocks(listOf("b2" to "Another english block arrives today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(3, service.analyzeCalls, "崩溃后的会话必须还能派发后续块")
  }

  /**
   * F6 记账的失败隔离（dispatch 路径）。recordAuthFailed 组装凭据指纹要读
   * PasswordSafe——读失败只影响「这次没记上」（下次真实失败还会再记），log 后继续；
   * 逸散则会取消会话 Job，AUTH_FAILED 结果也永远落不了终态。
   */
  @Test
  fun `pause bookkeeping failure during dispatch does not brick the session`() = runBlocking {
    val registry = ProfilePauseRegistry({ error("PasswordStore unavailable") })
    val pausedManager = PreviewSessionManager(scope, service, { profile }, pauseRegistry = registry)
    val localSender = RecordingSender()
    val session = pausedManager.obtain("pv-auth-psafe", localSender) { }
    session.start()

    service.authFailure = true
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase, "记账失败不得吞掉 AUTH_FAILED 结果的落账")
    assertEquals("AUTH_FAILED", localSender.of("CORE_ERROR").single()["code"]?.jsonPrimitive?.contentOrNull)
    assertFalse(registry.isPaused("p1"), "指纹组装失败——暂停确实没记上（下次真实失败还会再记）")
    assertTrue(pausedManager.sessionJobForTest("pv-auth-psafe")!!.isActive, "记账异常不得取消会话 Job")

    // 会话未被 brick 的行为证明：新块照常派发。
    service.authFailure = false
    session.onVisibleBlocks(listOf("b2" to "Another english block arrives today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(2, service.analyzeCalls, "记账崩溃后的会话必须还能派发后续块")
  }

  /**
   * F6 记账失败隔离（dispatchRetry 路径）+ 恢复语义。指纹读失败只丢「这一次」记账：
   * 重试句照常 AUTH_FAILED 落终态；PasswordSafe 恢复后的下一次真实失败把暂停补记上。
   */
  @Test
  fun `retry pause bookkeeping failure is isolated and a later failure records the pause`() = runBlocking {
    var fingerprintCrashes = true
    val registry = ProfilePauseRegistry({ if (fingerprintCrashes) error("PasswordStore unavailable") else "fp-1" })
    val pausedManager = PreviewSessionManager(scope, service, { profile }, pauseRegistry = registry)
    val localSender = RecordingSender()
    val session = pausedManager.obtain("pv-auth-psafe-retry", localSender) { }
    session.start()

    // 首轮 NETWORK_ERROR（非 AUTH、不触发记账）：句 FAILED，成为可重试句。
    service.outcome = CoreBatchOutcome(
      emptyList(),
      listOf(AnalysisFailure("s-b1-0", ExtensionFailure(ErrorCode.NETWORK_ERROR, "net", true))),
      cacheHit = false,
    )
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase)

    // 重试遇 AUTH_FAILED outcome：记账（读指纹）崩掉——句仍要 AUTH_FAILED 落终态。
    service.authFailure = true
    session.retrySentence("s-b1-0")
    kotlinx.coroutines.delay(100)
    assertEquals(2, service.analyzeCalls)
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase, "记账失败不得吞掉重试结果的落账")
    val retryError = localSender.of("CORE_ERROR").last { it["sentenceId"]?.jsonPrimitive?.contentOrNull == "s-b1-0" }
    assertEquals("AUTH_FAILED", retryError["code"]?.jsonPrimitive?.contentOrNull)
    assertFalse(registry.isPaused("p1"), "指纹组装失败——这次没记上")
    assertTrue(pausedManager.sessionJobForTest("pv-auth-psafe-retry")!!.isActive, "记账异常不得取消会话 Job")

    // PasswordSafe 恢复：再次重试仍 AUTH_FAILED → 记账补上，后续重试走暂停门。
    fingerprintCrashes = false
    session.retrySentence("s-b1-0")
    kotlinx.coroutines.delay(100)
    assertEquals(3, service.analyzeCalls)
    assertTrue(registry.isPaused("p1"), "恢复后的真实失败必须照常记账（隔离只丢当次，不丢能力）")
  }

  /** ①-补充：analyzeCore 抛 AUTH_FAILED（而非 failures 携带）同样记账并走缓存兜底。 */
  @Test
  fun `auth failed thrown from analyze core is recorded and falls back to cache`() = runBlocking {
    val (session, registry, localSender) = sessionWithPauseRegistry("pv-auth-throw") { "fp-1" }
    session.start()
    service.analyzeCoreThrowable = ExtensionFailure(ErrorCode.AUTH_FAILED, "auth", false)
    // 两句的块，只种第一句的缓存——第二句走 miss → AUTH_FAILED。
    service.lookupResults["s-b1-0"] = CoreAnalysis(
      sentenceId = "s-b1-0",
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "cached",
    )
    session.onVisibleBlocks(listOf("b1" to "The service validates every response. Second sentence here too."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertTrue(registry.isPaused("p1"), "抛出的 AUTH_FAILED 同样要记账")
    assertEquals(1, localSender.of("CORE_RESULT").size, "兜底仍要回缓存命中句")
    val error = localSender.of("CORE_ERROR").single()
    assertEquals("s-b1-1", error["sentenceId"]?.jsonPrimitive?.contentOrNull)
    assertEquals("AUTH_FAILED", error["code"]?.jsonPrimitive?.contentOrNull, "不得误报成 NETWORK_ERROR")
  }

  /** ② 凭据指纹变化解除：解除后新请求照发模型（对齐 Chrome isProfilePaused 懒解除语义）。 */
  @Test
  fun `credential fingerprint change releases the pause and dispatch reaches the model again`() = runBlocking {
    var fingerprint = "fp-1"
    val (session, registry, _) = sessionWithPauseRegistry("pv-auth-release") { fingerprint }
    session.start()
    service.authFailure = true
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertTrue(registry.isPaused("p1"))

    // 用户改了凭据（保存/setActive 处比较指纹）→ 解除；同一批句子重新派发照发模型。
    fingerprint = "fp-2"
    assertTrue(registry.releaseIfFingerprintChanged("p1"))
    assertFalse(registry.isPaused("p1"))

    service.authFailure = false
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
    session.onVisibleBlocks(listOf("b1" to "The service validates every response carefully today."))
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(2, service.analyzeCalls, "解除后新请求必须照发模型")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase)
  }

  /**
   * ②-F3 交互（终审 Minor 钉子）：F6 暂停门优先于 F3 重析的一次性绕缓存标志。首轮
   * AUTH_FAILED 把 profile 挂起后，用户再点「重新解析」也不能靠 bypass 穿透暂停门重发
   * 模型请求——重析批照走 pausedCoreOutcome：命中缓存句 CORE_RESULT、miss 句
   * AUTH_FAILED。（dispatchRetry 暂停门间接盖过同一路径；这里把显式交互直接钉住。）
   */
  @Test
  fun `reanalyze all while the profile is paused keeps the pause gate over the bypass flag`() = runBlocking {
    val (session, registry, localSender) = sessionWithPauseRegistry("pv-auth-reanalyze") { "fp-1" }
    session.start()

    // 首轮两句全部 AUTH_FAILED：真实记账路径把 profile 挂起，句落 FAILED。
    service.authFailure = true
    val blocks = listOf("b1" to "The service validates every response. Second sentence here too.")
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)
    assertEquals(1, service.analyzeCalls)
    assertTrue(registry.isPaused("p1"))
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-0"]?.phase)

    // 只种第一句缓存：重析批过暂停门时「命中照回 / miss 报 AUTH_FAILED」两侧都可断言。
    service.authFailure = false
    service.lookupResults["s-b1-0"] = CoreAnalysis(
      sentenceId = "s-b1-0",
      components = listOf(CoreComponent(0, 1, GrammarRole.SUBJECT, "该服务")),
      modelProfileId = "cached",
    )

    // F3 重析（会话仍 RUNNING，仅 profile 暂停）：置 bypass 标志、全量失效、重驱扫描。
    session.reanalyzeAll()
    assertEquals(SessionState.RUNNING, session.state)
    assertEquals(SentencePhase.STALE, session.sentences["s-b1-0"]?.phase)
    assertEquals(SentencePhase.STALE, session.sentences["s-b1-1"]?.phase)

    // 页面重报同一批块 → flushBatch 消费 bypass 标志 → dispatch：暂停门压过 bypass。
    session.onVisibleBlocks(blocks)
    session.flushBatch(offscreen = false)
    kotlinx.coroutines.delay(100)

    assertEquals(1, service.analyzeCalls, "暂停门必须压过 bypass 标志——重析批也不得发模型请求")
    assertEquals(SentencePhase.READY, session.sentences["s-b1-0"]?.phase, "命中缓存句照常产出")
    assertEquals(1, localSender.of("CORE_RESULT").count { it["sentenceId"]?.jsonPrimitive?.contentOrNull == "s-b1-0" })
    assertEquals(SentencePhase.FAILED, session.sentences["s-b1-1"]?.phase, "miss 句标 AUTH_FAILED 失败")
    val error = localSender.of("CORE_ERROR").last { it["sentenceId"]?.jsonPrimitive?.contentOrNull == "s-b1-1" }
    assertEquals("AUTH_FAILED", error["code"]?.jsonPrimitive?.contentOrNull)
  }

  /** ④-detail：暂停期详解先查缓存——命中照回 DETAIL_RESULT，未命中回 AUTH_FAILED。 */
  @Test
  fun `paused profile serves detail from cache and reports auth failed on miss`() = runBlocking {
    val (session, registry, localSender) = sessionWithPauseRegistry("pv-auth-detail") { "fp-1" }
    session.start()
    registry.recordAuthFailed("p1")
    val first = seedReadySentence(session)

    // 未命中：CORE_ERROR 带 AUTH_FAILED（不是笼统 DETAIL_FAILED），且绝不发模型请求。
    session.launchDetailRequest(first.sentenceId, 0, 1)
    kotlinx.coroutines.delay(100)
    assertEquals(0, service.detailCalls, "暂停期 detail 未命中不得发模型请求")
    val error = localSender.of("CORE_ERROR").single()
    assertEquals("AUTH_FAILED", error["code"]?.jsonPrimitive?.contentOrNull)
    assertEquals(first.sentenceId, error["sentenceId"]?.jsonPrimitive?.contentOrNull)

    // 命中：照回 DETAIL_RESULT（缓存键与模型无关），同样不发模型请求。
    service.detailLookupResults[first.sentenceId] = DetailAnalysis(
      sentenceId = first.sentenceId,
      focus = TokenRange(0, 1),
      structures = emptyList(),
      grammarPoints = emptyList(),
      explanation = "cached",
      modelProfileId = "cached",
    )
    session.launchDetailRequest(first.sentenceId, 0, 1)
    kotlinx.coroutines.delay(100)
    assertEquals(0, service.detailCalls)
    val result = localSender.of("DETAIL_RESULT").single()
    assertTrue(
      (result["analysisJson"]?.jsonPrimitive?.contentOrNull ?: "").contains("cached"),
      "命中的缓存详解必须照回",
    )
  }

  /** ④-detail-记账：详解请求抛 AUTH_FAILED 时上报暂停表。 */
  @Test
  fun `detail auth failure pauses the profile`() = runBlocking {
    val (session, registry, localSender) = sessionWithPauseRegistry("pv-auth-detail-rec") { "fp-1" }
    session.start()
    val first = seedReadySentence(session)
    assertFalse(registry.isPaused("p1"))

    service.detailError = ExtensionFailure(ErrorCode.AUTH_FAILED, "auth", false)
    session.launchDetailRequest(first.sentenceId, 0, 1)
    kotlinx.coroutines.delay(100)

    assertTrue(registry.isPaused("p1"), "detail 的 AUTH_FAILED 必须上报暂停表")
    assertEquals(
      "AUTH_FAILED",
      localSender.of("CORE_ERROR").single()["code"]?.jsonPrimitive?.contentOrNull,
      "ExtensionFailure 的错误码不得被 DETAIL_FAILED 兜底覆写",
    )
  }

  /** ④-chat：暂停直接 CHAT_ERROR（chat 无缓存兜底语义）；chat 抛 AUTH_FAILED 同样记账。 */
  @Test
  fun `paused profile answers chat error and a chat auth failure pauses the profile`() = runBlocking {
    // ① 已暂停：直接 CHAT_ERROR，绝不发模型请求。
    val (session, registry, localSender) = sessionWithPauseRegistry("pv-auth-chat") { "fp-1" }
    session.start()
    registry.recordAuthFailed("p1")
    val first = seedReadySentence(session)

    session.launchChatAsk("c-paused", first.sentenceId, emptyList(), "问?")
    kotlinx.coroutines.delay(100)
    assertEquals(0, service.chatCalls, "暂停期 chat 不得发模型请求")
    val pausedError = localSender.of("CHAT_ERROR").single()
    assertEquals("模型档案鉴权失败，更新凭据后才会恢复", pausedError["message"]?.jsonPrimitive?.contentOrNull)
    assertNotNull(BridgeProtocol.parseHostMessage(pausedError))

    // ② chat 抛 AUTH_FAILED → 上报暂停表（Chrome CHAT_ASK catch 同款）。
    val (freshSession, freshRegistry, freshSender) = sessionWithPauseRegistry("pv-auth-chat-rec") { "fp-2" }
    freshSession.start()
    val seeded = seedReadySentence(freshSession)
    assertFalse(freshRegistry.isPaused("p1"))

    service.chatError = ExtensionFailure(ErrorCode.AUTH_FAILED, "auth", false)
    freshSession.launchChatAsk("c-auth", seeded.sentenceId, emptyList(), "问?")
    kotlinx.coroutines.delay(100)

    assertTrue(freshRegistry.isPaused("p1"), "chat 的 AUTH_FAILED 必须上报暂停表")
    assertEquals(
      "AUTH_FAILED：auth",
      freshSender.of("CHAT_ERROR").single()["message"]?.jsonPrimitive?.contentOrNull,
    )
  }

  /** ④-feedback：暂停直接 FEEDBACK_ERROR；feedback 抛 AUTH_FAILED 同样记账（暂停的死 key 不得继续收纠正）。 */
  @Test
  fun `paused profile answers feedback error and a feedback auth failure pauses the profile`() = runBlocking {
    // ① 已暂停：直接 FEEDBACK_ERROR，绝不发模型请求。
    val (session, registry, localSender) = sessionWithPauseRegistry("pv-auth-fb") { "fp-1" }
    session.start()
    registry.recordAuthFailed("p1")
    val first = seedReadySentence(session)

    session.launchFeedback(first.sentenceId, "反馈")
    kotlinx.coroutines.delay(100)
    assertEquals(0, service.feedbackCalls, "暂停期纠正不得发模型请求")
    val pausedError = localSender.of("FEEDBACK_ERROR").single()
    assertEquals("模型档案鉴权失败，更新凭据后才会恢复", pausedError["message"]?.jsonPrimitive?.contentOrNull)
    assertEquals(first.sentenceId, pausedError["sentenceId"]?.jsonPrimitive?.contentOrNull)
    assertNotNull(BridgeProtocol.parseHostMessage(pausedError))

    // ② 纠正抛 AUTH_FAILED → 上报暂停表。
    val (freshSession, freshRegistry, freshSender) = sessionWithPauseRegistry("pv-auth-fb-rec") { "fp-2" }
    freshSession.start()
    val seeded = seedReadySentence(freshSession)
    assertFalse(freshRegistry.isPaused("p1"))

    service.feedbackError = ExtensionFailure(ErrorCode.AUTH_FAILED, "auth", false)
    freshSession.launchFeedback(seeded.sentenceId, "反馈")
    kotlinx.coroutines.delay(100)

    assertTrue(freshRegistry.isPaused("p1"), "feedback 的 AUTH_FAILED 必须上报暂停表")
    assertEquals(
      "AUTH_FAILED：auth",
      freshSender.of("FEEDBACK_ERROR").single()["message"]?.jsonPrimitive?.contentOrNull,
    )
  }
}
